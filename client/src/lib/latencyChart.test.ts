import assert from "node:assert/strict";
import test from "node:test";
import { computeLinkAvailability, formatStatLatency, formatStatPercent, getLatencyStabilityStats } from "./latencyChart";
import { routeQualityStats } from "./routeQuality";

test("latency stability stats count partial packet loss", () => {
  const stats = getLatencyStabilityStats([
    { latency: 24, isTimeout: false, probeCount: 5, probeSuccesses: 4 },
  ]);

  assert.equal(stats.total, 5);
  assert.equal(stats.timeout, 1);
  assert.equal(stats.valid, 4);
  assert.equal(stats.lossRate, 20);
  assert.equal(stats.avg, 24);
});

test("latency stability stats preserve legacy binary rows", () => {
  const stats = getLatencyStabilityStats([
    { latency: 12, isTimeout: false },
    { latency: 0, isTimeout: true },
  ]);

  assert.equal(stats.total, 2);
  assert.equal(stats.timeout, 1);
  assert.equal(stats.valid, 1);
  assert.equal(stats.lossRate, 50);
});


test("可用率按次算、丢包率按包算：5 包丢 1 包的那一次仍然可用", () => {
  const stats = getLatencyStabilityStats([
    { latency: 24, isTimeout: false, probeCount: 5, probeSuccesses: 4 },
    { latency: 0, isTimeout: true, probeCount: 5, probeSuccesses: 0 },
    { latency: 30, isTimeout: false, probeCount: 5, probeSuccesses: 5 },
    { latency: 26, isTimeout: false },
  ]);
  assert.equal(stats.availability, 75);
  assert.equal(stats.timeoutRate, 25);
  assert.equal(stats.lossRate, (6 / 16) * 100);
  assert.equal(computeLinkAvailability([]), null);
  assert.equal(getLatencyStabilityStats([]).availability, null);
});

test("P95 和抖动：偶尔一次尖峰拉高 P95，抖动看的是典型偏离", () => {
  const samples = Array.from({ length: 19 }, (_, index) => ({ latency: 40 + (index % 3), isTimeout: false }));
  samples.push({ latency: 400, isTimeout: false });
  const stats = getLatencyStabilityStats(samples);
  assert.equal(stats.p50, 41);
  assert.equal(stats.p95, 42);
  assert.equal(stats.max, 400);
  assert.equal(stats.jitter, 1);
  const spiky = getLatencyStabilityStats([...samples, { latency: 380, isTimeout: false }, { latency: 390, isTimeout: false }]);
  assert.ok((spiky.p95 || 0) >= 380, "尖峰超过 5% 时 P95 跟着上去");
});

test("统计卡片的格式：毫秒取整、百分比两位小数、整百不带小数、没有值写 --", () => {
  assert.equal(formatStatLatency(41.6), "42 ms");
  assert.equal(formatStatLatency(null), "--");
  assert.equal(formatStatPercent(99.456), "99.46%");
  assert.equal(formatStatPercent(100), "100%");
  assert.equal(formatStatPercent(0), "0%");
  assert.equal(formatStatPercent(75), "75%");
  assert.equal(formatStatPercent(97.5, 1), "97.5%");
  assert.equal(formatStatPercent(null), "--");
  assert.equal(formatStatPercent(120), "100%");
});

test("线路组质量历史 → 同一套统计：点数、平均丢包、Agent 报的可用率", () => {
  const stats = routeQualityStats([
    { at: 1, latencyMs: 40, lossPct: 0, jitterMs: 4, availabilityPct: 100, score: 92, samples: 5 },
    { at: 2, latencyMs: 60, lossPct: 2, jitterMs: 6, availabilityPct: 98, score: 80, samples: 5 },
    { at: 3, latencyMs: null, lossPct: 100, jitterMs: null, availabilityPct: 0, score: 0, samples: 5 },
  ]);
  assert.equal(stats.total, 3);
  assert.equal(stats.availability, 66);
  assert.equal(stats.timeoutRate, 34);
  assert.equal(Math.round(stats.lossRate * 100) / 100, 34);
  assert.equal(stats.min, 40);
  assert.equal(stats.max, 60);
  assert.equal(routeQualityStats([]).total, 0);
});

test("可用率按时间算：状态延续到下一个点，有累计计数时也显示", async () => {
  const { computeTimeWeightedAvailability, getLatencyStabilityStats, AVAILABILITY_MAX_SEGMENT_MS } = await import("./latencyChart");
  const t0 = Date.UTC(2026, 9, 18, 0, 0, 0);
  const minute = 60_000;
  // 0~5 分钟通，5~6 分钟断（每次失败都报，1 分钟一个），6~10 分钟通。
  const samples = [
    { latency: 10, atMs: t0 },
    { latency: 0, isTimeout: true, probeCount: 1, probeSuccesses: 0, atMs: t0 + 5 * minute },
    { latency: 10, atMs: t0 + 6 * minute },
  ];
  const availability = computeTimeWeightedAvailability(samples, t0 + 10 * minute);
  assert.ok(availability !== null && Math.abs(availability - 90) < 1e-9, String(availability));
  // 有累计计数：以前不显示可用率，现在按时间算出来。
  const stats = getLatencyStabilityStats(samples, { total: 600, successes: 599, available: true, observedSince: null, latestAt: null });
  assert.equal(stats.fromCounters, true);
  assert.ok(stats.availability !== null && stats.availability > 80);
  // 中间一大段没数据（Agent 离线）不算进分母。
  const gap = computeTimeWeightedAvailability([
    { latency: 10, atMs: t0 },
    { latency: 0, isTimeout: true, probeCount: 1, probeSuccesses: 0, atMs: t0 + 5 * 60 * minute },
  ], t0 + 5 * 60 * minute + minute);
  assert.ok(gap !== null && Math.abs(gap - (AVAILABILITY_MAX_SEGMENT_MS / (AVAILABILITY_MAX_SEGMENT_MS + minute)) * 100) < 1e-9, String(gap));
  // 缺时间的样本：退回原来的规则。
  assert.equal(computeTimeWeightedAvailability([{ latency: 10 }]), null);
  assert.equal(getLatencyStabilityStats([{ latency: 10 }], { total: 10, successes: 10, available: true, observedSince: null, latestAt: null }).availability, null);
});
