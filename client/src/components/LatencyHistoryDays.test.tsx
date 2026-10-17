import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "./ui/tooltip";
import { buildLatencyHistoryDays, LatencyHistoryDayStrip, summarizeLatencyHistory } from "./LatencyHistoryDays";
import { latencyDayStart, latencyHistoryDays } from "@shared/latencyHistory";

// 上游 v2.3.284 的 LatencyHistoryDays.test.tsx 移植。NEX 的「一天」按面板时区切、数据来自
// 服务端按天汇总的表，所以没有上游那套「浏览器本地时区 + 客户端自己按天聚合原始样本」。

const nowMs = Date.UTC(2027, 0, 5, 4); // 2027-01-05 12:00 +08:00

test("day strip spans the latest 30 panel calendar days across month/year boundaries", () => {
  const days = latencyHistoryDays(nowMs);
  assert.equal(days.length, 30);
  assert.equal(days[0].date, "2026-12-07");
  assert.equal(days[29].date, "2027-01-05");
  assert.equal(days[29].index, 30);
  assert.equal(days[29].isToday, true);
  assert.equal(days[0].label, "12/7");
  for (let index = 1; index < days.length; index++) assert.equal(days[index].dayStart - days[index - 1].dayStart, 86_400);
  assert.equal(days[29].dayStart, latencyDayStart(Math.floor(nowMs / 1000)));
});

test("server summaries land on their day; missing days stay grey; the caption sums packet counts, not percentages", () => {
  const days = latencyHistoryDays(nowMs);
  const summaries = [
    { dayStart: days[0].dayStart, probeCount: 100, probeSuccesses: 100, avgLatencyMs: 20, minLatencyMs: 2, maxLatencyMs: 200 },
    { dayStart: days[1].dayStart, probeCount: 100, probeSuccesses: 97, avgLatencyMs: 30, minLatencyMs: 10, maxLatencyMs: 90 },
    { dayStart: days[2].dayStart, probeCount: 10_000, probeSuccesses: 8_000, avgLatencyMs: 300, minLatencyMs: 100, maxLatencyMs: 900 },
  ];
  const built = buildLatencyHistoryDays(summaries, nowMs);
  assert.deepEqual(built.slice(0, 4).map((day) => day.health), ["good", "warning", "bad", "none"]);
  const overall = summarizeLatencyHistory(built);
  assert.equal(overall.measuredDays, 3);
  // (0 + 3 + 2000) / 10200，不是三天丢包率的平均。
  assert.ok(Math.abs((overall.lossPercent ?? 0) - 2003 / 10_200 * 100) < 1e-9);
});

test("strip renders every day with an accessible label and health colors from semantic tokens", () => {
  const days = latencyHistoryDays(nowMs);
  const summaries = [100, 97, 80].map((successes, index) => ({ dayStart: days[index].dayStart, probeCount: 100, probeSuccesses: successes, avgLatencyMs: 20, minLatencyMs: 10, maxLatencyMs: 30 }));
  for (const variant of ["detail", "compact"] as const) {
    const html = renderToStaticMarkup(<TooltipProvider><LatencyHistoryDayStrip summaries={summaries} variant={variant} nowMs={nowMs} /></TooltipProvider>);
    assert.equal((html.match(/role="listitem"/g) || []).length, 30, variant);
    assert.match(html, /data-health="good"/);
    assert.match(html, /data-health="warning"/);
    assert.match(html, /data-health="bad"/);
    assert.match(html, /data-health="none"/);
    assert.match(html, /aria-label="2026-12-07 正常"/);
    assert.match(html, /var\(--fx-healthy\)/);
    assert.match(html, /var\(--fx-down\)/);
    assert.doesNotMatch(html, /emerald|amber|red-\d/);
  }
  const detail = renderToStaticMarkup(<TooltipProvider><LatencyHistoryDayStrip summaries={summaries} nowMs={nowMs} /></TooltipProvider>);
  assert.match(detail, /近 30 天/);
  assert.match(detail, /3 天有记录/);
  assert.match(detail, /今天/);
  const empty = renderToStaticMarkup(<TooltipProvider><LatencyHistoryDayStrip summaries={[]} nowMs={nowMs} /></TooltipProvider>);
  assert.match(empty, /还没有记录/);
  assert.equal((empty.match(/data-health="none"/g) || []).length, 30);
});
