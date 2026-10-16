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
