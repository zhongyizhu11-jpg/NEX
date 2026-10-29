import crypto from "crypto";

import { RULE_CONNECTIONS_MAX_ROWS, type RuleConnectionRow, type RuleConnectionsSnapshot } from "../shared/ruleConnections";

/*
  「连接」页签的 Agent 任务（task 名 ruleConnections，Agent 2.2.237 起）。

  生命周期照 diagnosticsAgentTasks：queue → take（心跳带走，状态 running）→ complete；
  面板另有总时限，到点没回来记 timeout。结果只在内存里留 5 分钟 —— 这是「此刻」的清单，
  陈了就没意义。

  ⚠ 排着的任务必须让心跳快路径让路（agentHeartbeatRoute 的 hasBlockingWork 里有
  hasQueuedRuleConnectionsTasks），否则配置没变的主机永远拿不到任务。
*/

export type RuleConnectionsAgentTask = {
  taskId: string;
  ruleId: number;
  port: number;
  /** tcp / udp / both */
  protocol: string;
  /** iptables / nftables 这类内核转发：连接不在 /proc/net/tcp 里，要读 conntrack。 */
  dnat: boolean;
  limit: number;
  timeoutMs: number;
  createdAt: string;
};

export type RuleConnectionsTaskState = "queued" | "running" | "done" | "timeout";

export type RuleConnectionsTaskStatus = {
  taskId: string;
  hostId: number;
  ruleId: number;
  status: RuleConnectionsTaskState;
  snapshot: RuleConnectionsSnapshot | null;
  error?: string;
  createdAt: string;
};

type TaskState = RuleConnectionsTaskStatus & { task: RuleConnectionsAgentTask; timer: NodeJS.Timeout };

export const RULE_CONNECTIONS_AGENT_TIMEOUT_MS = 8_000;
export const RULE_CONNECTIONS_PANEL_TIMEOUT_MS = 40_000;
const MAX_ACTIVE_PER_HOST = 3;
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

const queues = new Map<number, RuleConnectionsAgentTask[]>();
const states = new Map<string, TaskState>();

function nowIso() {
  return new Date().toISOString();
}

function toStatus(state: TaskState): RuleConnectionsTaskStatus {
  return {
    taskId: state.taskId,
    hostId: state.hostId,
    ruleId: state.ruleId,
    status: state.status,
    snapshot: state.snapshot,
    ...(state.error ? { error: state.error } : {}),
    createdAt: state.createdAt,
  };
}

function removeFromQueue(hostId: number, taskId: string) {
  const queue = queues.get(hostId);
  if (!queue) return;
  const remaining = queue.filter((task) => task.taskId !== taskId);
  if (remaining.length > 0) queues.set(hostId, remaining);
  else queues.delete(hostId);
}

function scheduleRemoval(taskId: string) {
  const timer = setTimeout(() => states.delete(taskId), TERMINAL_RETENTION_MS);
  timer.unref?.();
}

function markTimeout(taskId: string) {
  const state = states.get(taskId);
  if (!state || state.status === "done" || state.status === "timeout") return;
  state.error = state.status === "queued"
    ? "主机没来取任务（Agent 可能离线，或心跳被卡住）"
    : "Agent 取走了任务，但没在时限内回报";
  state.status = "timeout";
  removeFromQueue(state.hostId, taskId);
  scheduleRemoval(taskId);
}

export function countActiveRuleConnectionsTasks(hostId: number) {
  let count = 0;
  for (const state of states.values()) {
    if (state.hostId === hostId && (state.status === "queued" || state.status === "running")) count += 1;
  }
  return count;
}

export function enqueueRuleConnectionsTask(
  hostId: number,
  input: { ruleId: number; port: number; protocol: string; dnat: boolean },
  panelTimeoutMs = RULE_CONNECTIONS_PANEL_TIMEOUT_MS,
) {
  const id = Number(hostId);
  if (countActiveRuleConnectionsTasks(id) >= MAX_ACTIVE_PER_HOST) {
    throw new Error("这台主机上已有几份连接清单在取，请等它们回来再试");
  }
  const task: RuleConnectionsAgentTask = {
    taskId: crypto.randomUUID(),
    ruleId: Number(input.ruleId),
    port: Number(input.port),
    protocol: String(input.protocol || "tcp"),
    dnat: !!input.dnat,
    limit: RULE_CONNECTIONS_MAX_ROWS,
    timeoutMs: RULE_CONNECTIONS_AGENT_TIMEOUT_MS,
    createdAt: nowIso(),
  };
  const queue = queues.get(id) || [];
  queue.push(task);
  queues.set(id, queue.slice(-10));
  const timer = setTimeout(() => markTimeout(task.taskId), panelTimeoutMs);
  timer.unref?.();
  states.set(task.taskId, { taskId: task.taskId, hostId: id, ruleId: task.ruleId, status: "queued", snapshot: null, createdAt: task.createdAt, task, timer });
  return task;
}

export function takeRuleConnectionsTasks(hostId: number, limit = 4) {
  const id = Number(hostId);
  const queue = queues.get(id) || [];
  const tasks = queue.splice(0, limit);
  if (queue.length > 0) queues.set(id, queue);
  else queues.delete(id);
  const taken: RuleConnectionsAgentTask[] = [];
  for (const task of tasks) {
    const state = states.get(task.taskId);
    if (!state || state.status !== "queued") continue;
    state.status = "running";
    taken.push(task);
  }
  return taken;
}

export function hasQueuedRuleConnectionsTasks(hostId: number) {
  return (queues.get(Number(hostId))?.length || 0) > 0;
}

export function hasRunningRuleConnectionsTasks(hostId: number) {
  const id = Number(hostId);
  for (const state of states.values()) {
    if (state.hostId === id && state.status === "running") return true;
  }
  return false;
}

const ADDRESS_MAX = 64;

function capText(value: unknown, max: number) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function nonNegative(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

/** Agent 回报的清单收敛一遍：行数、字段长度、协议都不信它。 */
export function normalizeRuleConnectionRows(raw: unknown): RuleConnectionRow[] {
  const out: RuleConnectionRow[] = [];
  for (const entry of Array.isArray(raw) ? raw.slice(0, RULE_CONNECTIONS_MAX_ROWS) : []) {
    const peer = capText((entry as any)?.peer, ADDRESS_MAX);
    if (!peer) continue;
    const protocol = String((entry as any)?.protocol || "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
    const bytesIn = nonNegative((entry as any)?.bytesIn);
    const bytesOut = nonNegative((entry as any)?.bytesOut);
    const state = capText((entry as any)?.state, 24);
    out.push({
      protocol,
      peer,
      local: capText((entry as any)?.local, ADDRESS_MAX),
      ...(bytesIn !== undefined ? { bytesIn } : {}),
      ...(bytesOut !== undefined ? { bytesOut } : {}),
      ...(state ? { state } : {}),
    });
  }
  return out;
}

export function completeRuleConnectionsTask(hostId: number, result: {
  taskId: string;
  rows?: unknown;
  total?: unknown;
  truncated?: unknown;
  source?: unknown;
  error?: unknown;
}) {
  const state = states.get(String(result.taskId || ""));
  if (!state || state.hostId !== Number(hostId)) return false;
  if (state.status === "done") return false;
  clearTimeout(state.timer);
  removeFromQueue(state.hostId, state.taskId);
  const rows = normalizeRuleConnectionRows(result.rows);
  const total = Math.max(rows.length, nonNegative(result.total) ?? rows.length);
  state.status = "done";
  state.snapshot = {
    taskId: state.taskId,
    rows,
    total,
    truncated: !!result.truncated || total > rows.length,
    source: capText(result.source, 32) || "proc",
    ...(result.error ? { error: capText(result.error, 300) } : {}),
    at: Date.now(),
  };
  state.error = result.error ? capText(result.error, 300) : undefined;
  scheduleRemoval(state.taskId);
  return true;
}

export function getRuleConnectionsTaskStatus(taskId: string): RuleConnectionsTaskStatus | null {
  const state = states.get(taskId);
  return state ? toStatus(state) : null;
}

export function clearRuleConnectionsTasksForTest() {
  for (const state of states.values()) clearTimeout(state.timer);
  states.clear();
  queues.clear();
}
