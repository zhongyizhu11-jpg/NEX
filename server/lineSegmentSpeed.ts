/*
  线路组的分段测速：一条路径「入口 → 中转 1 → 中转 2 … → 落地」，相邻两台都是面板里的机器
  （都装着 Agent）的那几段，各跑一次 iperf3，找出哪一段是瓶颈。

  每一段怎么测：
    1. 下游那台开 iperf3 服务端（和网络测试页「一键开 iperf3 服务端」同一个任务，
       enqueueIperf3AgentTask，端口由 Agent 自动挑一个空闲的）；
    2. 上游那台当客户端（和网络测试页的「iperf3 客户端」同一个任务，enqueueLookingGlassAgentTask），
       目标是下游的入口地址（getHostEntryAddress），4 条并行、8 秒；
       先测正向（上游 → 下游，就是流量真实的方向），再加 -R 测一次反向 —— 服务端已经开着，
       多 8 秒就能把回程也测了；
    3. 停掉下游的 iperf3 服务端，等 Agent 回报停好了，再测下一段（下一段的上游就是这一台，
       它还开着服务端的话网络测试那边会拒绝跑客户端）。
  段与段一个一个测，不并行：并行会互相抢带宽，测出来的数没意义。

  最后一段（到落地）跳过：落地不是面板管的机器，没法在那头开 iperf3。

  状态只放内存（runId → 进度），面板重启就没了；测完 30 分钟后清掉。

  已知的局限：
  - 走隧道（hopVia）的那一段，iperf3 测的是两台机器之间的直连，不是隧道本身。
  - 测的是机器到机器的带宽，和这条规则此刻的流量无关；测速期间会占满这段带宽。
*/
import crypto from "crypto";
import dns from "dns";
import net from "net";
import { isPrivateOrReservedAddress } from "../shared/ipAddress";
import {
  describeIperf3Failure,
  iperf3EffectiveMbps,
  parseIperf3Mbps,
  slowestSegmentIndex,
  type PlannedLineSegment,
} from "../shared/lineDiagnostics";
import { pushAgentRefresh } from "./agentEvents";
import {
  enqueueIperf3AgentTask,
  getIperf3Status,
  hasActiveIperf3Task,
} from "./iperf3AgentTasks";
import {
  enqueueLookingGlassAgentTask,
  getLookingGlassAgentTaskStatus,
  hasActiveLookingGlassTask,
  normalizeIperf3ClientOptions,
} from "./lookingGlassAgentTasks";

export const SEGMENT_SPEED_SECONDS = 8;
export const SEGMENT_SPEED_STREAMS = 4;
const SERVER_START_TIMEOUT_MS = 45_000;
const SERVER_STOP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 1_000;
const RUN_RETENTION_MS = 30 * 60 * 1000;
const MAX_RUNS = 200;

export type SegmentStatus = "pending" | "running" | "done" | "skipped" | "error";
export type RunStatus = "running" | "done" | "error";

export type SegmentSpeedSegment = {
  from: { hostId: number | null; name: string };
  to: { hostId: number | null; name: string };
  status: SegmentStatus;
  /** 正向（上游 → 下游，流量真实方向）Mbit/s。 */
  mbps: number | null;
  /** 反向（-R，下游 → 上游）Mbit/s；没测出来是 null。 */
  reverseMbps: number | null;
  error: string | null;
};

export type SegmentSpeedRunView = {
  runId: string;
  ruleId: number;
  pathKey: string;
  pathName: string;
  status: RunStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  seconds: number;
  streams: number;
  segments: SegmentSpeedSegment[];
  /** 最慢（瓶颈）那一段的下标；一段都没测出来是 null。 */
  slowest: number | null;
};

type Run = SegmentSpeedRunView & { userId: number };

/** 一段要用到的两头：上游当客户端，下游开服务端、被拨的是它的入口地址。 */
export type SegmentEndpoints = {
  fromHostId: number;
  toHostId: number;
  /** 下游的入口地址（getHostEntryAddress），可能是域名。 */
  toAddress: string;
};

/** 真正给 Agent 派任务的那几步；测试里换成假的。 */
export type SegmentSpeedDeps = {
  startServer: (hostId: number) => Promise<number>;
  stopServer: (hostId: number) => Promise<void>;
  runClient: (input: { hostId: number; target: string; port: number; reverse: boolean; allowPrivate: boolean }) => Promise<string>;
};

const runs = new Map<string, Run>();
const activeRunByRule = new Map<number, string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function viewOf(run: Run): SegmentSpeedRunView {
  const { userId: _userId, ...view } = run;
  return { ...view, segments: run.segments.map((segment) => ({ ...segment, from: { ...segment.from }, to: { ...segment.to } })) };
}

function pruneRuns(now = Date.now()) {
  for (const [runId, run] of runs) {
    if (run.status !== "running" && run.finishedAt && now - run.finishedAt > RUN_RETENTION_MS) runs.delete(runId);
  }
  while (runs.size > MAX_RUNS) {
    const oldest = Array.from(runs.values()).filter((run) => run.status !== "running").sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!oldest) break;
    runs.delete(oldest.runId);
  }
}

// ---------------- 默认实现：直接用网络测试那两个任务队列 ----------------

async function resolveIperf3Target(target: string, allowPrivate: boolean) {
  const value = String(target || "").trim().replace(/^\[|\]$/g, "");
  if (!value) throw new Error("下游机器没有可用的入口地址（IP / 域名），没法测");
  const literal = net.isIP(value);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = literal ? [{ address: value, family: literal }] : await dns.promises.lookup(value, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`下游入口地址 ${value} 解析失败：${errorText(error)}`);
  }
  if (addresses.length === 0) throw new Error(`下游入口地址 ${value} 解析不到 IP`);
  // 普通用户不能拿 Agent 去打内网（和网络测试页同一条规矩）；管理员的中转机之间走内网是常见配置，放行。
  if (!allowPrivate) {
    const blocked = addresses.find((entry) => isPrivateOrReservedAddress(entry.address));
    if (blocked) throw new Error(`下游入口地址解析到内网或保留地址（${blocked.address}），普通用户不能对它测速`);
  }
  return { host: value, address: addresses[0].address, family: addresses[0].family, addresses: addresses.map((entry) => entry.address) };
}

export const defaultSegmentSpeedDeps: SegmentSpeedDeps = {
  async startServer(hostId) {
    if (hasActiveLookingGlassTask(hostId)) throw new Error("下游机器上正有网络测试在跑，等它结束再测");
    if (hasActiveIperf3Task(hostId)) throw new Error("下游机器上已经开着 iperf3 服务端（可能是网络测试页开的），先停掉再测");
    const { task } = enqueueIperf3AgentTask(hostId, { op: "start" }, SERVER_START_TIMEOUT_MS);
    pushAgentRefresh(hostId, "iperf3-start");
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS + 2_000;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const status = getIperf3Status(hostId);
      if (status.taskId && status.taskId !== task.taskId) throw new Error("下游机器的 iperf3 服务端被别的操作接管了，这一段没测成");
      if (status.state === "running" && Number(status.port) > 0) return Number(status.port);
      if (status.state === "error" || status.state === "stopped") {
        throw new Error(describeIperf3Failure(`${status.output || ""}\n${status.error || ""}`));
      }
    }
    throw new Error("下游机器的 Agent 没在时限内启动 iperf3 服务端（Agent 离线或版本太旧）");
  },

  async stopServer(hostId) {
    const current = getIperf3Status(hostId);
    if (current.state === "idle" || current.state === "stopped" || current.state === "error") return;
    try {
      enqueueIperf3AgentTask(hostId, { op: "stop", port: current.port }, SERVER_STOP_TIMEOUT_MS);
      pushAgentRefresh(hostId, "iperf3-stop");
    } catch {
      // 已有任务在处理（启动 / 停止中）：下面照样等它落定。
    }
    const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS + 2_000;
    while (Date.now() < deadline && hasActiveIperf3Task(hostId)) await sleep(POLL_INTERVAL_MS);
  },

  async runClient({ hostId, target, port, reverse, allowPrivate }) {
    if (hasActiveIperf3Task(hostId)) throw new Error("上游机器上开着 iperf3 服务端，先停掉再测");
    if (hasActiveLookingGlassTask(hostId)) throw new Error("上游机器上正有网络测试在跑，等它结束再测");
    const resolved = await resolveIperf3Target(target, allowPrivate);
    const options = normalizeIperf3ClientOptions({ streams: SEGMENT_SPEED_STREAMS, seconds: SEGMENT_SPEED_SECONDS, reverse });
    const { task } = enqueueLookingGlassAgentTask(hostId, {
      method: "iperf3-client",
      target: resolved.host,
      resolvedAddress: resolved.address,
      resolvedAddresses: resolved.addresses,
      family: resolved.family,
      port,
      reverse: options.reverse,
      streams: options.streams,
      seconds: options.seconds,
    }, options.timeoutMs);
    pushAgentRefresh(hostId, "looking-glass");
    const deadline = Date.now() + options.timeoutMs + 5_000;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const status = getLookingGlassAgentTaskStatus(hostId, task.taskId);
      if (!status) throw new Error("测速任务已过期");
      if (status.status === "success") return status.output;
      if (status.status === "error" || status.status === "timeout") {
        // 有些 Agent 退出码非 0 但汇总已经打出来了，能读出数就用。
        if (iperf3EffectiveMbps(parseIperf3Mbps(status.output)) !== null) return status.output;
        throw new Error(describeIperf3Failure(`${status.output || ""}\n${status.error || ""}`));
      }
    }
    throw new Error("上游机器的 Agent 没在时限内回报 iperf3 结果（Agent 离线或版本太旧）");
  },
};

// ---------------- 跑一轮 ----------------

async function runSegments(run: Run, endpoints: Array<SegmentEndpoints | null>, deps: SegmentSpeedDeps, allowPrivate: boolean) {
  for (let index = 0; index < run.segments.length; index += 1) {
    const segment = run.segments[index];
    const ends = endpoints[index];
    if (segment.status === "skipped" || !ends) continue;
    segment.status = "running";
    try {
      const port = await deps.startServer(ends.toHostId);
      try {
        const forward = parseIperf3Mbps(await deps.runClient({ hostId: ends.fromHostId, target: ends.toAddress, port, reverse: false, allowPrivate }));
        const mbps = iperf3EffectiveMbps(forward);
        if (mbps === null) throw new Error("iperf3 跑完了，但输出里没有汇总带宽");
        segment.mbps = mbps;
        try {
          segment.reverseMbps = iperf3EffectiveMbps(parseIperf3Mbps(await deps.runClient({ hostId: ends.fromHostId, target: ends.toAddress, port, reverse: true, allowPrivate })));
        } catch {
          // 反向没测成不算这一段失败：正向（流量方向）已经有数了。
          segment.reverseMbps = null;
        }
      } finally {
        await deps.stopServer(ends.toHostId).catch(() => undefined);
      }
      segment.status = "done";
    } catch (error) {
      segment.status = "error";
      segment.error = errorText(error);
    }
  }
}

function finish(run: Run) {
  const tested = run.segments.filter((segment) => segment.status !== "skipped");
  const allFailed = tested.length > 0 && tested.every((segment) => segment.status === "error");
  run.status = allFailed ? "error" : "done";
  if (allFailed && !run.error) run.error = tested[0].error || "每一段都没测成";
  run.slowest = slowestSegmentIndex(run.segments);
  run.finishedAt = Date.now();
}

/**
 * 开一轮分段测速，立刻返回 runId，后台一段一段测；进度用 getSegmentSpeedRun 看。
 *
 * plan 是 planLineSegments 的结果；endpoints 与 plan 等长，能测的段给两头的主机和下游地址，
 * 不能测的给 null（会标成 skipped，原因用 plan 的 skipReason）。
 */
export function startSegmentSpeedRun(input: {
  ruleId: number;
  pathKey: string;
  pathName: string;
  userId: number;
  allowPrivate: boolean;
  plan: readonly PlannedLineSegment[];
  endpoints: ReadonlyArray<SegmentEndpoints | null>;
  deps?: SegmentSpeedDeps;
}) {
  pruneRuns();
  const activeId = activeRunByRule.get(input.ruleId);
  if (activeId && runs.get(activeId)?.status === "running") {
    throw new Error("这条线路正在分段测速，等这一轮测完再开");
  }
  const run: Run = {
    runId: crypto.randomUUID(),
    ruleId: input.ruleId,
    pathKey: input.pathKey,
    pathName: input.pathName,
    userId: input.userId,
    status: "running",
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    seconds: SEGMENT_SPEED_SECONDS,
    streams: SEGMENT_SPEED_STREAMS,
    segments: input.plan.map((segment, index) => {
      const skipReason = segment.skipReason || (input.endpoints[index] ? null : "这一段测不了");
      return {
        from: { ...segment.from },
        to: { ...segment.to },
        status: skipReason ? "skipped" : "pending",
        mbps: null,
        reverseMbps: null,
        error: skipReason,
      };
    }),
    slowest: null,
  };
  runs.set(run.runId, run);
  activeRunByRule.set(input.ruleId, run.runId);
  const done = runSegments(run, [...input.endpoints], input.deps || defaultSegmentSpeedDeps, input.allowPrivate)
    .catch((error) => {
      run.error = errorText(error);
    })
    .finally(() => {
      finish(run);
      if (activeRunByRule.get(input.ruleId) === run.runId) activeRunByRule.delete(input.ruleId);
    });
  return { runId: run.runId, view: viewOf(run), done };
}

/** 读一轮的进度；不是自己开的（管理员除外）当作不存在。 */
export function getSegmentSpeedRun(runId: string, user: { id: number; role: string }): SegmentSpeedRunView | null {
  const run = runs.get(runId);
  if (!run) return null;
  if (user.role !== "admin" && run.userId !== Number(user.id)) return null;
  return viewOf(run);
}

export function resetSegmentSpeedRunsForTest() {
  runs.clear();
  activeRunByRule.clear();
}
