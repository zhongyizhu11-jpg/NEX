/*
  主机网络画像 —— 面板这头：存结果、给 Agent 下指令、旧 Agent 的 DNSBL 兜底。

  Agent 2.2.225 起有扩展模块 "netprofile"（agent/ext_netprofile.go）：每 6 小时测一次双栈出站、
  25 端口出站、DNSBL，结果随扩展通道上报。「重新检测」按钮在内存里记一个 runId 并叫醒 Agent，
  Agent 看到新的 runId 就立刻测一次；等结果期间让 Agent 每 5 秒来一轮。

  指令里的 ackResultId 是面板最近收下的那份结果：Agent 据此丢掉已经交上来的结果（不会因为
  一次上报失败把结果弄丢）；lastCheckedAt 是面板存下的 Agent 检测时间，Agent 据此判断 6 小时
  到没到（Agent 重启不会立刻重测）。

  Agent 低于 2.2.225 时只能从面板服务器查 DNSBL（node:dns，用面板的解析器），双栈和 25 端口
  必须在主机上测，界面提示升级 Agent。
*/
import { Resolver } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { isAgentVersionAtLeast } from "../../shared/version";
import {
  DNSBL_LISTS,
  dnsblQueryName,
  interpretDnsblAnswer,
  netProfileHistoryItem,
  NETPROFILE_HISTORY_LIMIT,
  NETPROFILE_INTERVAL_SECONDS,
  NETPROFILE_IPV4_URLS,
  NETPROFILE_IPV6_URLS,
  NETPROFILE_MIN_AGENT_VERSION,
  normalizeNetProfileReport,
  parseStoredNetProfile,
  reverseIpv4,
  SMTP25_TARGETS,
  type DnsblEntry,
  type NetProfileHistoryItem,
  type NetProfileReport,
} from "../../shared/netProfile";
import { isPrivateOrReservedAddress } from "../../shared/ipAddress";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawAffectedRows } from "../dbRuntime";
import { wakeAgentExt, type AgentExtHost } from "./agentExt";

const q = quoteDbIdentifier;
const TABLE = "host_network_profiles";
const RUN_TIMEOUT_MS = 3 * 60 * 1000;
const DNSBL_TIMEOUT_MS = 5000;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function hostSupportsNetProfile(host: { agentVersion?: string | null } | null | undefined) {
  return !!host && isAgentVersionAtLeast(String(host.agentVersion || ""), NETPROFILE_MIN_AGENT_VERSION);
}

// ---------------------------------------------------------------- 存取

export type StoredNetProfile = {
  profile: NetProfileReport | null;
  history: NetProfileHistoryItem[];
  checkedAt: number | null;
  agentCheckedAt: number | null;
};

function parseHistory(raw: unknown): NetProfileHistoryItem[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(String(raw));
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item === "object" && Number(item.checkedAt) > 0).slice(-NETPROFILE_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function epochOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export async function getHostNetProfile(hostId: number): Promise<StoredNetProfile> {
  const rows = await queryRaw<any>(
    `SELECT ${q("profileJson")}, ${q("historyJson")}, ${q("checkedAt")}, ${q("agentCheckedAt")} FROM ${q(TABLE)} WHERE ${q("hostId")} = ? LIMIT 1`,
    [hostId],
  ).catch(() => []);
  const row = rows[0];
  if (!row) return { profile: null, history: [], checkedAt: null, agentCheckedAt: null };
  return {
    profile: parseStoredNetProfile(row.profileJson),
    history: parseHistory(row.historyJson),
    checkedAt: epochOf(row.checkedAt),
    agentCheckedAt: epochOf(row.agentCheckedAt),
  };
}

async function writeHostNetProfile(hostId: number, profile: NetProfileReport, history: NetProfileHistoryItem[]) {
  const values = {
    profileJson: JSON.stringify(profile),
    historyJson: JSON.stringify(history.slice(-NETPROFILE_HISTORY_LIMIT)),
    checkedAt: profile.checkedAt,
    agentCheckedAt: profile.agentCheckedAt,
    updatedAt: nowSec(),
  };
  const columns = Object.keys(values) as Array<keyof typeof values>;
  const update = async () => rawAffectedRows(await executeRaw(
    `UPDATE ${q(TABLE)} SET ${columns.map((name) => `${q(name)} = ?`).join(", ")} WHERE ${q("hostId")} = ?`,
    [...columns.map((name) => values[name]), hostId],
  ));
  if (await update() > 0) return;
  try {
    await insertAndGetId(TABLE, { hostId, ...values });
  } catch {
    // 并发插入撞了唯一键：另一边已经插了，改成更新
    await update();
  }
}

/** 存一次 Agent 的检测结果；返回存下来的那份。 */
export async function saveAgentNetProfile(hostId: number, report: NetProfileReport) {
  const previous = await getHostNetProfile(hostId);
  // Agent 这次没查 DNSBL（没有公网 IPv4 之类），沿用上一次的 DNSBL 结果，别让它从界面上消失
  const merged: NetProfileReport = report.dnsbl.length === 0 && previous.profile?.dnsbl.length
    ? { ...report, dnsbl: previous.profile.dnsbl, dnsblAddress: previous.profile.dnsblAddress, dnsblSource: previous.profile.dnsblSource, dnsblCheckedAt: previous.profile.dnsblCheckedAt }
    : report;
  const history = [...previous.history.filter((item) => item.checkedAt !== merged.checkedAt), netProfileHistoryItem(merged)];
  await writeHostNetProfile(hostId, merged, history);
  agentCheckedAtCache.set(hostId, merged.agentCheckedAt || merged.checkedAt);
  return merged;
}

/** 面板兜底查的 DNSBL：只换掉 DNSBL 那一块，主机侧上一次的结果（如果有）原样留着。 */
export async function savePanelDnsbl(hostId: number, address: string, dnsbl: DnsblEntry[]) {
  const previous = await getHostNetProfile(hostId);
  const now = nowSec();
  const base: NetProfileReport = previous.profile || {
    checkedAt: now, ipv4: null, ipv6: null, smtp25: null, dnsbl: [], dnsblAddress: null, dnsblSource: null, dnsblCheckedAt: null, agentCheckedAt: null,
  };
  const profile: NetProfileReport = { ...base, checkedAt: now, dnsbl, dnsblAddress: address, dnsblSource: "panel", dnsblCheckedAt: now };
  await writeHostNetProfile(hostId, profile, [...previous.history, netProfileHistoryItem(profile)]);
  return profile;
}

// ---------------------------------------------------------------- 面板兜底：DNSBL

export type DnsblResolver = (name: string) => Promise<string[]>;

function defaultDnsblResolver(): DnsblResolver {
  const resolver = new Resolver({ timeout: DNSBL_TIMEOUT_MS, tries: 1 });
  return (name) => resolver.resolve4(name);
}

/**
 * 从面板服务器查一个 IPv4 在各 DNSBL 里的情况。NXDOMAIN / 没有 A 记录 = 未列入；
 * 应答怎么读见 shared/netProfile.ts 的 interpretDnsblAnswer。各列表并发查，互不影响。
 */
export async function queryDnsblFromPanel(address: string, resolve: DnsblResolver = defaultDnsblResolver()): Promise<DnsblEntry[]> {
  return Promise.all(DNSBL_LISTS.map(async ({ zone }) => {
    const name = dnsblQueryName(address, zone);
    if (!name) return { list: zone, listed: false, code: null, error: "不是有效的 IPv4 地址" };
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), DNSBL_TIMEOUT_MS + 1000).unref?.());
      const addresses = await Promise.race([resolve(name), timeout]);
      return interpretDnsblAnswer(zone, { addresses });
    } catch (error: any) {
      const code = String(error?.code || error?.message || "查询失败");
      return interpretDnsblAnswer(zone, { notFound: code === "ENOTFOUND" || code === "ENODATA", error: code });
    }
  }));
}

/** 这台主机拿哪个 IPv4 去查 DNSBL：Agent 检测到的公网 IPv4，其次 ip 字段。内网 / 保留地址不查。 */
export function dnsblAddressForHost(host: any, profile?: NetProfileReport | null): string | null {
  const candidates = [profile?.ipv4?.address, host?.ipv4, host?.ip];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (reverseIpv4(text) && !isPrivateOrReservedAddress(text)) return text;
  }
  return null;
}

// ---------------------------------------------------------------- 重新检测（内存）

type PendingRun = { runId: string; createdAt: number; running: boolean };
const pendingRuns = new Map<number, PendingRun>();
const agentCheckedAtCache = new Map<number, number>();
/** 每台主机最近收下的那份结果的 resultId：随指令回给 Agent 当回执，也用来去重。 */
const lastResultIds = new Map<number, string>();

export function requestNetProfileRun(hostId: number) {
  const existing = pendingRuns.get(hostId);
  if (existing && Date.now() - existing.createdAt < RUN_TIMEOUT_MS) {
    wakeAgentExt(hostId, "netprofile");
    return existing.runId;
  }
  const runId = `np-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  pendingRuns.set(hostId, { runId, createdAt: Date.now(), running: false });
  wakeAgentExt(hostId, "netprofile");
  return runId;
}

export function netProfileRunState(hostId: number): { pending: boolean; running: boolean; timedOut: boolean } {
  const run = pendingRuns.get(hostId);
  if (!run) return { pending: false, running: false, timedOut: false };
  if (Date.now() - run.createdAt > RUN_TIMEOUT_MS) {
    pendingRuns.delete(hostId);
    return { pending: false, running: false, timedOut: true };
  }
  return { pending: true, running: run.running, timedOut: false };
}

async function agentCheckedAtFor(hostId: number) {
  const cached = agentCheckedAtCache.get(hostId);
  if (cached !== undefined) return cached;
  const stored = await getHostNetProfile(hostId);
  const value = stored.agentCheckedAt || 0;
  agentCheckedAtCache.set(hostId, value);
  return value;
}

// ---------------------------------------------------------------- 扩展模块

export async function netProfileDirectiveFor(host: AgentExtHost) {
  if (!hostSupportsNetProfile(host)) return undefined;
  const hostId = Number(host.id);
  const state = netProfileRunState(hostId);
  return {
    intervalSeconds: NETPROFILE_INTERVAL_SECONDS,
    lastCheckedAt: await agentCheckedAtFor(hostId),
    ackResultId: lastResultIds.get(hostId) || "",
    runId: state.pending ? pendingRuns.get(hostId)?.runId || "" : "",
    dnsbl: DNSBL_LISTS.map((item) => item.zone),
    smtpTargets: [...SMTP25_TARGETS],
    ipv4Urls: [...NETPROFILE_IPV4_URLS],
    ipv6Urls: [...NETPROFILE_IPV6_URLS],
  };
}

export async function ingestNetProfileReport(host: AgentExtHost, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const hostId = Number(host.id);
  const report = raw as Record<string, unknown>;
  const runId = typeof report.runId === "string" ? report.runId : "";
  const pending = pendingRuns.get(hostId);
  if (report.running === true && pending && pending.runId === runId) pending.running = true;
  if (!report.result || typeof report.result !== "object") return;
  const resultId = String((report.result as any).resultId || "").slice(0, 64);
  // 同一份结果（回执还没送到 Agent 那边）不重复存
  if (!resultId || lastResultIds.get(hostId) !== resultId) {
    const normalized = normalizeNetProfileReport(report.result);
    if (!normalized) return;
    await saveAgentNetProfile(hostId, normalized);
  }
  if (resultId) lastResultIds.set(hostId, resultId);
  // 只有带着这次 runId 的结果才算「重新检测」完成：定时那轮的结果碰巧这时候交上来不算
  if (pending && runId && pending.runId === runId) pendingRuns.delete(hostId);
}

export function netProfileIntervalFor(host: AgentExtHost) {
  return netProfileRunState(Number(host.id)).pending ? 5 : undefined;
}

/** 只给测试用。 */
export function resetNetProfileStateForTest() {
  pendingRuns.clear();
  agentCheckedAtCache.clear();
  lastResultIds.clear();
}
