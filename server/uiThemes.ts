import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFICIAL_UI_THEME_IDS,
  UI_THEME_LIMITS,
  isOfficialUiThemeId,
  isValidUiThemePackageId,
  normalizeUiThemePreview,
  parseUiThemeManifest,
  uiThemeStarterFiles,
  type UiThemeManifest,
  type UiThemeSource,
  type UiThemeSummary,
} from "../shared/uiThemePackage";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "./dbRuntime";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { SafeOutboundError, safeHttpGet } from "./ssrf";
import {
  UiThemePackageError,
  buildUiThemePackage,
  parseUiThemeArchive,
  writeZip,
  type ParsedUiThemePackage,
} from "./uiThemePackage";

/*
  装在这个面板上的界面主题包：列出、安装（官方主题库 / 上传 / 链接）、卸载、导出，和开机时的自动补装。
  格式和来由见 shared/uiThemePackage.ts，读包和样式检查在 server/uiThemePackage.ts。

  「已安装」名单每个页面开机都要用（publicInfo 带着它，浏览器才知道某个主题 id 认不认、样式地址是什么），
  所以名单放内存里，装 / 卸的时候作废。面板是单实例，不用考虑别的进程改了库。
  样式正文不缓存：地址带着 revision，浏览器按「永不过期」缓存，一套主题每个浏览器只来取一次。
*/

const TABLE = "ui_theme_packages";
const LOCK_KEY = "ui-theme-packages";
const SITE_THEME_SETTING = "personalizationUiTheme";
const q = quoteDbIdentifier;

export class UiThemeError extends Error {
  readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT";
  constructor(message: string, code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" = "BAD_REQUEST") {
    super(message);
    this.code = code;
  }
}

let installedCache: UiThemeSummary[] | null = null;

function invalidateInstalledCache() {
  installedCache = null;
}

/** 库整个换过（导入备份、测试换库）之后要清一下，不然拿到的是上一个库的名单。 */
export function invalidateUiThemeCache() {
  invalidateInstalledCache();
}

type ThemeRow = Record<string, unknown>;

function manifestFromRow(row: ThemeRow): UiThemeManifest | null {
  try {
    return parseUiThemeManifest(JSON.parse(String(row.manifestJson || "")));
  } catch {
    return null;
  }
}

function summaryFromRow(row: ThemeRow): UiThemeSummary | null {
  const manifest = manifestFromRow(row);
  // 清单坏了的行（手改过库、从格式不兼容的备份导进来的）当它不存在：不让一行坏数据拖垮所有页面的开机
  if (!manifest) return null;
  const source = String(row.source || "upload");
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    preview: normalizeUiThemePreview(manifest.preview),
    revision: String(row.revision || ""),
    source: (source === "official" || source === "url" ? source : "upload") as UiThemeSource,
    installedAt: rawEpochToDate(row.installedAt)?.getTime() || 0,
  };
}

/** 已安装的主题，按安装先后。读不到（库还没建好、表不存在）时按「一套都没装」算，页面照样能开。 */
export async function listInstalledUiThemes(): Promise<UiThemeSummary[]> {
  if (installedCache) return installedCache;
  try {
    const rows = await queryRaw(
      `SELECT ${q("themeId")}, ${q("revision")}, ${q("source")}, ${q("manifestJson")}, ${q("installedAt")} FROM ${q(TABLE)} ORDER BY ${q("id")} ASC`,
    );
    const list = rows.map(summaryFromRow).filter((item): item is UiThemeSummary => !!item);
    installedCache = list;
    return list;
  } catch {
    return [];
  }
}

export async function installedUiThemeIds(): Promise<string[]> {
  return (await listInstalledUiThemes()).map((theme) => theme.id);
}

/** 给 /api/ui-themes/<id>.css 用：样式正文和它的 revision。没装返回 null。 */
export async function getInstalledUiThemeCss(themeId: string): Promise<{ css: string; revision: string } | null> {
  if (!isValidUiThemePackageId(themeId)) return null;
  const rows = await queryRaw(`SELECT ${q("css")}, ${q("revision")} FROM ${q(TABLE)} WHERE ${q("themeId")} = ? LIMIT 1`, [themeId]);
  const row = rows[0];
  if (!row || typeof row.css !== "string" || !row.css) return null;
  return { css: row.css, revision: String(row.revision || "") };
}

export type InstallUiThemeResult = { theme: UiThemeSummary; replaced: boolean; previousVersion: string | null };

async function savePackage(
  parsed: ParsedUiThemePackage,
  options: { source: UiThemeSource; sourceUrl?: string | null; replace: boolean },
): Promise<InstallUiThemeResult> {
  return withKeyedTaskLock(LOCK_KEY, async () => {
    const { manifest, css, revision } = parsed;
    const existing = (await queryRaw(`SELECT ${q("id")}, ${q("version")} FROM ${q(TABLE)} WHERE ${q("themeId")} = ? LIMIT 1`, [manifest.id]))[0];
    const now = Math.floor(Date.now() / 1000);
    const manifestJson = JSON.stringify(manifest);
    if (existing) {
      if (!options.replace) {
        throw new UiThemeError(`已经装着同名的主题「${manifest.name}」（${manifest.id}，版本 ${existing.version}）。要换成这一份，请勾上「替换已安装的同名主题」再装`, "CONFLICT");
      }
      await executeRaw(
        `UPDATE ${q(TABLE)} SET ${q("name")} = ?, ${q("version")} = ?, ${q("revision")} = ?, ${q("source")} = ?, ${q("sourceUrl")} = ?, ${q("manifestJson")} = ?, ${q("css")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
        [manifest.name, manifest.version, revision, options.source, options.sourceUrl || null, manifestJson, css, now, existing.id],
      );
    } else {
      const count = Number((await queryRaw(`SELECT COUNT(*) AS ${q("n")} FROM ${q(TABLE)}`))[0]?.n || 0);
      if (count >= UI_THEME_LIMITS.installed) {
        throw new UiThemeError(`最多安装 ${UI_THEME_LIMITS.installed} 套主题，请先卸载用不到的`);
      }
      await insertAndGetId(TABLE, {
        themeId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        revision,
        source: options.source,
        sourceUrl: options.sourceUrl || null,
        manifestJson,
        css,
        installedAt: now,
        updatedAt: now,
      });
    }
    invalidateInstalledCache();
    const theme = (await listInstalledUiThemes()).find((item) => item.id === manifest.id);
    if (!theme) throw new UiThemeError("主题保存后读不回来，请重试");
    return { theme, replaced: !!existing, previousVersion: existing ? String(existing.version || "") : null };
  });
}

function parseArchive(buffer: Buffer): ParsedUiThemePackage {
  try {
    return parseUiThemeArchive(buffer);
  } catch (error) {
    if (error instanceof UiThemePackageError) throw new UiThemeError(error.message);
    throw new UiThemeError("这个主题包读不了，请确认是 ZIP 或 TAR.GZ 压缩包");
  }
}

/** 安装上传的压缩包。 */
export async function installUiThemeFromArchive(buffer: Buffer, options: { replace?: boolean; source?: UiThemeSource; sourceUrl?: string | null } = {}) {
  return savePackage(parseArchive(buffer), { source: options.source || "upload", sourceUrl: options.sourceUrl, replace: options.replace === true });
}

const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_REDIRECTS = 4;
let activeDownloads = 0;

/**
 * 从链接安装：面板去把压缩包下回来。
 * 走 ssrf.ts 的 safeHttpGet —— 不许连内网和本机（管理员填的地址也一样：填错了、或者被人骗着填一个内网地址，
 * 面板不该替他去探内网），连接钉在检查过的地址上，正文超过上限立刻断。跳转自己一跳一跳跟，每一跳都重新检查。
 */
export async function downloadUiThemeArchive(rawUrl: string, fetcher: typeof safeHttpGet = safeHttpGet): Promise<Buffer> {
  let current = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(current)) throw new UiThemeError("请填写 http:// 或 https:// 开头的压缩包直链");
  if (current.length > 2000) throw new UiThemeError("链接太长了");
  if (activeDownloads >= 2) throw new UiThemeError("正在下载别的主题，请稍后再试");
  activeDownloads += 1;
  try {
    for (let hop = 0; hop <= DOWNLOAD_REDIRECTS; hop += 1) {
      let response;
      try {
        response = await fetcher(current, {
          purpose: "主题下载",
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxBytes: UI_THEME_LIMITS.archiveBytes,
          // identity：不让对方再套一层 gzip，不然「正文上限」数的是压缩后的大小
          headers: { Accept: "application/zip, application/gzip, application/octet-stream, */*", "Accept-Encoding": "identity", "User-Agent": "NEX-Theme-Installer/1" },
        });
      } catch (error) {
        if (error instanceof SafeOutboundError) {
          if (error.code === "too-large") throw new UiThemeError(`主题包不能超过 ${Math.round(UI_THEME_LIMITS.archiveBytes / 1024 / 1024)}MB`);
          if (error.code === "timeout") throw new UiThemeError("下载主题包超时，请检查链接，或者下到本地后用「上传压缩包」安装");
          throw new UiThemeError(`下载主题包失败：${error.message}`);
        }
        throw new UiThemeError("下载主题包失败，请检查链接，或者下到本地后用「上传压缩包」安装");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = String(response.headers.location || "");
        if (!location || hop === DOWNLOAD_REDIRECTS) throw new UiThemeError("下载主题包时跳转次数太多，请换成最终的直链");
        try {
          current = new URL(location, current).href;
        } catch {
          throw new UiThemeError("下载主题包时对方给了一个无效的跳转地址");
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new UiThemeError(`下载主题包失败：对方返回 HTTP ${response.status}`);
      const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
      if (encoding !== "identity") throw new UiThemeError("下载主题包失败：对方服务器不肯给原始文件（要求内容编码），请下到本地后用「上传压缩包」安装");
      return response.body;
    }
    throw new UiThemeError("下载主题包失败");
  } finally {
    activeDownloads -= 1;
  }
}

export async function installUiThemeFromUrl(url: string, options: { replace?: boolean } = {}) {
  const archive = await downloadUiThemeArchive(url);
  return installUiThemeFromArchive(archive, { replace: options.replace, source: "url", sourceUrl: String(url).trim().slice(0, 2000) });
}

/* ── 官方主题库：随面板发布的那几套 ─────────────────────────────────── */

function officialDirectories() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.FORWARDX_UI_THEMES_DIR,
    // 打包后这段代码在 dist/index.js 里：主题在 dist/themes/official（esbuild.config.mjs 拷过去）。
    path.join(here, "themes", "official"),
    // 开发 / 测试直接跑源码：仓库根目录的 themes/official。
    path.join(here, "..", "themes", "official"),
    path.resolve(process.cwd(), "dist", "themes", "official"),
    path.resolve(process.cwd(), "themes", "official"),
  ].filter((value): value is string => !!value);
}

function readOfficialFiles(themeId: string): Map<string, Buffer> | null {
  if (!isOfficialUiThemeId(themeId)) return null;
  for (const directory of officialDirectories()) {
    const root = path.join(directory, themeId);
    try {
      if (!fs.statSync(path.join(root, "theme.json")).isFile()) continue;
    } catch {
      continue;
    }
    const files = new Map<string, Buffer>();
    const walk = (relative: string) => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(name);
        else if (entry.isFile()) files.set(name, fs.readFileSync(path.join(root, name)));
      }
    };
    walk("");
    return files;
  }
  return null;
}

const officialPackages = new Map<string, ParsedUiThemePackage | null>();

/** 官方主题库里的一套（读盘、检查一次后留在内存里；这几个文件跟着面板版本走，运行中不会变）。 */
function officialPackage(themeId: string): ParsedUiThemePackage | null {
  if (officialPackages.has(themeId)) return officialPackages.get(themeId) || null;
  let parsed: ParsedUiThemePackage | null = null;
  const files = readOfficialFiles(themeId);
  if (files) {
    try {
      const built = buildUiThemePackage(files);
      // 目录名和清单里的 id 对不上的不认：界面是按目录名（OFFICIAL_UI_THEME_IDS）列出来的
      if (built.manifest.id === themeId) parsed = built;
      else console.warn(`[UiTheme] official theme directory ${themeId} declares id ${built.manifest.id}; skipped`);
    } catch (error) {
      console.warn(`[UiTheme] official theme ${themeId} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  officialPackages.set(themeId, parsed);
  return parsed;
}

export type OfficialUiThemeEntry = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  preview: UiThemeSummary["preview"];
  /** 装着的版本；没装是 null */
  installedVersion: string | null;
  /** 装着的和主题库里现在这份不一样（面板升级后主题库带了新版） */
  updateAvailable: boolean;
};

export async function listOfficialUiThemes(): Promise<OfficialUiThemeEntry[]> {
  const installed = new Map((await listInstalledUiThemes()).map((theme) => [theme.id, theme]));
  const entries: OfficialUiThemeEntry[] = [];
  for (const id of OFFICIAL_UI_THEME_IDS) {
    const parsed = officialPackage(id);
    if (!parsed) continue;
    const current = installed.get(id);
    entries.push({
      id,
      name: parsed.manifest.name,
      version: parsed.manifest.version,
      description: parsed.manifest.description,
      author: parsed.manifest.author,
      preview: parsed.manifest.preview,
      installedVersion: current ? current.version : null,
      // 只提醒「从主题库装的、内容和主题库现在这份不一样」的：自己上传过一份盖掉的，是管理员有意换的，不催
      updateAvailable: !!current && current.source === "official" && current.revision !== parsed.revision,
    });
  }
  return entries;
}

/** 从官方主题库安装（已经装着就更新成主题库里的这一份）。 */
export async function installOfficialUiTheme(themeId: string) {
  const parsed = officialPackage(themeId);
  if (!parsed) throw new UiThemeError("官方主题库里没有这套主题（这个面板的安装包可能不完整）", "NOT_FOUND");
  return savePackage(parsed, { source: "official", replace: true });
}

/**
 * 卸载。站点默认正用着它的话，站点默认回到经典 —— 不然所有人会停在一个没有样式的主题 id 上。
 * 各台设备在顶栏给自己选的那一套不用管：名单里没有它了，浏览器下一次拿到 publicInfo 就自己回到站点默认。
 */
export async function uninstallUiTheme(themeId: string): Promise<{ siteThemeReset: boolean }> {
  return withKeyedTaskLock(LOCK_KEY, async () => {
    const existing = (await queryRaw(`SELECT ${q("id")} FROM ${q(TABLE)} WHERE ${q("themeId")} = ? LIMIT 1`, [String(themeId || "")]))[0];
    if (!existing) {
      // 名单和库对不上（库被备份恢复 / 手改过）：顺手作废名单，下次按库里的重读
      invalidateInstalledCache();
      throw new UiThemeError("这套主题没有安装", "NOT_FOUND");
    }
    const siteTheme = String((await getSetting(SITE_THEME_SETTING)) || "");
    const siteThemeReset = siteTheme === themeId;
    if (siteThemeReset) await setSetting(SITE_THEME_SETTING, "classic");
    await executeRaw(`DELETE FROM ${q(TABLE)} WHERE ${q("id")} = ?`, [existing.id]);
    invalidateInstalledCache();
    return { siteThemeReset };
  });
}

/** 把装着的一套打回压缩包（给别的面板装、或者留个底）。图片和字体已经内联在样式里，包里只有清单和样式。 */
export async function exportUiThemeArchive(themeId: string): Promise<{ filename: string; archive: Buffer } | null> {
  if (!isValidUiThemePackageId(themeId)) return null;
  const row = (await queryRaw(`SELECT ${q("manifestJson")}, ${q("css")} FROM ${q(TABLE)} WHERE ${q("themeId")} = ? LIMIT 1`, [themeId]))[0];
  const manifest = row ? manifestFromRow(row) : null;
  if (!row || !manifest || typeof row.css !== "string") return null;
  const archive = writeZip({
    "theme.json": `${JSON.stringify({ ...manifest, stylesheet: "theme.css" }, null, 2)}\n`,
    "theme.css": row.css,
  });
  return { filename: `nex-theme-${manifest.id}-${manifest.version}.zip`, archive };
}

/** 开发模板：一个能直接装上、看得出效果的最小主题。 */
export function uiThemeStarterArchive(): { filename: string; archive: Buffer } {
  return { filename: "nex-theme-starter.zip", archive: writeZip(uiThemeStarterFiles()) };
}

/**
 * 开机时补装：站点默认主题是官方主题库里的一套、库里却没有它。
 *
 * 两种情况会这样：从 2.3.523 及以前升上来（那时这几套是内置的，库里自然没有）；
 * 或者从备份 / 别的面板带过来的设置指着一套没带过来的主题。主题库是随面板发的，不用外网，补上就行 ——
 * 升级不该让一个用着墨金的站点突然变回经典。
 * 只补站点默认这一套：其余几套谁想用谁在「主题管理」里装，这正是改成按需安装的意思。
 */
export async function ensureSiteUiThemeInstalled(): Promise<string | null> {
  const siteTheme = String((await getSetting(SITE_THEME_SETTING)) || "").trim();
  if (!isOfficialUiThemeId(siteTheme)) return null;
  if ((await installedUiThemeIds()).includes(siteTheme)) return null;
  if (!officialPackage(siteTheme)) {
    console.warn(`[UiTheme] site theme ${siteTheme} is not installed and missing from the bundled library; pages fall back to classic`);
    return null;
  }
  await installOfficialUiTheme(siteTheme);
  console.info(`[UiTheme] installed bundled theme ${siteTheme} because it is the site default`);
  return siteTheme;
}
