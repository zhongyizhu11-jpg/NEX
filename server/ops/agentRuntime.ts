/*
  Agent 进程自己的运行状况 + 性能剖析开关（主机详情「Agent 运行状态」）。

  运行状况：Agent 每次心跳带一份 agentRuntime（agent/agent_runtime_report.go）：常驻内存、Go 堆、
  协程数、GC 停顿、进程内 UDP 中继的会话数 / 上限 / 累计回收 / 累计拒绝、CPU 有没有 AES 硬件
  加速、性能剖析开着时的地址。面板只记在内存里（和 TLS 入站的监听状态一样），重启后下一次心跳
  就补上；老 Agent 不带这个字段，这一节就不显示。

  性能剖析：管理员在主机详情里打开，面板记一个截止时间（内存里），走扩展通道的 "pprof" 模块
  下发 {enabled, until}（agent/ext_pprof.go）；Agent 只在 127.0.0.1 上开、到点自己关。面板重启
  后指令就没了，Agent 下一轮收到 enabled=false 也关掉——默认就是关的。
*/
import { wakeAgentExt, type AgentExtHost } from "./agentExt";

export type AgentRuntimeUdpSessions = { active: number; cap: number; evicted: number; rejected: number };

export type AgentRuntimePprof = { running: boolean; addr: string; until: number; error: string };

export type AgentRuntimeStats = {
  rssBytes: number | null;
  heapBytes: number;
  goroutines: number;
  gcCount: number;
  gcPauseMaxUs: number;
  gcPauseTotalMs: number;
  udpSessions: AgentRuntimeUdpSessions | null;
  cpuAes: boolean | null;
  pprof: AgentRuntimePprof | null;
  updatedAt: number;
};

/** 性能剖析最长开多久（分钟），和 Agent 那头的上限一致。 */
export const AGENT_PPROF_MAX_MINUTES = 120;
export const AGENT_PPROF_DEFAULT_MINUTES = 30;

const HOST_MAX = 4096;
const statsByHost = new Map<number, AgentRuntimeStats>();
const pprofUntilByHost = new Map<number, number>();
const pprofReportByHost = new Map<number, AgentRuntimePprof & { reportedAt: number }>();

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizePprof(value: unknown): AgentRuntimePprof | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const addr = String(raw.addr || "").slice(0, 64);
  return {
    running: raw.running === true,
    // 只认回环地址：Agent 不会开在别处，开在别处的上报也不照着显示。
    addr: /^127\.0\.0\.1:\d{1,5}$/.test(addr) ? addr : "",
    until: count(raw.until),
    error: String(raw.error || "").slice(0, 300),
  };
}

export function normalizeAgentRuntimeStats(input: unknown, now = Date.now()): AgentRuntimeStats | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const udp = raw.udpSessions && typeof raw.udpSessions === "object" ? raw.udpSessions as Record<string, unknown> : null;
  const rss = count(raw.rssBytes);
  return {
    rssBytes: rss > 0 ? rss : null,
    heapBytes: count(raw.heapBytes),
    goroutines: count(raw.goroutines),
    gcCount: count(raw.gcCount),
    gcPauseMaxUs: count(raw.gcPauseMaxUs),
    gcPauseTotalMs: count(raw.gcPauseTotalMs),
    udpSessions: udp ? { active: count(udp.active), cap: count(udp.cap), evicted: count(udp.evicted), rejected: count(udp.rejected) } : null,
    cpuAes: typeof raw.cpuAes === "boolean" ? raw.cpuAes : null,
    pprof: normalizePprof(raw.pprof),
    updatedAt: now,
  };
}

function remember<V>(map: Map<number, V>, hostId: number, value: V) {
  if (!map.has(hostId) && map.size >= HOST_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(hostId, value);
}

/** 心跳里收到的 agentRuntime（没有这个字段就什么也不做）。 */
export function recordAgentRuntimeStats(hostId: number, input: unknown, now = Date.now()) {
  const id = Number(hostId);
  if (!(id > 0)) return;
  const stats = normalizeAgentRuntimeStats(input, now);
  if (stats) remember(statsByHost, id, stats);
}

export function getAgentRuntimeStats(hostId: number): AgentRuntimeStats | null {
  return statsByHost.get(Number(hostId)) || null;
}

/** 打开（minutes > 0）或关掉这台主机的性能剖析；立刻叫 Agent 来取指令。返回截止时间（Unix 秒），关掉时为 0。 */
export function setAgentPprof(hostId: number, minutes: number, now = Date.now()): number {
  const id = Number(hostId);
  if (!(id > 0)) return 0;
  if (!(minutes > 0)) {
    pprofUntilByHost.delete(id);
    void wakeAgentExt(id, "pprof");
    return 0;
  }
  const clamped = Math.min(AGENT_PPROF_MAX_MINUTES, Math.max(1, Math.floor(minutes)));
  const until = Math.floor(now / 1000) + clamped * 60;
  remember(pprofUntilByHost, id, until);
  void wakeAgentExt(id, "pprof");
  return until;
}

/** 面板这边记着的截止时间（Unix 秒）；没开或者已经过了为 0。 */
export function agentPprofRequestedUntil(hostId: number, now = Date.now()): number {
  const until = pprofUntilByHost.get(Number(hostId)) || 0;
  if (until > 0 && until * 1000 <= now) {
    pprofUntilByHost.delete(Number(hostId));
    return 0;
  }
  return until;
}

/** 扩展通道里 Agent 报上来的剖析状态（只有新 Agent 才有这个模块）。 */
export function getAgentPprofReport(hostId: number): (AgentRuntimePprof & { reportedAt: number }) | null {
  return pprofReportByHost.get(Number(hostId)) || null;
}

export function agentPprofDirectiveFor(host: AgentExtHost, now = Date.now()) {
  const until = agentPprofRequestedUntil(Number(host.id), now);
  return { enabled: until > 0, until };
}

export function ingestAgentPprofReport(host: AgentExtHost, report: unknown, now = Date.now()) {
  const normalized = normalizePprof(report);
  if (!normalized) return;
  remember(pprofReportByHost, Number(host.id), { ...normalized, reportedAt: now });
}

/** 开着剖析时扩展通道一分钟一轮就够：截止时间 Agent 自己计时。 */
export function agentPprofIntervalFor(host: AgentExtHost, now = Date.now()) {
  return agentPprofRequestedUntil(Number(host.id), now) > 0 ? 60 : undefined;
}

/** 测试用：清掉内存里的状态。 */
export function resetAgentRuntimeStateForTests() {
  statsByHost.clear();
  pprofUntilByHost.clear();
  pprofReportByHost.clear();
}
