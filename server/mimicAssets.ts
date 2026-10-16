import crypto from "crypto";
import fsp from "fs/promises";
import path from "path";
import type { Request, Response, Router } from "express";
import * as db from "./db";
import { APP_VERSION } from "../shared/versions";
import { githubDownloadCandidates } from "../shared/githubAccelerator";
import {
  MIMIC_ASSET_RELAY_PATH,
  MIMIC_INSTALL_SCRIPT_PATH,
  MIMIC_RELEASE_REPO,
  isShellSafeUrl,
  mimicReleaseSha256,
} from "../shared/mimicAssets";
import { resolvePanelUrl } from "./agentPanelUrl";
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { appendPanelLog } from "./_core/panelLogger";
import { MIMIC_TARGET_VERSION, readMimicInstallerScript, withMimicInstallerDefaults } from "./mimicInstallTasks";

/*
  面板替连不上 GitHub 的主机转发 mimic 发布包（2.3.443）。

  国内机上 Agent 跑安装脚本时 GitHub 和几个公共镜像都可能不通（po0 那台 Debian 12 就是：
  手动带代理能装，Agent 装就全军覆没）。面板一般在海外，这里按需从 GitHub 拉一次存到
  data/mimic-assets/v<版本>/，之后谁要都直接给。只认 shared/mimicAssets.ts 钉了哈希的包名，
  下下来的内容哈希不对就不存——面板转发不会比直连 GitHub 更不可信。

  另外 GET /api/agent/mimic-install.sh 给手动安装用：就是面板自带的安装脚本，开头注入了
  面板转发地址，主机上一行 curl … | bash 就能装。
*/

const MAX_MIMIC_ASSET_BYTES = 16 * 1024 * 1024;
const fetchLocks = new Map<string, Promise<string | null>>();
const relayLimiter = new SlidingWindowRateLimiter({ limit: 120, windowMs: 10 * 60 * 1000 });

export function isRelayableMimicAsset(version: string, asset: string) {
  return !!mimicReleaseSha256(version, asset);
}

function mimicAssetCachePath(version: string, asset: string) {
  return path.resolve(process.cwd(), "data", "mimic-assets", `v${version}`, asset);
}

async function sha256File(filePath: string) {
  const data = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function cachedAssetIfValid(version: string, asset: string, expected: string) {
  const cachePath = mimicAssetCachePath(version, asset);
  try {
    if ((await sha256File(cachePath)) === expected) return cachePath;
    await fsp.rm(cachePath, { force: true });
  } catch {
    // 没缓存
  }
  return null;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

async function downloadMimicAsset(version: string, asset: string, expected: string, fetchImpl: FetchLike) {
  const settings = await db.getAllSettings().catch(() => ({} as Record<string, string>));
  const sourceUrl = `https://github.com/${MIMIC_RELEASE_REPO}/releases/download/v${version}/${encodeURIComponent(asset)}`;
  const candidates = githubDownloadCandidates(sourceUrl, {
    enabled: settings.githubAcceleratorEnabled === "true",
    url: settings.githubAcceleratorUrl || "",
  });
  const cachePath = mimicAssetCachePath(version, asset);
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        headers: { "User-Agent": `NEX/${APP_VERSION}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        appendPanelLog("warn", `[MimicAssets] ${asset} unavailable from ${new URL(url).host}: HTTP ${res.status}`);
        continue;
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0 || data.length > MAX_MIMIC_ASSET_BYTES) continue;
      const actual = crypto.createHash("sha256").update(data).digest("hex");
      if (actual !== expected) {
        appendPanelLog("warn", `[MimicAssets] ${asset} from ${new URL(url).host} has SHA-256 ${actual}, expected ${expected}; discarded`);
        continue;
      }
      const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmpPath, data);
      await fsp.rename(tmpPath, cachePath);
      return cachePath;
    } catch (error) {
      appendPanelLog("warn", `[MimicAssets] ${asset} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

/** 缓存里有（且哈希对）就用缓存，否则从 GitHub（含加速）拉一次。拿不到返回 null。 */
export async function getOrFetchMimicAssetPath(version: string, asset: string, fetchImpl: FetchLike = fetch as any) {
  const normalized = String(version || "").trim().replace(/^v/i, "");
  const expected = mimicReleaseSha256(normalized, asset);
  if (!expected) return null;
  const cached = await cachedAssetIfValid(normalized, asset, expected);
  if (cached) return cached;
  const key = `${normalized}/${asset}`;
  let lock = fetchLocks.get(key);
  if (!lock) {
    lock = downloadMimicAsset(normalized, asset, expected, fetchImpl).finally(() => fetchLocks.delete(key));
    fetchLocks.set(key, lock);
  }
  return await lock;
}

/** 面板转发 mimic 包的根地址（给安装脚本用）；面板地址不能安全写进 shell 时返回空串。 */
export function mimicAssetRelayBase(panelUrl: string) {
  const base = `${String(panelUrl || "").replace(/\/+$/, "")}${MIMIC_ASSET_RELAY_PATH}`;
  return panelUrl && isShellSafeUrl(base) ? base : "";
}

function rateLimited(req: Request, res: Response) {
  const result = relayLimiter.consume(ipRateLimitScope(req.ip || ""));
  if (result.allowed) return false;
  res.status(429).send("Too many requests");
  return true;
}

export function registerMimicAssetRoutes(router: Router) {
  router.get(`${MIMIC_ASSET_RELAY_PATH}/:version/:asset`, async (req: Request, res: Response) => {
    if (rateLimited(req, res)) return;
    const version = String(req.params.version || "").trim().replace(/^v/i, "");
    const asset = String(req.params.asset || "").trim();
    if (!/^\d+\.\d+\.\d+$/.test(version) || !isRelayableMimicAsset(version, asset)) {
      res.status(404).send("Not found");
      return;
    }
    const filePath = await getOrFetchMimicAssetPath(version, asset);
    if (!filePath) {
      res.status(503).send("Mimic asset not available");
      return;
    }
    res.setHeader("Content-Type", "application/vnd.debian.binary-package");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Disposition", `attachment; filename="${asset}"`);
    res.sendFile(filePath);
  });

  router.get(MIMIC_INSTALL_SCRIPT_PATH, async (req: Request, res: Response) => {
    if (rateLimited(req, res)) return;
    const script = readMimicInstallerScript();
    if (!script) {
      res.status(503).send("Mimic installer is not bundled with this panel");
      return;
    }
    const assetBase = mimicAssetRelayBase(await resolvePanelUrl(req));
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(withMimicInstallerDefaults(script, { version: MIMIC_TARGET_VERSION, assetBase }));
  });
}
