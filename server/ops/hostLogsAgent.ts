/*
  扩展模块 "logs"（面板 2.3.451、Agent 2.2.230 起）：主机详情里看实时日志，不用 SSH。

  - 只有管理员能看；来源是 Agent 那头的白名单（agent / runtime / tunnel / nginx / kernel /
    fxp:<文件名>），Agent 会把可用的来源列表每分钟报一次。
  - 有人开着日志窗口（30 秒内拉过一次）时，每轮扩展通道下发一次「读游标之后的新行」，Agent 读完
    马上再跑一轮把结果报回来；扩展通道这时 5 秒一轮。没人看了就不再下发，Agent 回到默认节奏。
  - 同一来源同时只有一个请求在路上（inflight），结果回来才发下一个：游标不会被同一段读两遍。
  - 读到的行放在内存里，每个（主机, 来源）最多留 2000 行；面板重启就没了，重新打开窗口会再拉最近的。
*/
import { randomBytes } from "node:crypto";
import { isAgentVersionAtLeast } from "../../shared/version";
import { registerAgentExtModule, wakeAgentExt, type AgentExtHost } from "./agentExt";

export const HOST_LOGS_MIN_AGENT_VERSION = "2.2.230";
const VIEWER_TTL_MS = 30_000;
const INFLIGHT_TIMEOUT_MS = 20_000;
const MAX_BUFFER_LINES = 2_000;
const MAX_WATCHES = 200;
const SOURCE_PATTERN = /^(agent|runtime|tunnel|nginx|kernel|fxp:fxp-[A-Za-z0-9._-]{1,120}\.log)$/;

export type HostLogLine = { seq: number; text: string };

type LogWatch = {
  id: string;
  hostId: number;
  source: string;
  cursor: string;
  lines: HostLogLine[];
  nextSeq: number;
  lastViewedAt: number;
  inflightAt: number | null;
  lastResultAt: number | null;
  error: string | null;
};

const watches = new Map<string, LogWatch>();
const hostSources = new Map<number, { sources: string[]; at: number }>();

function watchKey(hostId: number, source: string) {
  return `${hostId}|${source}`;
}

export function isValidHostLogSource(source: string) {
  return SOURCE_PATTERN.test(source);
}

export function hostSupportsLogs(host: { agentVersion?: string | null } | null | undefined) {
  return !!host && isAgentVersionAtLeast(String(host.agentVersion || ""), HOST_LOGS_MIN_AGENT_VERSION);
}

function isActive(watch: LogWatch, now: number) {
  return now - watch.lastViewedAt < VIEWER_TTL_MS;
}

function pruneWatches(now: number) {
  for (const [key, watch] of watches) {
    // 没人看超过 10 分钟的整个丢掉（缓冲也一起）。
    if (now - watch.lastViewedAt > 10 * 60_000) watches.delete(key);
  }
  while (watches.size > MAX_WATCHES) {
    const oldest = watches.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    watches.delete(oldest);
  }
}

function appendLines(watch: LogWatch, texts: string[]) {
  for (const text of texts) {
    watch.lines.push({ seq: watch.nextSeq, text });
    watch.nextSeq += 1;
  }
  if (watch.lines.length > MAX_BUFFER_LINES) watch.lines.splice(0, watch.lines.length - MAX_BUFFER_LINES);
}

/**
 * 浏览器每隔一两秒调一次：登记「有人在看」，返回 afterSeq 之后的新行。第一次打开某个来源时
 * 叫醒 Agent，几秒内就有最近的那段日志。
 */
export function pollHostLogs(hostId: number, source: string, afterSeq: number, now = Date.now()) {
  pruneWatches(now);
  const key = watchKey(hostId, source);
  let watch = watches.get(key);
  const isNew = !watch;
  if (!watch) {
    watch = {
      id: `logs-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
      hostId,
      source,
      cursor: "",
      lines: [],
      nextSeq: 1,
      lastViewedAt: now,
      inflightAt: null,
      lastResultAt: null,
      error: null,
    };
    watches.set(key, watch);
  }
  const wasIdle = !isActive(watch, now);
  watch.lastViewedAt = now;
  if (isNew || wasIdle) void wakeAgentExt(hostId, "logs");
  const after = Number.isFinite(afterSeq) ? afterSeq : 0;
  const lines = watch.lines.filter((line) => line.seq > after);
  return {
    source,
    lines,
    nextSeq: watch.nextSeq - 1,
    // 缓冲里最早一行比 afterSeq + 1 还新：中间有一段被挤掉了。
    gap: after > 0 && watch.lines.length > 0 && watch.lines[0].seq > after + 1,
    waiting: watch.lastResultAt === null,
    lastResultAt: watch.lastResultAt,
    error: watch.error,
    sources: hostSources.get(hostId)?.sources ?? null,
  };
}

export function hostLogSources(hostId: number) {
  return hostSources.get(hostId)?.sources ?? null;
}

function directiveFor(host: AgentExtHost) {
  const hostId = Number(host.id);
  const now = Date.now();
  const requests: Array<{ id: string; source: string; cursor: string; lines: number }> = [];
  for (const watch of watches.values()) {
    if (watch.hostId !== hostId || !isActive(watch, now)) continue;
    if (watch.inflightAt !== null && now - watch.inflightAt < INFLIGHT_TIMEOUT_MS) continue;
    watch.inflightAt = now;
    requests.push({ id: watch.id, source: watch.source, cursor: watch.cursor, lines: watch.cursor ? 500 : 200 });
    if (requests.length >= 4) break;
  }
  return requests.length > 0 ? { requests } : undefined;
}

/** Agent 报上来的这一轮：来源列表、读到的行。 */
export function ingestHostLogsReport(host: AgentExtHost, report: unknown, now = Date.now()) {
  const hostId = Number(host.id);
  if (!report || typeof report !== "object") return;
  const body = report as { sources?: unknown; results?: unknown };
  if (Array.isArray(body.sources)) {
    const sources = body.sources.map(String).filter(isValidHostLogSource).slice(0, 80);
    hostSources.set(hostId, { sources, at: now });
  }
  if (!Array.isArray(body.results)) return;
  for (const raw of body.results.slice(0, 16)) {
    if (!raw || typeof raw !== "object") continue;
    const result = raw as { id?: unknown; source?: unknown; cursor?: unknown; lines?: unknown; reset?: unknown; truncated?: unknown; error?: unknown };
    const source = String(result.source || "");
    const watch = watches.get(watchKey(hostId, source));
    if (!watch || watch.id !== String(result.id || "")) continue;
    watch.inflightAt = null;
    watch.lastResultAt = now;
    watch.error = result.error ? String(result.error).slice(0, 200) : null;
    if (typeof result.cursor === "string" && result.cursor.length <= 1024) watch.cursor = result.cursor;
    const lines = Array.isArray(result.lines) ? result.lines.slice(0, 600).map((line) => String(line).slice(0, 2100)) : [];
    if (result.reset === true && watch.lines.length > 0) appendLines(watch, ["—— 日志文件被截短，从新的末尾继续 ——"]);
    if (result.truncated === true) appendLines(watch, ["—— 这段时间日志太多，中间省略了一部分 ——"]);
    appendLines(watch, lines);
  }
}

function hasActiveWatch(hostId: number) {
  const now = Date.now();
  for (const watch of watches.values()) if (watch.hostId === hostId && isActive(watch, now)) return true;
  return false;
}

registerAgentExtModule({
  name: "logs",
  directive: directiveFor,
  ingest: ingestHostLogsReport,
  intervalSeconds: (host) => (hasActiveWatch(Number(host.id)) ? 5 : undefined),
});

/** 只给测试用。 */
export function resetHostLogsStateForTest() {
  watches.clear();
  hostSources.clear();
}

export const __test = { directiveFor };
