/*
  网络画像的 IP 信息 —— 面板这头（Agent 2.2.253 起，读法见 shared/ipIntel.ts）。

  三条来路，结果都落 host_ip_intel（每台主机 × 协议族 × 数据库一行，见 ipIntelTables.ts）：

    1. Agent 从自己的出口查不要 Key 的几家（ipapi.is、IPinfo、proxycheck）：随 netprofile 指令下发
       intel 列表，原始响应随检测结果交上来，这里按面板的规则解读（规则改了不用等 Agent 升级）。
       只在缓存过期（一天）或管理员点了「重新检测」时才下发，免得每 6 小时都去打第三方。
    2. 面板带着主机的 IP 去查：RIPEstat（注册地，不要 Key）、配了 Key 的 ipapi.is / AbuseIPDB / IPinfo。
       Key 只在面板上用，不下发给 Agent，也不回给浏览器。
    3. Agent 低于 2.2.253：不要 Key 的那几家也由面板代查（查的是主机行上 / 上次检测到的公网地址）。

  面板这头的请求一律走 server/ssrf.ts 的 safeHttpGet（8 秒超时、64KB 上限），在后台跑，
  界面只读缓存，从不等第三方。
*/
import {
  buildIpIntelFamilyView,
  IP_INTEL_AGENT_SOURCES,
  IP_INTEL_FAILURE_RETRY_SECONDS,
  IP_INTEL_KEY_PROVIDERS,
  IP_INTEL_KEY_SETTINGS,
  IP_INTEL_TTL_SECONDS,
  ipIntelHttpReason,
  isIpIntelProvider,
  maskIntelKey,
  NETPROFILE_INTEL_AGENT_VERSION,
  normalizeStoredIpIntelInfo,
  parseIpIntelResponse,
  type IpIntelFamily,
  type IpIntelKeyProvider,
  type IpIntelProvider,
  type IpIntelProviderResult,
  type IpIntelVia,
} from "../../shared/ipIntel";
import { isPrivateOrReservedAddress } from "../../shared/ipAddress";
import { isAgentVersionAtLeast } from "../../shared/version";
import type { NetProfileReport } from "../../shared/netProfile";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawAffectedRows } from "../dbRuntime";
import { getSetting, setSetting } from "../repositories/settingsRepository";
import { safeHttpGet } from "../ssrf";

const q = quoteDbIdentifier;
const TABLE = "host_ip_intel";

/** 这里只用到主机行上的这几个字段（主机行、扩展通道的 AgentExtHost 都满足）。 */
export type IntelHost = { id?: unknown; agentVersion?: unknown; ip?: unknown; ipv4?: unknown; ipv6?: unknown };
const PANEL_TIMEOUT_MS = 8000;
const PANEL_MAX_BYTES = 64 * 1024;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- 可选 Key

export type IpIntelKeys = Partial<Record<IpIntelKeyProvider, string>>;

export async function getIpIntelKeys(): Promise<IpIntelKeys> {
  const out: IpIntelKeys = {};
  for (const provider of IP_INTEL_KEY_PROVIDERS) {
    const value = String((await getSetting(IP_INTEL_KEY_SETTINGS[provider]).catch(() => null)) || "").trim();
    if (value) out[provider] = value;
  }
  return out;
}

/** 设置页看的：配没配、末四位。真实 Key 不出面板。 */
export async function ipIntelKeyStatus() {
  const keys = await getIpIntelKeys();
  return IP_INTEL_KEY_PROVIDERS.map((provider) => ({ provider, configured: !!keys[provider], masked: maskIntelKey(keys[provider]) }));
}

/** undefined = 不动；"" 或 null = 清掉；其余 = 换成新的（落库时自动加密，见 settingsSecretKeys.ts）。 */
export async function setIpIntelKeys(patch: Partial<Record<IpIntelKeyProvider, string | null | undefined>>) {
  for (const provider of IP_INTEL_KEY_PROVIDERS) {
    if (!(provider in patch) || patch[provider] === undefined) continue;
    const value = String(patch[provider] || "").trim();
    await setSetting(IP_INTEL_KEY_SETTINGS[provider], value || null);
  }
}

// ---------------------------------------------------------------- 谁去查

export function agentSupportsIntel(host: { agentVersion?: unknown } | null | undefined) {
  return isAgentVersionAtLeast(host?.agentVersion ? String(host.agentVersion) : null, NETPROFILE_INTEL_AGENT_VERSION);
}

/** 交给 Agent 查的：不要 Key 的那几家里，没有配 Key 的（配了 Key 就由面板带 Key 查，不重复打）。 */
export function agentIntelSources(keys: IpIntelKeys) {
  return IP_INTEL_AGENT_SOURCES.filter((source) => !(source.id in keys && keys[source.id as IpIntelKeyProvider]));
}

/** 面板这头要查的：RIPEstat 总是；配了 Key 的；Agent 太旧时再加上本该 Agent 查的那几家。 */
export function panelIntelProviders(host: { agentVersion?: unknown }, keys: IpIntelKeys): IpIntelProvider[] {
  const out = new Set<IpIntelProvider>(["ripestat"]);
  for (const provider of IP_INTEL_KEY_PROVIDERS) if (keys[provider]) out.add(provider);
  if (!agentSupportsIntel(host)) for (const source of IP_INTEL_AGENT_SOURCES) out.add(source.id);
  return Array.from(out);
}

/** 面板去查时用的请求。Key 走请求头的就放请求头（AbuseIPDB、IPinfo），ipapi.is 只认查询参数。 */
export function panelIntelRequest(provider: IpIntelProvider, address: string, keys: IpIntelKeys): { url: string; headers: Record<string, string> } | null {
  const ip = encodeURIComponent(address);
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "NEX-Panel" };
  switch (provider) {
    case "ipapi_is":
      return { url: `https://api.ipapi.is/?q=${ip}${keys.ipapi_is ? `&key=${encodeURIComponent(keys.ipapi_is)}` : ""}`, headers };
    case "ipinfo":
      if (keys.ipinfo) headers.Authorization = `Bearer ${keys.ipinfo}`;
      return { url: `https://ipinfo.io/${ip}/json`, headers };
    case "proxycheck":
      return { url: `https://proxycheck.io/v2/${ip}?vpn=1&asn=1&risk=1`, headers };
    case "abuseipdb":
      if (!keys.abuseipdb) return null;
      headers.Key = keys.abuseipdb;
      return { url: `https://api.abuseipdb.com/api/v2/check?ipAddress=${ip}&maxAgeInDays=90`, headers };
    case "ripestat":
      return { url: `https://stat.ripe.net/data/rir-stats-country/data.json?resource=${ip}&sourceapp=nex-panel`, headers };
  }
  return null;
}

export type IpIntelFetcher = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

const defaultFetcher: IpIntelFetcher = async (url, headers) => {
  const response = await safeHttpGet(url, { purpose: "网络画像 IP 信息查询", timeoutMs: PANEL_TIMEOUT_MS, maxBytes: PANEL_MAX_BYTES, headers });
  return { status: response.status, body: response.body.toString("utf8") };
};

let fetcher: IpIntelFetcher = defaultFetcher;

/** 只给测试用：换掉对外请求。 */
export function setIpIntelFetcherForTest(fn: IpIntelFetcher | null) {
  fetcher = fn || defaultFetcher;
}

function shortError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/超时|timeout/i.test(message)) return "请求超时";
  if (/受限地址|blocked/i.test(message)) return "目标地址被面板的出站限制拦下";
  if (/解析|ENOTFOUND|resolve/i.test(message)) return "域名解析失败";
  return `网络请求失败：${message.slice(0, 80)}`;
}

/** 面板查一家。失败也是一条结果（ok=false + 原因），不抛错。 */
export async function queryIntelFromPanel(provider: IpIntelProvider, family: IpIntelFamily, address: string, keys: IpIntelKeys, now = nowSec()): Promise<IpIntelProviderResult> {
  const base = { provider, family, via: "panel" as IpIntelVia, address, checkedAt: now };
  const request = panelIntelRequest(provider, address, keys);
  if (!request) return { ...base, ok: false, reason: "没有配置 Key", info: null };
  try {
    const response = await fetcher(request.url, request.headers);
    const parsed = parseIpIntelResponse(provider, response.body, address);
    // 有的家限流时也回 JSON 错误体；状态码不对就以状态码为准
    const httpReason = ipIntelHttpReason(response.status);
    if (httpReason) return { ...base, ok: false, reason: parsed.ok ? httpReason : `${httpReason}：${parsed.reason}`, info: null };
    if (!parsed.ok) return { ...base, ok: false, reason: parsed.reason, info: null };
    return { ...base, ok: true, reason: null, info: parsed.info };
  } catch (error) {
    return { ...base, ok: false, reason: shortError(error), info: null };
  }
}

// ---------------------------------------------------------------- 存取

function rowToResult(row: Record<string, unknown>): IpIntelProviderResult | null {
  const provider = String(row.provider || "");
  if (!isIpIntelProvider(provider)) return null;
  const family = Number(row.family) === 6 ? 6 : 4;
  const ok = row.ok === true || Number(row.ok) === 1;
  const checkedAt = row.checkedAt instanceof Date ? Math.floor(row.checkedAt.getTime() / 1000) : Math.floor(Number(row.checkedAt) || 0);
  let info = null;
  if (ok) {
    try {
      info = normalizeStoredIpIntelInfo(JSON.parse(String(row.infoJson || "null")));
    } catch {
      info = null;
    }
  }
  return {
    provider,
    family,
    via: String(row.via) === "agent" ? "agent" : "panel",
    address: row.address ? String(row.address) : null,
    checkedAt,
    ok: ok && !!info,
    reason: ok && info ? null : String(row.reason || "没有结果").slice(0, 200),
    info: ok ? info : null,
  };
}

export async function listHostIpIntel(hostId: number): Promise<IpIntelProviderResult[]> {
  const rows = await queryRaw<Record<string, unknown>>(`SELECT * FROM ${q(TABLE)} WHERE ${q("hostId")} = ?`, [hostId]).catch(() => []);
  return rows.map(rowToResult).filter((item): item is IpIntelProviderResult => !!item);
}

export async function saveHostIpIntel(hostId: number, result: IpIntelProviderResult) {
  const values = {
    via: result.via,
    address: result.address ? result.address.slice(0, 64) : null,
    ok: result.ok,
    reason: result.ok ? null : String(result.reason || "").slice(0, 300),
    infoJson: result.ok && result.info ? JSON.stringify(result.info) : null,
    checkedAt: result.checkedAt,
  };
  const columns = Object.keys(values) as Array<keyof typeof values>;
  const where = `${q("hostId")} = ? AND ${q("family")} = ? AND ${q("provider")} = ?`;
  const update = async () => rawAffectedRows(await executeRaw(
    `UPDATE ${q(TABLE)} SET ${columns.map((name) => `${q(name)} = ?`).join(", ")} WHERE ${where}`,
    [...columns.map((name) => values[name]), hostId, result.family, result.provider],
  ));
  if (await update() > 0) return;
  try {
    await insertAndGetId(TABLE, { hostId, family: result.family, provider: result.provider, ...values });
  } catch {
    await update();
  }
}

export async function deleteHostIpIntel(hostId: number) {
  await executeRaw(`DELETE FROM ${q(TABLE)} WHERE ${q("hostId")} = ?`, [hostId]).catch(() => undefined);
}

/** 这条缓存还新不新：成功的一天，失败的半小时。 */
export function ipIntelFresh(result: Pick<IpIntelProviderResult, "ok" | "checkedAt"> | undefined, now = nowSec()) {
  if (!result) return false;
  return now - result.checkedAt < (result.ok ? IP_INTEL_TTL_SECONDS : IP_INTEL_FAILURE_RETRY_SECONDS);
}

// ---------------------------------------------------------------- 地址

function publicAddress(value: unknown, family: IpIntelFamily): string | null {
  const text = String(value || "").trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!text) return null;
  const isV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text);
  const isV6 = !isV4 && text.includes(":") && /^[0-9a-f:.]+$/.test(text);
  if ((family === 4 && !isV4) || (family === 6 && !isV6)) return null;
  return isPrivateOrReservedAddress(text) ? null : text;
}

/** 每个协议族查哪个地址：优先 Agent 测到的出口，其次主机行上的地址。内网 / 保留地址不查。 */
export function ipIntelAddresses(host: IntelHost | null | undefined, profile?: Pick<NetProfileReport, "ipv4" | "ipv6"> | null): Record<IpIntelFamily, string | null> {
  return {
    4: publicAddress(profile?.ipv4?.ok ? profile.ipv4.address : null, 4) || publicAddress(host?.ipv4, 4) || publicAddress(host?.ip, 4),
    6: publicAddress(profile?.ipv6?.ok ? profile.ipv6.address : null, 6) || publicAddress(host?.ipv6, 6),
  };
}

// ---------------------------------------------------------------- 面板侧刷新（后台）

const refreshing = new Map<number, Promise<void>>();

export function ipIntelRefreshing(hostId: number) {
  return refreshing.has(hostId);
}

/**
 * 面板这头查一遍（只查过期的，force 时全查）。同一台主机同时只跑一份；各家各协议族并发，
 * 一家失败不影响别家。调用方不等它：用 scheduleHostIpIntelRefresh。
 */
export async function refreshHostIpIntelFromPanel(host: IntelHost, profile: Pick<NetProfileReport, "ipv4" | "ipv6"> | null, options: { force?: boolean } = {}) {
  const hostId = Number(host?.id);
  if (!(hostId > 0)) return;
  const existing = refreshing.get(hostId);
  if (existing) return existing;
  const work = (async () => {
    const keys = await getIpIntelKeys();
    const providers = panelIntelProviders(host, keys);
    const addresses = ipIntelAddresses(host, profile);
    const cached = await listHostIpIntel(hostId);
    const now = nowSec();
    const jobs: Array<Promise<void>> = [];
    for (const family of [4, 6] as const) {
      const address = addresses[family];
      if (!address) continue;
      for (const provider of providers) {
        const previous = cached.find((item) => item.family === family && item.provider === provider);
        // 地址变了（换了 IP）缓存作废
        if (!options.force && previous && previous.address === address && ipIntelFresh(previous, now)) continue;
        jobs.push(queryIntelFromPanel(provider, family, address, keys, now).then((result) => saveHostIpIntel(hostId, result)));
      }
    }
    await Promise.allSettled(jobs);
  })().catch((error) => {
    console.warn(`[NetProfile] host=${hostId} IP 信息查询失败：${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    refreshing.delete(hostId);
  });
  refreshing.set(hostId, work);
  return work;
}

export function scheduleHostIpIntelRefresh(host: IntelHost, profile: Pick<NetProfileReport, "ipv4" | "ipv6"> | null, options: { force?: boolean } = {}) {
  void refreshHostIpIntelFromPanel(host, profile, options);
}

// ---------------------------------------------------------------- Agent 交上来的

const agentIntelCheckedAt = new Map<number, number>();

/** Agent 那几家这台主机最近一次是什么时候查的（内存缓存一份，指令每轮都要问）。 */
async function agentIntelLastCheckedAt(hostId: number) {
  const cached = agentIntelCheckedAt.get(hostId);
  if (cached !== undefined) return cached;
  const rows = (await listHostIpIntel(hostId)).filter((item) => item.via === "agent");
  // 有失败的就按「半小时后可以重试」折算，让下一轮检测顺带补上
  const value = rows.length === 0 ? 0 : Math.min(...rows.map((item) => (item.ok ? item.checkedAt : item.checkedAt - (IP_INTEL_TTL_SECONDS - IP_INTEL_FAILURE_RETRY_SECONDS))));
  agentIntelCheckedAt.set(hostId, value);
  return value;
}

/** 这一轮 netprofile 指令里要不要带 intel 列表：Agent 够新，而且缓存过期了或者管理员点了重新检测。 */
export async function agentIntelDirective(host: { id: number; agentVersion?: unknown }, manualRun: boolean) {
  if (!agentSupportsIntel(host)) return [];
  const sources = agentIntelSources(await getIpIntelKeys());
  if (sources.length === 0) return [];
  if (!manualRun && nowSec() - await agentIntelLastCheckedAt(Number(host.id)) < IP_INTEL_TTL_SECONDS) return [];
  return sources.map((source) => ({ id: source.id, url: source.url }));
}

/**
 * 收 Agent 交上来的原始响应：[{source, family, address, status, body, error}]。
 * 只认指令里给过的那几家；body 按 shared/ipIntel.ts 的规则读。
 */
export async function ingestAgentIpIntel(hostId: number, raw: unknown, now = nowSec()) {
  if (!Array.isArray(raw) || !(hostId > 0)) return 0;
  const allowed = new Set(IP_INTEL_AGENT_SOURCES.map((source) => source.id));
  let saved = 0;
  for (const entry of raw.slice(0, 16)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const provider = String(item.source || "");
    if (!isIpIntelProvider(provider) || !allowed.has(provider)) continue;
    const family: IpIntelFamily = Number(item.family) === 6 ? 6 : 4;
    const address = publicAddress(item.address, family);
    const base = { provider, family, via: "agent" as IpIntelVia, address, checkedAt: now };
    let result: IpIntelProviderResult;
    const error = String(item.error || "").trim();
    const status = Math.floor(Number(item.status) || 0);
    if (error) {
      result = { ...base, ok: false, reason: `从主机出口请求失败：${error.slice(0, 120)}`, info: null };
    } else {
      const parsed = parseIpIntelResponse(provider, typeof item.body === "string" ? item.body.slice(0, PANEL_MAX_BYTES) : null, address);
      const httpReason = ipIntelHttpReason(status || 200);
      if (httpReason) result = { ...base, ok: false, reason: httpReason, info: null };
      else if (!parsed.ok) result = { ...base, ok: false, reason: parsed.reason, info: null };
      else result = { ...base, address: parsed.info.ip || address, ok: true, reason: null, info: parsed.info };
    }
    await saveHostIpIntel(hostId, result);
    saved += 1;
  }
  if (saved > 0) agentIntelCheckedAt.delete(hostId);
  return saved;
}

// ---------------------------------------------------------------- 给界面

export async function hostIpIntelView(host: IntelHost, profile: Pick<NetProfileReport, "ipv4" | "ipv6"> | null) {
  const hostId = Number(host?.id);
  const results = await listHostIpIntel(hostId);
  const addresses = ipIntelAddresses(host, profile);
  const keys = await getIpIntelKeys();
  // 一条缓存都没有、又知道地址：后台查一次面板这头的（不等它，下次刷新就有了）
  if (results.length === 0 && (addresses[4] || addresses[6])) scheduleHostIpIntelRefresh(host, profile);
  return {
    families: ([4, 6] as const)
      .map((family) => buildIpIntelFamilyView(family, addresses[family], results))
      .filter((view) => view.address || view.providers.length > 0),
    configuredKeys: IP_INTEL_KEY_PROVIDERS.filter((provider) => !!keys[provider]),
    agentSupported: agentSupportsIntel(host),
    refreshing: ipIntelRefreshing(hostId),
  };
}

/** 只给测试用。 */
export function resetIpIntelStateForTest() {
  refreshing.clear();
  agentIntelCheckedAt.clear();
  fetcher = defaultFetcher;
}
