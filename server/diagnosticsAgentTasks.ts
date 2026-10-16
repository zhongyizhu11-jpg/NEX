import crypto from "crypto";

/*
  一键链路诊断的 Agent 任务（task 名 diagnostics，Agent 2.2.225 起）。

  一次诊断给涉及的每台主机各排一个任务，任务里是这台主机要做的几项检查（端口在不在听、
  防火墙、回环连通、DNS、拨目标、进程活着没有）。任务跟着下一次心跳下去（heartbeat 的
  diagnosticsTasks），Agent 并发跑完，整包 POST /api/agent/diagnostics-result 回来。

  生命周期照 lookingGlassAgentTasks：queue → take（心跳带走，状态 running）→ complete；
  面板这边另有一个总时限，到点没回来就记 timeout。结果只在内存里留 15 分钟。

  ⚠ 排着的任务必须让心跳快路径让路（agentHeartbeatRoute 的 hasBlockingWork 里有
  hasQueuedDiagnosticsAgentTasks），否则配置没变的主机永远拿不到任务。
*/

export type DiagnosticsAgentCheckKind = "listen" | "nat" | "firewall" | "loopback" | "dns" | "dial" | "process";
export type DiagnosticsAgentCheckStatus = "pass" | "warn" | "fail" | "skip";

export type DiagnosticsAgentCheck = {
  /** 面板起的编号，Agent 原样带回。 */
  id: string;
  kind: DiagnosticsAgentCheckKind;
  port?: number;
  /** tcp / udp / both；any = 任一种在听就算（隧道监听口）。 */
  protocol?: "tcp" | "udp" | "both" | "any";
  /** dns / dial 的目标。 */
  host?: string;
  /** loopback：顺带从本机连一下自己的公网 IP。 */
  publicIp?: string;
  /** process：realm / socat / gost / nginx / fxp / tunnel。 */
  forwardType?: string;
  tunnelId?: number;
};

export type DiagnosticsAgentCheckResult = {
  id: string;
  kind: DiagnosticsAgentCheckKind;
  status: DiagnosticsAgentCheckStatus;
  summary: string;
  detail?: string;
  latencyMs?: number;
};

export type DiagnosticsAgentTask = {
  taskId: string;
  checks: DiagnosticsAgentCheck[];
  /** Agent 端整包的时限（毫秒），Agent 自己再封顶 30 秒。 */
  timeoutMs: number;
  createdAt: string;
};

export type DiagnosticsTaskState = "queued" | "running" | "done" | "timeout";

export type DiagnosticsTaskStatus = {
  taskId: string;
  hostId: number;
  status: DiagnosticsTaskState;
  results: DiagnosticsAgentCheckResult[];
  error?: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

type TaskState = DiagnosticsTaskStatus & { task: DiagnosticsAgentTask; timer: NodeJS.Timeout };

/** Agent 那边整包 ≤ 30 秒。 */
export const DIAGNOSTICS_AGENT_TASK_TIMEOUT_MS = 25_000;
/** 面板等多久：Agent 等下一次心跳取任务 + 跑 + 回报。 */
export const DIAGNOSTICS_PANEL_TIMEOUT_MS = 60_000;
export const DIAGNOSTICS_MAX_ACTIVE_PER_HOST = 3;
export const DIAGNOSTICS_MAX_CHECKS = 48;
const TERMINAL_RETENTION_MS = 15 * 60 * 1000;
const RESULT_TEXT_MAX = 4000;

const queues = new Map<number, DiagnosticsAgentTask[]>();
const states = new Map<string, TaskState>();

function nowIso() {
  return new Date().toISOString();
}

function toStatus(state: TaskState): DiagnosticsTaskStatus {
  return {
    taskId: state.taskId,
    hostId: state.hostId,
    status: state.status,
    results: state.results,
    ...(state.error ? { error: state.error } : {}),
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    durationMs: state.durationMs,
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
  const finishedAt = nowIso();
  state.error = state.status === "queued"
    ? "主机没来取诊断任务（Agent 可能离线，或心跳被卡住）"
    : "Agent 取走了诊断任务，但没在时限内回报";
  state.status = "timeout";
  state.finishedAt = finishedAt;
  removeFromQueue(state.hostId, taskId);
  scheduleRemoval(taskId);
}

export function countActiveDiagnosticsTasks(hostId: number) {
  let count = 0;
  for (const state of states.values()) {
    if (state.hostId === hostId && (state.status === "queued" || state.status === "running")) count += 1;
  }
  return count;
}

export function enqueueDiagnosticsAgentTask(
  hostId: number,
  checks: DiagnosticsAgentCheck[],
  panelTimeoutMs = DIAGNOSTICS_PANEL_TIMEOUT_MS,
) {
  const id = Number(hostId);
  if (countActiveDiagnosticsTasks(id) >= DIAGNOSTICS_MAX_ACTIVE_PER_HOST) {
    throw new Error("这台主机上已有几轮诊断在跑，请等它们结束再试");
  }
  const task: DiagnosticsAgentTask = {
    taskId: crypto.randomUUID(),
    checks: checks.slice(0, DIAGNOSTICS_MAX_CHECKS),
    timeoutMs: DIAGNOSTICS_AGENT_TASK_TIMEOUT_MS,
    createdAt: nowIso(),
  };
  const queue = queues.get(id) || [];
  queue.push(task);
  queues.set(id, queue.slice(-20));
  const timer = setTimeout(() => markTimeout(task.taskId), panelTimeoutMs);
  timer.unref?.();
  states.set(task.taskId, {
    taskId: task.taskId,
    hostId: id,
    status: "queued",
    results: [],
    createdAt: task.createdAt,
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
    task,
    timer,
  });
  return task;
}

/** 心跳带走排着的任务，状态改成 running。 */
export function takeDiagnosticsAgentTasks(hostId: number, limit = 4) {
  const id = Number(hostId);
  const queue = queues.get(id) || [];
  const tasks = queue.splice(0, limit);
  if (queue.length > 0) queues.set(id, queue);
  else queues.delete(id);
  const startedAt = nowIso();
  const taken: DiagnosticsAgentTask[] = [];
  for (const task of tasks) {
    const state = states.get(task.taskId);
    if (!state || state.status !== "queued") continue;
    state.status = "running";
    state.startedAt = startedAt;
    taken.push(task);
  }
  return taken;
}

export function hasQueuedDiagnosticsAgentTasks(hostId: number) {
  return (queues.get(Number(hostId))?.length || 0) > 0;
}

/** 跑着的任务（已取走、没回来）也让心跳勤一点，结果早一点到。 */
export function hasRunningDiagnosticsAgentTasks(hostId: number) {
  const id = Number(hostId);
  for (const state of states.values()) {
    if (state.hostId === id && state.status === "running") return true;
  }
  return false;
}

const VALID_KINDS = new Set<DiagnosticsAgentCheckKind>(["listen", "nat", "firewall", "loopback", "dns", "dial", "process"]);
const VALID_STATUSES = new Set<DiagnosticsAgentCheckStatus>(["pass", "warn", "fail", "skip"]);

function capText(value: unknown, max = RESULT_TEXT_MAX) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/**
 * Agent 回报的结果只收面板这次发下去的那几项（按 id 对），状态、长度都收敛一遍 ——
 * 回报的 Agent 可能是坏的，也可能是别人伪造的。
 */
export function normalizeDiagnosticsResults(task: DiagnosticsAgentTask, raw: unknown): DiagnosticsAgentCheckResult[] {
  const expected = new Map(task.checks.map((check) => [check.id, check] as const));
  const out: DiagnosticsAgentCheckResult[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = String((entry as any)?.id || "");
    const check = expected.get(id);
    if (!check || seen.has(id)) continue;
    seen.add(id);
    const status = String((entry as any)?.status || "") as DiagnosticsAgentCheckStatus;
    const kind = String((entry as any)?.kind || check.kind) as DiagnosticsAgentCheckKind;
    const latency = Number((entry as any)?.latencyMs);
    out.push({
      id,
      kind: VALID_KINDS.has(kind) ? kind : check.kind,
      status: VALID_STATUSES.has(status) ? status : "warn",
      summary: capText((entry as any)?.summary || "Agent 没有给出结论", 300),
      ...((entry as any)?.detail ? { detail: capText((entry as any).detail) } : {}),
      ...(Number.isFinite(latency) && latency >= 0 ? { latencyMs: Math.round(latency) } : {}),
    });
  }
  return out;
}

export function completeDiagnosticsAgentTask(hostId: number, result: {
  taskId: string;
  results?: unknown;
  error?: unknown;
  durationMs?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
}) {
  const state = states.get(String(result.taskId || ""));
  if (!state || state.hostId !== Number(hostId)) return false;
  if (state.status === "done") return false;
  clearTimeout(state.timer);
  removeFromQueue(state.hostId, state.taskId);
  const finishedAt = nowIso();
  state.status = "done";
  state.results = normalizeDiagnosticsResults(state.task, result.results);
  state.error = result.error ? capText(result.error, 300) : undefined;
  state.durationMs = Math.max(0, Math.round(Number(result.durationMs) || 0));
  state.startedAt = String(result.startedAt || state.startedAt || finishedAt);
  state.finishedAt = String(result.finishedAt || finishedAt);
  scheduleRemoval(state.taskId);
  return true;
}

export function getDiagnosticsTaskStatus(taskId: string): DiagnosticsTaskStatus | null {
  const state = states.get(taskId);
  return state ? toStatus(state) : null;
}

export function clearDiagnosticsAgentTasksForTest() {
  for (const state of states.values()) clearTimeout(state.timer);
  states.clear();
  queues.clear();
}
