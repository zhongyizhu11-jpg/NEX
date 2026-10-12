/*
  经其他主机连面板（#8）里不碰数据库的那部分：谁能当中转、放行名单、自动切换的判定、
  界面上那句「现在：……」。放在单独的文件里是为了能直接写单元测试。
*/
import { isAgentVersionAtLeast } from "../../shared/version";
import { isIP } from "node:net";

export const AGENT_RELAY_MIN_VERSION = "2.2.216";

/** 自动切换看多长一段时间（4 小时，每分钟一个样本）。 */
export const AUTO_SWITCH_WINDOW_MINUTES = 240;
/** 至少看了这么多分钟才判断，免得面板刚重启、样本太少时误切。 */
export const AUTO_SWITCH_MIN_SAMPLES = 10;
export const AUTO_SWITCH_THRESHOLD_CHOICES = [3, 10, 30] as const;
export const AUTO_SWITCH_DEFAULT_THRESHOLD = 3;

export type RelayConfigRow = {
  hostId: number;
  viaHostId: number | null;
  autoViaHostId: number | null;
  autoThresholdMinutes: number;
  autoSwitchedAt: number | null;
  listenPort: number | null;
};

export type RelayHostLike = {
  id: number;
  name?: string | null;
  agentVersion?: string | null;
  online: boolean;
};

export type RelayReport = {
  role?: string;
  via?: string;
  viaActive?: boolean;
  fallbackActive?: boolean;
  fallbackSince?: number;
  fallbackCount?: number;
  lastError?: string;
  lastErrorAt?: number;
  panelAddr?: string;
  publicIps?: string[];
  listen?: { port?: number; listening?: boolean; target?: string; error?: string } | null;
  relayedConnections?: number;
  activeConnections?: number;
  rejectedConnections?: number;
  failedConnections?: number;
};

export function hostSupportsRelay(host: { agentVersion?: string | null } | null | undefined) {
  return !!host && isAgentVersionAtLeast(String(host.agentVersion || ""), AGENT_RELAY_MIN_VERSION);
}

/**
 * candidate 能不能给 target 当中转。规则：
 *   不能是自己；Agent 要 2.2.216 以上且在线；它自己不能也是经由别人连面板的（不串两级）；
 *   target 自己正在给别人当中转时，它不能再经由别人（同样是两级）。
 */
export function relayCandidateIssue(
  candidate: RelayHostLike,
  targetHostId: number,
  configs: ReadonlyMap<number, RelayConfigRow>,
): string | null {
  if (candidate.id === targetHostId) return "不能经由自己";
  if (!hostSupportsRelay(candidate)) return "Agent 需要 2.2.216 以上";
  if (!candidate.online) return "离线";
  if (configs.get(candidate.id)?.viaHostId) return "它自己也在经由别的主机";
  for (const row of configs.values()) {
    if (row.viaHostId === targetHostId && row.hostId !== targetHostId) return "这台正在给别的主机当中转";
  }
  return null;
}

/** 放行名单：被中转的那几台主机的 IP（主机地址里是 IP 的，加上 Agent 报的公网出口 IP）。 */
export function relayAllowList(hosts: Array<{ ip?: unknown; ipv4?: unknown; ipv6?: unknown; publicIps?: unknown }>): string[] {
  const set = new Set<string>();
  for (const host of hosts) {
    const values = [host.ip, host.ipv4, host.ipv6, ...(Array.isArray(host.publicIps) ? host.publicIps : [])];
    for (const raw of values) {
      const value = String(raw ?? "").trim().replace(/^\[|\]$/g, "");
      if (value && isIP(value)) set.add(value.toLowerCase());
    }
  }
  return Array.from(set).sort();
}

/** host:port，IPv6 加方括号。 */
export function joinHostPort(host: string, port: number) {
  const clean = String(host || "").trim().replace(/^\[|\]$/g, "");
  return clean.includes(":") ? `[${clean}]:${port}` : `${clean}:${port}`;
}

/** 面板 URL → 拨号地址 host:port（和 Agent 的 panelAddrFromURL 同一套规则）。 */
export function panelAddrFromUrl(raw: string): string {
  try {
    const url = new URL(String(raw || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return joinHostPort(url.hostname, Number(port)).toLowerCase();
  } catch {
    return "";
  }
}

/** 每台主机最近 4 小时的在线样本（一分钟一个，true = 在线）。只在内存里，面板重启后重新攒。 */
export class OfflineSampler {
  private samples = new Map<number, boolean[]>();

  record(hostId: number, online: boolean) {
    const list = this.samples.get(hostId) || [];
    list.push(online);
    if (list.length > AUTO_SWITCH_WINDOW_MINUTES) list.splice(0, list.length - AUTO_SWITCH_WINDOW_MINUTES);
    this.samples.set(hostId, list);
  }

  forget(hostId: number) {
    this.samples.delete(hostId);
  }

  keepOnly(hostIds: Iterable<number>) {
    const keep = new Set(hostIds);
    for (const id of Array.from(this.samples.keys())) if (!keep.has(id)) this.samples.delete(id);
  }

  stats(hostId: number) {
    const list = this.samples.get(hostId) || [];
    return { samples: list.length, offlineMinutes: list.filter((online) => !online).length };
  }
}

export function shouldAutoSwitch(stats: { samples: number; offlineMinutes: number }, thresholdMinutes: number) {
  const threshold = Math.max(1, Math.floor(Number(thresholdMinutes) || AUTO_SWITCH_DEFAULT_THRESHOLD));
  return stats.samples >= AUTO_SWITCH_MIN_SAMPLES && stats.offlineMinutes >= threshold;
}

export function normalizeThreshold(value: unknown) {
  const n = Math.floor(Number(value));
  return (AUTO_SWITCH_THRESHOLD_CHOICES as readonly number[]).includes(n) ? n : AUTO_SWITCH_DEFAULT_THRESHOLD;
}

export type RelayStatusTone = "ok" | "warn" | "muted";

/** 主机详情里那一句「现在：……」。 */
export function relayStatusLine(input: {
  supported: boolean;
  configuredViaName: string | null;
  report: RelayReport | null;
  reportAgeSeconds: number | null;
}): { text: string; tone: RelayStatusTone; detail: string | null } {
  if (!input.supported) return { text: "需要把 Agent 升级到 2.2.216", tone: "muted", detail: null };
  const report = input.report;
  if (!report) {
    return input.configuredViaName
      ? { text: `已设为经由 ${input.configuredViaName}，等 Agent 回报`, tone: "muted", detail: null }
      : { text: "现在：直连", tone: "ok", detail: null };
  }
  const stale = input.reportAgeSeconds !== null && input.reportAgeSeconds > 300
    ? `（${Math.round(input.reportAgeSeconds / 60)} 分钟前的回报）`
    : "";
  if (!report.via) {
    if (input.configuredViaName) return { text: `已设为经由 ${input.configuredViaName}，等 Agent 回报`, tone: "muted", detail: null };
    return { text: `现在：直连${stale}`, tone: "ok", detail: null };
  }
  if (report.viaActive) {
    return { text: `现在：经由 ${input.configuredViaName || report.via}${stale}`, tone: "ok", detail: null };
  }
  if (report.fallbackActive) {
    if (!report.lastError) return { text: `正在试连中转${stale}`, tone: "muted", detail: null };
    return { text: `中转失败，已退回直连${stale}`, tone: "warn", detail: report.lastError || null };
  }
  return { text: `现在：直连${stale}`, tone: "ok", detail: null };
}
