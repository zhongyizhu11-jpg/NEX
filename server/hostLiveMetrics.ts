import { sendAgentEvent } from "./agentEvents";
import { isAgentVersionAtLeast } from "../shared/version";

/*
  主机指标「实时」（面板 2.3.444 / Agent 2.2.225）。

  以前主机页的 CPU / 内存 / 磁盘和上下行速度靠心跳带上来：有人在看时 3 秒一次，进库，前端 3 秒
  （手机 5 秒）拉一次，速度用库里最近两条相减 —— 看起来总是慢半拍。现在两档：

  - 主机列表在看：心跳降到 2 秒（AGENT_METRICS_WATCH_INTERVAL_SECONDS，旧 Agent 也吃这个）。
  - 打开了某台主机的详情（focus）：经 Agent 事件流发 agent-live-metrics，2.2.225 起的 Agent 起一个
    小循环，每秒 POST /api/agent/live-metrics 一份指标（不进库，只放这里的内存），回包告诉它还要
    不要继续；没人看了回 intervalMs=0，它就停。

  前端 hosts.liveVitals 每 1~2 秒读这里，读不到新样本（旧 Agent、事件流没连上）就用心跳那份。
*/

export const AGENT_LIVE_METRICS_VERSION = "2.2.225";
export const LIVE_METRICS_FOCUS_INTERVAL_MS = 1000;
/** 详情关掉以后多久停（前端每秒续一次，留几秒余量给网络抖动） */
const FOCUS_TTL_MS = 6_000;
/** 样本多久算「还新鲜」：超过就不当实时值用 */
const SAMPLE_FRESH_MS = 8_000;
/** 实时通道在跑时，心跳带上来的样本不混进来（两路时间基准不同，速度会跳） */
const LIVE_CHANNEL_ACTIVE_MS = 3_000;
/** 同一台主机多久内最多再发一次 agent-live-metrics 事件 */
const START_EVENT_COOLDOWN_MS = 3_000;
const MAX_HOSTS = 10_000;

export type HostLiveSample = {
  at: number;
  source: "live" | "heartbeat";
  cpuUsage: number | null;
  memoryUsage: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  swapUsage: number | null;
  swapUsed: number | null;
  swapTotal: number | null;
  networkIn: number | null;
  networkOut: number | null;
  diskUsage: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  uptime: number | null;
  tcpConnections: number | null;
  udpConnections: number | null;
};

type HostLiveState = {
  samples: HostLiveSample[];
  lastLiveAt: number;
  lastStartEventAt: number;
};

const states = new Map<number, HostLiveState>();
const focusUntil = new Map<number, number>();

function stateFor(hostId: number) {
  let state = states.get(hostId);
  if (!state) {
    if (states.size >= MAX_HOSTS) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
    state = { samples: [], lastLiveAt: 0, lastStartEventAt: 0 };
    states.set(hostId, state);
  }
  return state;
}

function finiteOrNull(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : null;
}

const INT_MAX = 2147483647;

/** Agent 的紧凑指标数组 m（与心跳同一顺序）转成样本。 */
export function liveSampleFromCompactMetrics(m: unknown, at: number, source: HostLiveSample["source"]): HostLiveSample | null {
  if (!Array.isArray(m) || m.length < 12) return null;
  return {
    at,
    source,
    cpuUsage: finiteOrNull(m[0], 100),
    memoryUsage: finiteOrNull(m[1], 100),
    memoryUsed: finiteOrNull(m[2]),
    memoryTotal: finiteOrNull(m[3]),
    swapUsage: finiteOrNull(m[4], 100),
    swapUsed: finiteOrNull(m[5]),
    swapTotal: finiteOrNull(m[6]),
    networkIn: finiteOrNull(m[7]),
    networkOut: finiteOrNull(m[8]),
    diskUsage: finiteOrNull(m[9], 100),
    diskUsed: finiteOrNull(m[10]),
    diskTotal: finiteOrNull(m[11]),
    uptime: finiteOrNull(m[12]),
    tcpConnections: finiteOrNull(m[13], INT_MAX),
    udpConnections: finiteOrNull(m[14], INT_MAX),
  };
}

export function recordHostLiveSample(hostId: number, sample: HostLiveSample, now = Date.now()) {
  const id = Math.floor(Number(hostId));
  if (!Number.isInteger(id) || id <= 0) return;
  const state = stateFor(id);
  if (sample.source === "heartbeat" && now - state.lastLiveAt < LIVE_CHANNEL_ACTIVE_MS) return;
  if (sample.source === "live") state.lastLiveAt = now;
  const last = state.samples[state.samples.length - 1];
  // 换了来源（实时 ↔ 心跳）就重新开始算速度
  if (last && last.source !== sample.source) state.samples = [];
  state.samples.push(sample);
  if (state.samples.length > 3) state.samples.splice(0, state.samples.length - 3);
}

function speedBetween(latest: HostLiveSample, previous: HostLiveSample | undefined) {
  if (!previous) return { networkSpeedIn: null as number | null, networkSpeedOut: null as number | null };
  const seconds = (latest.at - previous.at) / 1000;
  if (!(seconds > 0)) return { networkSpeedIn: null, networkSpeedOut: null };
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.max(0, a - b) / seconds);
  return {
    networkSpeedIn: delta(latest.networkIn, previous.networkIn),
    networkSpeedOut: delta(latest.networkOut, previous.networkOut),
  };
}

/** 这台主机最新的实时指标（形状同 getLatestHostMetricRows 的一行）；没有新鲜样本返回 null。 */
export function getHostLiveMetric(hostId: number, now = Date.now()) {
  const state = states.get(Math.floor(Number(hostId)));
  if (!state || state.samples.length === 0) return null;
  const latest = state.samples[state.samples.length - 1];
  if (now - latest.at > SAMPLE_FRESH_MS) return null;
  // 两个样本挨得太近（< 0.5 秒，比如心跳和实时同一刻到）算出来的速度会抖，往前多看一个
  let previous: HostLiveSample | undefined;
  for (let i = state.samples.length - 2; i >= 0; i -= 1) {
    previous = state.samples[i];
    if (latest.at - previous.at >= 500) break;
  }
  const { source: _source, at, ...rest } = latest;
  return {
    hostId: Math.floor(Number(hostId)),
    ...rest,
    ...speedBetween(latest, previous),
    recordedAt: new Date(at),
    live: latest.source === "live",
  };
}

export function markHostLiveFocus(hostId: number, now = Date.now(), ttlMs = FOCUS_TTL_MS) {
  const id = Math.floor(Number(hostId));
  if (!Number.isInteger(id) || id <= 0) return;
  focusUntil.set(id, now + ttlMs);
}

export function isHostLiveFocused(hostId: number, now = Date.now()) {
  const id = Math.floor(Number(hostId));
  const until = focusUntil.get(id) || 0;
  if (until <= now) {
    focusUntil.delete(id);
    return false;
  }
  return true;
}

/** 回给 Agent 的下一次间隔：还在看就 1 秒，没人看了 0（停）。 */
export function liveMetricsIntervalFor(hostId: number, now = Date.now()) {
  return isHostLiveFocused(hostId, now) ? LIVE_METRICS_FOCUS_INTERVAL_MS : 0;
}

/**
 * 有人在看详情：需要的话叫 Agent 开实时通道。实时样本一直在来就不重复发；
 * 旧 Agent 不认这个事件，什么都不发（它们靠 2 秒心跳）。
 */
export function ensureHostLiveStream(
  host: { id: number; agentVersion?: string | null },
  now = Date.now(),
  send: (hostId: number, event: string, data: unknown) => boolean = sendAgentEvent,
) {
  const id = Math.floor(Number(host?.id));
  if (!Number.isInteger(id) || id <= 0) return false;
  if (!isAgentVersionAtLeast(host.agentVersion, AGENT_LIVE_METRICS_VERSION)) return false;
  const state = stateFor(id);
  if (now - state.lastLiveAt < LIVE_CHANNEL_ACTIVE_MS) return false;
  if (now - state.lastStartEventAt < START_EVENT_COOLDOWN_MS) return false;
  state.lastStartEventAt = now;
  return send(id, "agent-live-metrics", { intervalMs: LIVE_METRICS_FOCUS_INTERVAL_MS });
}

export function clearHostLiveMetricsForTest() {
  states.clear();
  focusUntil.clear();
}
