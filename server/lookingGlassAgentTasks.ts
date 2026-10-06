import crypto from "crypto";

export type LookingGlassMethod = "ping" | "ping6" | "traceroute" | "traceroute6" | "mtr" | "mtr6" | "tcp" | "iperf3-client";
export type LookingGlassTaskState = "queued" | "running" | "success" | "error" | "timeout";

export type LookingGlassAgentTask = {
  taskId: string;
  method: LookingGlassMethod;
  target: string;
  resolvedAddress: string;
  resolvedAddresses: string[];
  family: number;
  port?: number;
  /** iperf3 客户端：反向（-R，测目标 → 本机）、并行连接数（-P）、时长秒（-t）。 */
  reverse?: boolean;
  streams?: number;
  seconds?: number;
  /** UDP 模式（-u）：按固定速率灌包测链路的限速点；udpMbps 是每条流的速率，0 = 不限。 */
  udp?: boolean;
  udpMbps?: number;
  createdAt: string;
};

/*
  iperf3 客户端测试的参数边界。

  并行连接数封到 16：再多对测出带宽没帮助，只是在对端服务端上多占线程。
  时长封到 30 秒：一次任务独占这台 Agent 的网络测试槽位，也独占对端那个
  iperf3 服务端（它空闲 3 分钟就自动停），长测用命令行自己跑。
*/
export const IPERF3_CLIENT_DEFAULT_STREAMS = 4;
export const IPERF3_CLIENT_MAX_STREAMS = 16;
export const IPERF3_CLIENT_DEFAULT_SECONDS = 10;
export const IPERF3_CLIENT_MIN_SECONDS = 5;
export const IPERF3_CLIENT_MAX_SECONDS = 30;
/** Agent 拉任务、建连、跑完再回报，都算在这段宽限里。 */
export const IPERF3_CLIENT_TIMEOUT_GRACE_MS = 45_000;

/** UDP 每条流的速率上限（Mbit/s）；0 = 不限（iperf3 的 -b 0）。 */
export const IPERF3_CLIENT_UDP_MAX_MBPS = 100_000;

export type Iperf3ClientOptions = {
  reverse: boolean;
  streams: number;
  seconds: number;
  udp: boolean;
  udpMbps: number;
  /** 面板侧给这个任务的总时限（毫秒）。 */
  timeoutMs: number;
};

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 把界面传来的 iperf3 客户端参数收敛到边界内；没填的用默认值。 */
export function normalizeIperf3ClientOptions(
  input: { reverse?: unknown; streams?: unknown; seconds?: unknown; udp?: unknown; udpMbps?: unknown } = {},
): Iperf3ClientOptions {
  const streams = clampInt(input.streams, 1, IPERF3_CLIENT_MAX_STREAMS, IPERF3_CLIENT_DEFAULT_STREAMS);
  const seconds = clampInt(input.seconds, IPERF3_CLIENT_MIN_SECONDS, IPERF3_CLIENT_MAX_SECONDS, IPERF3_CLIENT_DEFAULT_SECONDS);
  const udp = input.udp === true;
  return {
    reverse: input.reverse === true,
    streams,
    seconds,
    udp,
    udpMbps: udp ? clampInt(input.udpMbps, 0, IPERF3_CLIENT_UDP_MAX_MBPS, 0) : 0,
    timeoutMs: seconds * 1000 + IPERF3_CLIENT_TIMEOUT_GRACE_MS,
  };
}

export type LookingGlassAgentResult = {
  taskId: string;
  method: LookingGlassMethod;
  target: string;
  port?: number;
  resolvedAddress: string;
  resolvedAddresses: string[];
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
};

export type LookingGlassTaskStatus = LookingGlassAgentResult & {
  status: LookingGlassTaskState;
  createdAt: string;
  updatedAt: string;
};

type TaskState = {
  hostId: number;
  task: LookingGlassAgentTask;
  status: LookingGlassTaskState;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  updatedAt: string;
  error?: string;
  timer: NodeJS.Timeout;
};

const queues = new Map<number, LookingGlassAgentTask[]>();
const states = new Map<string, TaskState>();

const TERMINAL_STATES = new Set<LookingGlassTaskState>(["success", "error", "timeout"]);
const TERMINAL_STATE_RETENTION_MS = 15 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function toStatus(state: TaskState): LookingGlassTaskStatus {
  return {
    taskId: state.task.taskId,
    method: state.task.method,
    target: state.task.target,
    port: state.task.port,
    resolvedAddress: state.task.resolvedAddress,
    resolvedAddresses: state.task.resolvedAddresses,
    output: state.output,
    exitCode: state.exitCode,
    timedOut: state.timedOut,
    durationMs: state.durationMs,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    error: state.error,
    status: state.status,
    createdAt: state.task.createdAt,
    updatedAt: state.updatedAt,
  };
}

function markTimeout(taskId: string) {
  const state = states.get(taskId);
  if (!state || TERMINAL_STATES.has(state.status)) return;
  const finishedAt = nowIso();
  state.status = "timeout";
  state.timedOut = true;
  state.exitCode = 1;
  state.finishedAt = finishedAt;
  state.updatedAt = finishedAt;
  state.error = "Agent 执行网络测试超时，请确认目标主机在线";
  state.output = `${state.output ? `${state.output}\n` : ""}${state.error}`;
  const queue = queues.get(state.hostId);
  if (queue) {
    const remaining = queue.filter((task) => task.taskId !== taskId);
    if (remaining.length > 0) queues.set(state.hostId, remaining);
    else queues.delete(state.hostId);
  }
  scheduleTerminalStateRemoval(taskId);
}

function scheduleTerminalStateRemoval(taskId: string) {
  const scheduledUpdatedAt = states.get(taskId)?.updatedAt;
  const timer = setTimeout(() => {
    const state = states.get(taskId);
    if (!state || !TERMINAL_STATES.has(state.status) || state.updatedAt !== scheduledUpdatedAt) return;
    states.delete(taskId);
  }, TERMINAL_STATE_RETENTION_MS);
  timer.unref?.();
}

export function pruneLookingGlassAgentTaskStates(now = Date.now()) {
  let deleted = 0;
  for (const [taskId, state] of states) {
    if (!TERMINAL_STATES.has(state.status)) continue;
    const updatedAt = new Date(state.updatedAt).getTime();
    if (!Number.isFinite(updatedAt) || now - updatedAt < TERMINAL_STATE_RETENTION_MS) continue;
    states.delete(taskId);
    deleted += 1;
  }
  return deleted;
}

export function enqueueLookingGlassAgentTask(
  hostId: number,
  input: Omit<LookingGlassAgentTask, "taskId" | "createdAt">,
  timeoutMs = 60_000,
) {
  if (hasActiveLookingGlassTask(hostId)) {
    throw new Error("该测试主机已有网络测试正在执行，请等待完成后再开始新的测试");
  }
  const task: LookingGlassAgentTask = {
    ...input,
    taskId: crypto.randomUUID(),
    createdAt: nowIso(),
  };
  const queue = queues.get(hostId) || [];
  queue.push(task);
  queues.set(hostId, queue.slice(-20));

  const timer = setTimeout(() => markTimeout(task.taskId), timeoutMs);
  timer.unref?.();
  const state: TaskState = {
    hostId,
    task,
    status: "queued",
    output: "任务已创建，等待 Agent 拉取执行...",
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    startedAt: task.createdAt,
    finishedAt: "",
    updatedAt: task.createdAt,
    timer,
  };
  states.set(task.taskId, state);

  return { task, status: toStatus(state) };
}

export function takeLookingGlassAgentTasks(hostId: number, limit = 1) {
  const queue = queues.get(hostId) || [];
  const tasks = queue.splice(0, limit);
  if (queue.length > 0) queues.set(hostId, queue);
  else queues.delete(hostId);
  for (const task of tasks) {
    const state = states.get(task.taskId);
    if (!state || TERMINAL_STATES.has(state.status)) continue;
    const startedAt = nowIso();
    state.status = "running";
    state.startedAt = startedAt;
    state.updatedAt = startedAt;
    state.output = "Agent 已拉取任务，正在启动测试命令...";
  }
  return tasks;
}

export function hasQueuedLookingGlassAgentTasks(hostId: number) {
  return (queues.get(Number(hostId))?.length || 0) > 0;
}

// Agent 回报的输出原样留在内存里、再原样发给浏览器。上限按字节截断，
// 否则一个异常（或被控制）的 Agent 回报几十 MB 就能把面板内存和前端都拖垮。
export const LOOKING_GLASS_OUTPUT_MAX_BYTES = 256 * 1024;

export function capLookingGlassOutput(value: unknown) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= LOOKING_GLASS_OUTPUT_MAX_BYTES) return text;
  const head = Buffer.from(text, "utf8").subarray(0, LOOKING_GLASS_OUTPUT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
  return `${head}\n...（输出超过 ${LOOKING_GLASS_OUTPUT_MAX_BYTES / 1024} KiB，已截断）`;
}

export function updateLookingGlassAgentTaskProgress(
  hostId: number,
  result: Partial<LookingGlassAgentResult> & { taskId: string },
) {
  const state = states.get(result.taskId);
  if (!state || state.hostId !== hostId || TERMINAL_STATES.has(state.status)) return false;
  const updatedAt = nowIso();
  state.status = "running";
  state.output = capLookingGlassOutput(result.output ?? state.output);
  state.durationMs = Number(result.durationMs ?? state.durationMs) || 0;
  state.startedAt = String(result.startedAt || state.startedAt || updatedAt);
  state.updatedAt = updatedAt;
  if (result.error) state.error = String(result.error);
  return true;
}

export function completeLookingGlassAgentTask(hostId: number, result: LookingGlassAgentResult) {
  const state = states.get(result.taskId);
  if (!state || state.hostId !== hostId) return false;
  clearTimeout(state.timer);
  const updatedAt = nowIso();
  state.status = result.timedOut ? "timeout" : result.exitCode === 0 ? "success" : "error";
  state.output = capLookingGlassOutput(result.output || "");
  state.exitCode = result.exitCode === undefined ? null : result.exitCode;
  state.timedOut = !!result.timedOut;
  state.durationMs = Number(result.durationMs || 0);
  state.startedAt = String(result.startedAt || state.startedAt || updatedAt);
  state.finishedAt = String(result.finishedAt || updatedAt);
  state.updatedAt = updatedAt;
  state.error = result.error;
  scheduleTerminalStateRemoval(result.taskId);
  return true;
}

export function getLookingGlassAgentTaskStatus(hostId: number, taskId: string) {
  const state = states.get(taskId);
  if (!state || state.hostId !== hostId) return null;
  return toStatus(state);
}

export function hasActiveLookingGlassTask(hostId: number) {
  for (const state of states.values()) {
    if (state.hostId === hostId && !TERMINAL_STATES.has(state.status)) return true;
  }
  return false;
}

const stateCleanupTimer = setInterval(() => pruneLookingGlassAgentTaskStates(), 60 * 1000);
stateCleanupTimer.unref?.();
