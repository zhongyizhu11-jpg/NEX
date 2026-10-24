/*
  国家 IP 段：只下载被选中的国家，存进 firewall_country_data，一周刷新一次。

  来源（都免费、不要注册）：
    1. ipdeny.com 的 aggregated zones（每个国家一个文件，v4 / v6 分开）；
    2. GitHub 上的 ipverse/country-ip-blocks（CC0，数据直接来自五大 RIR 的分配记录）。
  开了 GitHub 加速（系统设置里那个）时先走加速后的 GitHub 地址 —— 国内的面板连 ipdeny 常常很慢；
  没开就先 ipdeny，再 GitHub 直连。

  刷新是「顺手」触发的：下发指令、面板访问检查、打开地区规则页时发现数据过期，就在后台拉一次，
  不用另起定时器。下载失败不清空旧数据，一小时后再试。
*/
import { createHash } from "node:crypto";
import { queryRaw, executeRaw, insertAndGetId, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import { getAllSettings } from "../repositories/settingsRepository";
import { assertSafeOutboundUrl } from "../ssrf";
import { applyGithubAccelerator, effectiveGithubAccelerator } from "../../shared/githubAccelerator";
import { firewallCountryName, isFirewallCountryCode, normalizeFirewallCountries } from "../../shared/firewallCountries";
import { aggregateCidrs, CidrMatcher, parseZoneText } from "./firewallCidr";
import { recordPanelEvent } from "./panelEvents";

const q = (name: string) => quoteDbIdentifier(name);

export const COUNTRY_DATA_REFRESH_MS = 7 * 86400_000;
const COUNTRY_DATA_RETRY_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type CountryDataRow = {
  country: string;
  v4: string[];
  v6: string[];
  source: string | null;
  fetchedAt: Date | null;
  attemptedAt: Date | null;
  lastError: string | null;
};

export type CountryDataStatus = {
  country: string;
  name: string;
  v4Count: number;
  v6Count: number;
  source: string | null;
  fetchedAt: Date | null;
  lastError: string | null;
  downloading: boolean;
};

type Source = { name: string; v4: (cc: string) => string; v6: (cc: string) => string };

const IPDENY: Source = {
  name: "ipdeny.com",
  v4: (cc) => `https://www.ipdeny.com/ipblocks/data/aggregated/${cc}-aggregated.zone`,
  v6: (cc) => `https://www.ipdeny.com/ipv6/ipaddresses/aggregated/${cc}-aggregated.zone`,
};

const GITHUB_RAW = "https://raw.githubusercontent.com/ipverse/country-ip-blocks/master/country";

function githubSource(accelerator: { enabled: boolean; url: string } | null): Source {
  const wrap = (url: string) => (accelerator ? applyGithubAccelerator(url, accelerator) : url);
  return {
    name: accelerator ? "GitHub ipverse（加速）" : "GitHub ipverse",
    v4: (cc) => wrap(`${GITHUB_RAW}/${cc}/ipv4-aggregated.txt`),
    v6: (cc) => wrap(`${GITHUB_RAW}/${cc}/ipv6-aggregated.txt`),
  };
}

async function countrySources(): Promise<Source[]> {
  let accelerator: { enabled: boolean; url: string } | null = null;
  try {
    const all = await getAllSettings();
    const value = effectiveGithubAccelerator({ enabled: all.githubAcceleratorEnabled === "true", url: all.githubAcceleratorUrl ?? "" });
    if (value.enabled) accelerator = value;
  } catch {
    // 读不到设置就当没开加速
  }
  return accelerator ? [githubSource(accelerator), IPDENY, githubSource(null)] : [IPDENY, githubSource(null)];
}

type FetchResult = { ok: true; text: string } | { ok: false; notFound: boolean; error: string };

async function fetchText(url: string): Promise<FetchResult> {
  try {
    // 跳转自己跟：每一跳都要过一遍 SSRF 检查，fetch 自动跟随会绕过去。
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop += 1) {
      await assertSafeOutboundUrl(current, { purpose: "下载国家 IP 段" });
      res = await fetch(current, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      current = new URL(location, current).toString();
      res = null;
    }
    if (!res) return { ok: false, notFound: false, error: "跳转次数太多" };
    if (res.status === 404) return { ok: false, notFound: true, error: "404" };
    if (!res.ok) return { ok: false, notFound: false, error: `HTTP ${res.status}` };
    const length = Number(res.headers.get("content-length") || 0);
    if (length > MAX_BODY_BYTES) return { ok: false, notFound: false, error: "文件太大" };
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_BODY_BYTES) return { ok: false, notFound: false, error: "文件太大" };
    return { ok: true, text: new TextDecoder().decode(buffer) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, notFound: false, error: message.includes("timeout") || message.includes("aborted") ? "连接超时" : message };
  }
}

type DownloadOutcome =
  | { ok: true; v4: string[]; v6: string[]; source: string }
  | { ok: false; error: string; noData?: boolean };

/** 按顺序试每个来源；某个来源 v4 和 v6 都 404 就当「这里没有这个国家」，换下一个。 */
export async function downloadCountryCidrs(country: string, sources: Source[], fetcher = fetchText): Promise<DownloadOutcome> {
  const cc = country.toLowerCase();
  const errors: string[] = [];
  let allNotFound = true;
  for (const source of sources) {
    const [v4Res, v6Res] = await Promise.all([fetcher(source.v4(cc)), fetcher(source.v6(cc))]);
    const failed = [v4Res, v6Res].find((res) => !res.ok && !res.notFound);
    if (failed && !failed.ok) {
      allNotFound = false;
      errors.push(`${source.name}：${failed.error}`);
      continue;
    }
    if (!v4Res.ok && !v6Res.ok) {
      errors.push(`${source.name}：没有这个国家的文件`);
      continue;
    }
    const v4 = v4Res.ok ? parseZoneText(v4Res.text, 4) : { cidrs: [], invalid: 0, lines: 0 };
    const v6 = v6Res.ok ? parseZoneText(v6Res.text, 6) : { cidrs: [], invalid: 0, lines: 0 };
    // 加速站或者代理出错时常返回一张 HTML 页面（200）：一行有效的都没有、或者大半是错的，就当这次没下到。
    const lines = v4.lines + v6.lines;
    const invalid = v4.invalid + v6.invalid;
    if (lines > 0 && (v4.cidrs.length + v6.cidrs.length === 0 || invalid > lines / 2)) {
      allNotFound = false;
      errors.push(`${source.name}：内容不是 IP 段列表`);
      continue;
    }
    return { ok: true, v4: v4.cidrs, v6: v6.cidrs, source: source.name };
  }
  return { ok: false, error: errors.join("；") || "没有可用的来源", noData: allNotFound };
}

// ── 存取 ──────────────────────────────────────────────

const memo = new Map<string, CountryDataRow>();
const inflight = new Map<string, Promise<void>>();
let dataGeneration = 0;
const generationListeners = new Set<() => void>();

/** 国家数据变了（下载完一个国家）时通知：面板访问检查要清掉缓存的判断。 */
export function onCountryDataChanged(listener: () => void) {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

function bumpGeneration() {
  dataGeneration += 1;
  for (const listener of generationListeners) {
    try { listener(); } catch { /* ignore */ }
  }
}

function rowToData(row: any): CountryDataRow {
  const split = (text: unknown) => String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    country: String(row.country || "").toUpperCase(),
    v4: split(row.v4),
    v6: split(row.v6),
    source: row.source ? String(row.source) : null,
    fetchedAt: rawEpochToDate(row.fetchedAt),
    attemptedAt: rawEpochToDate(row.attemptedAt),
    lastError: row.lastError ? String(row.lastError) : null,
  };
}

export async function loadCountryData(countries: string[]): Promise<Map<string, CountryDataRow>> {
  const codes = normalizeFirewallCountries(countries);
  const out = new Map<string, CountryDataRow>();
  const missing = codes.filter((code) => {
    const cached = memo.get(code);
    if (cached) out.set(code, cached);
    return !cached;
  });
  if (missing.length > 0) {
    const rows = await queryRaw(
      `SELECT * FROM ${q("firewall_country_data")} WHERE ${q("country")} IN (${missing.map(() => "?").join(", ")})`,
      missing,
    );
    for (const row of rows) {
      const data = rowToData(row);
      memo.set(data.country, data);
      out.set(data.country, data);
    }
  }
  return out;
}

async function writeCountryRow(country: string, values: Record<string, unknown>) {
  const existing = await queryRaw(`SELECT ${q("id")} FROM ${q("firewall_country_data")} WHERE ${q("country")} = ?`, [country]);
  if (existing.length > 0) {
    const keys = Object.keys(values);
    await executeRaw(
      `UPDATE ${q("firewall_country_data")} SET ${keys.map((key) => `${q(key)} = ?`).join(", ")} WHERE ${q("country")} = ?`,
      [...keys.map((key) => values[key] ?? null), country],
    );
  } else {
    await insertAndGetId("firewall_country_data", { country, ...values });
  }
  memo.delete(country);
}

function isDue(row: CountryDataRow | undefined, now = Date.now()) {
  if (!row) return true;
  const attempted = row.attemptedAt?.getTime() || 0;
  if (now - attempted < COUNTRY_DATA_RETRY_MS && (!row.fetchedAt || row.lastError)) return false;
  return !row.fetchedAt || now - row.fetchedAt.getTime() >= COUNTRY_DATA_REFRESH_MS;
}

async function refreshCountry(country: string) {
  const now = Math.floor(Date.now() / 1000);
  const outcome = await downloadCountryCidrs(country, await countrySources());
  if (outcome.ok) {
    await writeCountryRow(country, {
      v4: outcome.v4.join("\n"),
      v6: outcome.v6.join("\n"),
      v4Count: outcome.v4.length,
      v6Count: outcome.v6.length,
      source: outcome.source,
      fetchedAt: now,
      attemptedAt: now,
      lastError: null,
    });
    bumpGeneration();
    return;
  }
  if (outcome.noData) {
    // 哪个来源都没有这个国家（一些很小的岛屿）：记成「下载过、0 条」，一周后再看。
    await writeCountryRow(country, { v4: "", v6: "", v4Count: 0, v6Count: 0, source: null, fetchedAt: now, attemptedAt: now, lastError: "没有这个国家 / 地区的 IP 段" });
    bumpGeneration();
    return;
  }
  await writeCountryRow(country, { attemptedAt: now, lastError: outcome.error.slice(0, 1000) });
  void recordPanelEvent({
    kind: "ops.country_data",
    level: "warn",
    message: `${firewallCountryName(country)}的 IP 段下载失败，一小时后再试：${outcome.error.slice(0, 200)}`,
    data: { country },
  });
}

/**
 * 确保这些国家的数据下载过、不过期。waitMs > 0 时最多等这么久（保存面板访问规则时要等数据到手才能判断会不会把自己锁外面），
 * 否则在后台跑。
 */
export async function ensureCountryData(countries: string[], options: { waitMs?: number; force?: boolean } = {}) {
  const codes = normalizeFirewallCountries(countries);
  if (codes.length === 0) return;
  const existing = await loadCountryData(codes);
  const due = codes.filter((code) => options.force || isDue(existing.get(code)));
  const jobs = due.map((code) => {
    let job = inflight.get(code);
    if (!job) {
      job = refreshCountry(code)
        .catch((error) => console.warn(`[Firewall] country ${code} refresh failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => inflight.delete(code));
      inflight.set(code, job);
    }
    return job;
  });
  if (!options.waitMs || jobs.length === 0) return;
  await Promise.race([
    Promise.all(jobs),
    new Promise((resolve) => setTimeout(resolve, options.waitMs).unref?.()),
  ]);
}

let lastStaleSweep = 0;

/** 隔十分钟最多查一次：选中的国家里有没有过期的，有就后台刷新。 */
export function scheduleCountryDataRefresh(countries: string[]) {
  if (Date.now() - lastStaleSweep < 10 * 60_000) return;
  lastStaleSweep = Date.now();
  void ensureCountryData(countries).catch(() => undefined);
}

export async function countryDataStatus(countries: string[]): Promise<CountryDataStatus[]> {
  const codes = normalizeFirewallCountries(countries);
  const data = await loadCountryData(codes);
  return codes.map((code) => {
    const row = data.get(code);
    return {
      country: code,
      name: firewallCountryName(code),
      v4Count: row?.v4.length || 0,
      v6Count: row?.v6.length || 0,
      source: row?.source || null,
      fetchedAt: row?.fetchedAt || null,
      lastError: row?.lastError || null,
      downloading: inflight.has(code),
    };
  });
}

// ── 合并后的国家段（给 Agent） ────────────────────────────

export type CombinedGeo = { hash: string; v4: string[]; v6: string[]; ready: boolean; missing: string[] };

const combinedMemo = new Map<string, CombinedGeo>();

/** 几个国家的段合并成一份，带哈希。同一组国家 + 同一批数据只算一次。 */
export async function combinedCountryGeo(countries: string[]): Promise<CombinedGeo> {
  const codes = normalizeFirewallCountries(countries);
  const data = await loadCountryData(codes);
  const missing = codes.filter((code) => !data.get(code)?.fetchedAt);
  const key = codes.map((code) => `${code}@${data.get(code)?.fetchedAt?.getTime() || 0}`).join(",");
  const cached = combinedMemo.get(key);
  if (cached) return cached;
  const all: string[] = [];
  for (const code of codes) {
    const row = data.get(code);
    if (row) all.push(...row.v4, ...row.v6);
  }
  const aggregated = aggregateCidrs(all);
  const hash = createHash("sha256").update(codes.join(",")).update("\n").update(aggregated.v4.join("\n")).update("\n").update(aggregated.v6.join("\n")).digest("hex").slice(0, 32);
  const value: CombinedGeo = { hash, v4: aggregated.v4, v6: aggregated.v6, ready: missing.length === 0, missing };
  if (combinedMemo.size > 32) combinedMemo.clear();
  combinedMemo.set(key, value);
  return value;
}

// ── 单个国家的匹配器（面板访问检查用） ─────────────────────

const matcherMemo = new Map<string, { at: number; matcher: CidrMatcher }>();

export async function countryMatchers(countries: string[]): Promise<Map<string, CidrMatcher | null>> {
  const codes = normalizeFirewallCountries(countries);
  const data = await loadCountryData(codes);
  const out = new Map<string, CidrMatcher | null>();
  for (const code of codes) {
    const row = data.get(code);
    if (!row?.fetchedAt) {
      out.set(code, null);
      continue;
    }
    const at = row.fetchedAt.getTime();
    let entry = matcherMemo.get(code);
    if (!entry || entry.at !== at) {
      entry = { at, matcher: new CidrMatcher([...row.v4, ...row.v6]) };
      matcherMemo.set(code, entry);
    }
    out.set(code, entry.matcher);
  }
  return out;
}

/** 在已下载的国家里找这个 IP 属于哪个（只看本地缓存，不查外部接口）。 */
export async function lookupCachedCountry(ip: string): Promise<string | null> {
  const rows = await queryRaw(`SELECT ${q("country")} FROM ${q("firewall_country_data")} WHERE ${q("fetchedAt")} IS NOT NULL`);
  const codes = (rows as any[]).map((row) => String(row.country || "").toUpperCase()).filter(isFirewallCountryCode);
  const matchers = await countryMatchers(codes);
  for (const [code, matcher] of matchers) {
    if (matcher?.contains(ip)) return code;
  }
  return null;
}
