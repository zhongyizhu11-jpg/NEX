import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROUTE_SCORE_LOAD_FROM_PCT, formatRouteScore, routeLoadPenalty, routeScore, routeScoreGrade } from "./routeScore";

/**
 * 线路评分的用例和 Agent 共用一份（routeScore.cases.json）。
 *
 * Agent 拿评分做切换决定，面板拿它解释「为什么走这条」—— 两边算出不同的数，用户看到的
 * 就是「面板说 B 更好，机器却在走 A」，而且没有任何地方会报错。
 */

type ScoreCase = {
  name: string;
  latencyMs: number | null;
  lossPct: number;
  jitterMs: number;
  availabilityPct: number;
  healthy: boolean;
  /** 沿途主机负载；没写 = 不知道，不扣分。 */
  loadPct?: number;
  expected: number | null;
};

test("线路评分：和 Agent 共用的用例表", () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "routeScore.cases.json"), "utf8")) as { cases: ScoreCase[] };
  // 锚点校验：读空了的话下面整轮断言会全部空转。
  assert.ok(fixture.cases.length >= 10, "用例表太短，大概读错了文件");
  assert.ok(fixture.cases.some((item) => typeof item.loadPct === "number"), "用例表里该有带负载的用例");
  for (const item of fixture.cases) {
    assert.equal(
      routeScore({ latencyMs: item.latencyMs, lossPct: item.lossPct, jitterMs: item.jitterMs, availabilityPct: item.availabilityPct, healthy: item.healthy, loadPct: item.loadPct }),
      item.expected,
      item.name,
    );
  }
});

test("主机负载扣分：70% 以下不扣，95% 起扣满 15 分，中间线性；不给、给 null 都不扣", () => {
  assert.equal(routeLoadPenalty(null), 0);
  assert.equal(routeLoadPenalty(undefined), 0);
  assert.equal(routeLoadPenalty(ROUTE_SCORE_LOAD_FROM_PCT), 0);
  assert.equal(routeLoadPenalty(82.5), 7.5);
  assert.equal(routeLoadPenalty(95), 15);
  assert.equal(routeLoadPenalty(100), 15);
  const base = { latencyMs: 30, lossPct: 0, jitterMs: 0, availabilityPct: 100, healthy: true };
  assert.equal(routeScore(base), 100);
  assert.equal(routeScore({ ...base, loadPct: null }), 100);
  assert.equal(routeScore({ ...base, loadPct: 85 }), 91);
  assert.ok(routeScore({ ...base, latencyMs: 100, loadPct: 90 })! < routeScore({ ...base, latencyMs: 100 })!, "忙的该比不忙的低");
});

test("评分的等级：90 起是优，80 起是良，其余较差；0 分是不可用，没分是等评分", () => {
  assert.equal(routeScoreGrade(100).label, "优");
  assert.equal(routeScoreGrade(90).label, "优");
  assert.equal(routeScoreGrade(89).label, "良");
  assert.equal(routeScoreGrade(80).label, "良");
  assert.equal(routeScoreGrade(79).label, "较差");
  assert.equal(routeScoreGrade(1).label, "较差");
  assert.equal(routeScoreGrade(0).label, "不可用");
  assert.equal(routeScoreGrade(null).label, "等评分");
  assert.equal(formatRouteScore(92), "92 优");
  assert.equal(formatRouteScore(null), "等评分");
});

test("分数只在切换保护之外说话：越好的线路分越高，而且单调", () => {
  const base = { lossPct: 0, jitterMs: 0, availabilityPct: 100, healthy: true };
  const fast = routeScore({ ...base, latencyMs: 50 })!;
  const slow = routeScore({ ...base, latencyMs: 250 })!;
  assert.ok(fast > slow, `延迟低的该分高：${fast} vs ${slow}`);
  const clean = routeScore({ ...base, latencyMs: 100 })!;
  const lossy = routeScore({ ...base, latencyMs: 100, lossPct: 2 })!;
  assert.ok(clean > lossy, `丢包多的该分低：${clean} vs ${lossy}`);
});
