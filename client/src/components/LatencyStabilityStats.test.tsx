import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import { getLatencyStabilityStats } from "@/lib/latencyChart";
import { LATENCY_STAT_HINTS, LatencyStabilityStats } from "./LatencyStabilityStats";

test("统计卡片：P95、抖动、可用率都在，每格带一句说明", () => {
  const stats = getLatencyStabilityStats([
    { latency: 40, isTimeout: false },
    { latency: 44, isTimeout: false },
    { latency: 0, isTimeout: true },
    { latency: 90, isTimeout: false },
  ]);
  const html = renderToStaticMarkup(<TooltipProvider><LatencyStabilityStats stats={stats} /></TooltipProvider>);
  for (const label of ["统计次数", "可用率", "丢包率", "平均延迟", "P95 延迟", "抖动", "最小延迟", "最大延迟", "稳定性"]) {
    assert.match(html, new RegExp(label), label);
  }
  assert.match(html, />75%</, "4 次里通了 3 次");
  assert.match(html, /P95 延迟<\/p><div[^>]*><p[^>]*>44 ms</, "三次成功里 P95 落在第二慢的那次");
  assert.match(html, /最大延迟<\/p><div[^>]*><p[^>]*>90 ms</);
  assert.match(html, new RegExp(LATENCY_STAT_HINTS.p95.slice(0, 8)), "说明写在 aria-label 里，读屏也念得到");
  assert.match(html, /sm:grid-cols-9/);
});

test("没有数据时全是 --，窄面板用三列", () => {
  const html = renderToStaticMarkup(<TooltipProvider><LatencyStabilityStats stats={getLatencyStabilityStats([])} layout="compact" /></TooltipProvider>);
  assert.doesNotMatch(html, /sm:grid-cols-9/);
  assert.ok((html.match(/>--</g) || []).length >= 8);
});

// 状态样本被 Agent 节流：稳定成功 5 分钟才报一次，失败每次都报。1 小时里 12 行成功 + 3 行
// 整轮失败（每行 3 包），按样本算丢包率 9/45 = 20%；实际 1200 轮 3600 包只丢了 9 包。
const throttledRows = [
  ...Array.from({ length: 12 }, () => ({ latency: 20, isTimeout: false, probeCount: 3, probeSuccesses: 3 })),
  ...Array.from({ length: 3 }, () => ({ latency: 0, isTimeout: true, probeCount: 3, probeSuccesses: 0 })),
];

test("累计探测计数可用时，次数和丢包率按真实探测算，不再被节流的成功样本放大", () => {
  const counters = { total: 3600, successes: 3591, available: true, observedSince: new Date(), latestAt: new Date() };
  const legacy = getLatencyStabilityStats(throttledRows);
  assert.equal(legacy.lossRate, 20, "按样本统计的老算法：失败率被夸大");
  const stats = getLatencyStabilityStats(throttledRows, counters);
  assert.equal(stats.fromCounters, true);
  assert.equal(stats.total, 3600);
  assert.equal(stats.timeout, 9);
  assert.equal(stats.lossRate, 0.25);
  assert.equal(stats.availability, null, "按样本的可用率同样偏低，累计模式下不显示");
  assert.equal(stats.avg, 20, "延迟分布仍取自样本");
  const html = renderToStaticMarkup(<TooltipProvider><LatencyStabilityStats stats={stats} counterStatistics={counters} description="不是业务丢包" /></TooltipProvider>);
  assert.match(html, />3600</);
  assert.match(html, />0\.25%</);
  assert.match(html, /data-probe-counter-note="counters"/);
  assert.match(html, /累计探测次数/);
  assert.match(html, /不是业务丢包/);
});

test("旧 Agent 没有累计计数：统计与原来一致，并提示失败率偏高的原因", () => {
  const legacy = getLatencyStabilityStats(throttledRows);
  for (const actual of [null, { total: 0, successes: 0, available: false, observedSince: null, latestAt: null }]) {
    const stats = getLatencyStabilityStats(throttledRows, actual);
    assert.deepEqual(stats, legacy);
    const html = renderToStaticMarkup(<TooltipProvider><LatencyStabilityStats stats={stats} counterStatistics={actual} /></TooltipProvider>);
    assert.match(html, />20%</);
    assert.match(html, /data-probe-counter-note="samples"/);
    assert.match(html, /升级 Agent/);
  }
  const plain = renderToStaticMarkup(<TooltipProvider><LatencyStabilityStats stats={legacy} /></TooltipProvider>);
  assert.doesNotMatch(plain, /data-probe-counter-note/, "主机探测等没有累计计数的弹窗不加说明");
});
