import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AGENT_LIVE_METRICS_VERSION,
  clearHostLiveMetricsForTest,
  ensureHostLiveStream,
  getHostLiveMetric,
  isHostLiveFocused,
  liveMetricsIntervalFor,
  liveSampleFromCompactMetrics,
  markHostLiveFocus,
  recordHostLiveSample,
} from "./hostLiveMetrics";
import { AGENT_METRICS_WATCH_INTERVAL_SECONDS, buildBusyAgentHeartbeatResponse, selectAgentHeartbeatInterval } from "./agentHeartbeatGate";
import { AGENT_VERSION } from "../shared/versions";

const m = (netIn: number, netOut: number, cpu = 12) => [cpu, 40, 400, 1000, 0, 0, 0, netIn, netOut, 8, 1, 20, 3600, 10, 3];

test("实时样本按 Agent 时间差算上下行速度", () => {
  clearHostLiveMetricsForTest();
  const t0 = 1_000_000;
  recordHostLiveSample(5, liveSampleFromCompactMetrics(m(1000, 500), t0, "live")!, t0);
  recordHostLiveSample(5, liveSampleFromCompactMetrics(m(4000, 1500, 55), t0 + 1000, "live")!, t0 + 1000);
  const row = getHostLiveMetric(5, t0 + 1200)!;
  assert.equal(row.cpuUsage, 55);
  assert.equal(row.networkSpeedIn, 3000);
  assert.equal(row.networkSpeedOut, 1000);
  assert.equal(row.memoryTotal, 1000);
  assert.equal(row.tcpConnections, 10);
  assert.equal(row.live, true);
  // 过期的样本不当实时值
  assert.equal(getHostLiveMetric(5, t0 + 60_000), null);
});

test("实时通道在跑时心跳样本不混进来；两个样本挨太近就往前看一个", () => {
  clearHostLiveMetricsForTest();
  const t0 = 2_000_000;
  recordHostLiveSample(6, liveSampleFromCompactMetrics(m(0, 0), t0, "live")!, t0);
  recordHostLiveSample(6, liveSampleFromCompactMetrics(m(2000, 0), t0 + 1000, "live")!, t0 + 1000);
  recordHostLiveSample(6, liveSampleFromCompactMetrics(m(999999, 0), t0 + 1100, "heartbeat")!, t0 + 1100);
  recordHostLiveSample(6, liveSampleFromCompactMetrics(m(2100, 0), t0 + 1200, "live")!, t0 + 1200);
  const row = getHostLiveMetric(6, t0 + 1300)!;
  assert.equal(row.networkIn, 2100, "heartbeat sample ignored while live channel active");
  // 最新(1200) 与上一个(1000) 只差 200ms，往前取 t0：2100 / 1.2s
  assert.equal(Math.round(row.networkSpeedIn!), 1750);
});

test("没有实时通道的旧 Agent：心跳样本照样能给出速度", () => {
  clearHostLiveMetricsForTest();
  const t0 = 3_000_000;
  recordHostLiveSample(7, liveSampleFromCompactMetrics(m(0, 0), t0, "heartbeat")!, t0);
  recordHostLiveSample(7, liveSampleFromCompactMetrics(m(4000, 2000), t0 + 2000, "heartbeat")!, t0 + 2000);
  const row = getHostLiveMetric(7, t0 + 2100)!;
  assert.equal(row.networkSpeedIn, 2000);
  assert.equal(row.live, false);
});

test("坏数据：负数、非数字、太短的数组都不进来", () => {
  assert.equal(liveSampleFromCompactMetrics("x", 1, "live"), null);
  assert.equal(liveSampleFromCompactMetrics([1, 2, 3], 1, "live"), null);
  const sample = liveSampleFromCompactMetrics([-1, "abc", 1e40, 10, 0, 0, 0, 1, 1, 500, 0, 0], 1, "live")!;
  assert.equal(sample.cpuUsage, null);
  assert.equal(sample.memoryUsage, null);
  assert.equal(sample.memoryUsed, Number.MAX_SAFE_INTEGER);
  assert.equal(sample.diskUsage, 100);
});

test("详情打开（focus）期间回 1 秒，关掉后回 0 让 Agent 停", () => {
  clearHostLiveMetricsForTest();
  const now = 4_000_000;
  assert.equal(liveMetricsIntervalFor(8, now), 0);
  markHostLiveFocus(8, now);
  assert.equal(isHostLiveFocused(8, now + 1000), true);
  assert.equal(liveMetricsIntervalFor(8, now + 1000), 1000);
  assert.equal(liveMetricsIntervalFor(8, now + 60_000), 0);
});

test("只叫新 Agent 开实时通道，有样本在来或刚叫过就不重复发", () => {
  clearHostLiveMetricsForTest();
  const sent: Array<[number, string, unknown]> = [];
  const send = (hostId: number, event: string, data: unknown) => {
    sent.push([hostId, event, data]);
    return true;
  };
  const now = 5_000_000;
  assert.equal(ensureHostLiveStream({ id: 9, agentVersion: "2.2.224" }, now, send), false);
  assert.equal(ensureHostLiveStream({ id: 9, agentVersion: AGENT_LIVE_METRICS_VERSION }, now, send), true);
  assert.deepEqual(sent[0], [9, "agent-live-metrics", { intervalMs: 1000 }]);
  assert.equal(ensureHostLiveStream({ id: 9, agentVersion: AGENT_LIVE_METRICS_VERSION }, now + 1000, send), false, "cooldown");
  recordHostLiveSample(9, liveSampleFromCompactMetrics(m(1, 1), now + 4000, "live")!, now + 4000);
  assert.equal(ensureHostLiveStream({ id: 9, agentVersion: AGENT_LIVE_METRICS_VERSION }, now + 5000, send), false, "stream already flowing");
  assert.equal(ensureHostLiveStream({ id: 9, agentVersion: AGENT_LIVE_METRICS_VERSION }, now + 20_000, send), true, "restart after it stopped");
});

test("有人在看时心跳 2 秒（旧 Agent 的下限，更短会被它当成 30 秒）", () => {
  assert.equal(AGENT_METRICS_WATCH_INTERVAL_SECONDS, 2);
  assert.equal(buildBusyAgentHeartbeatResponse({ panelUrl: "", requestLocalState: false, metricsWatching: true }).nextInterval, 2);
  assert.equal(selectAgentHeartbeatInterval({ requestLocalState: false, hasInteractiveTasks: false, metricsWatching: true }), 2);
});

test("实时指标版本就是这一版 Agent；接口在 /api/sync 白名单里", () => {
  assert.equal(AGENT_LIVE_METRICS_VERSION, AGENT_VERSION);
  const middleware = fs.readFileSync(path.join(process.cwd(), "server/agentEncryptionMiddleware.ts"), "utf8");
  assert.match(middleware, /"\/api\/agent\/live-metrics"/);
  const agent = fs.readFileSync(path.join(process.cwd(), "agent/live_metrics.go"), "utf8");
  assert.match(agent, /post\(cfg, "\/api\/agent\/live-metrics"/);
});
