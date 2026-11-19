import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_LOAD_MAX_PCT, formatRouteScore, routeLoadSlowdown, routeScoreGrade } from "./routeScore";

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

test("主机负载让成本按 1 ÷ (1 − 负载) 算，最多按 95%（和 lbcore 的 Headroom 一样）；不知道不算", () => {
  assert.equal(routeLoadSlowdown(null), 1);
  assert.equal(routeLoadSlowdown(undefined), 1);
  assert.equal(routeLoadSlowdown(0), 1);
  assert.equal(routeLoadSlowdown(50), 2);
  assert.ok(Math.abs(routeLoadSlowdown(ROUTE_LOAD_MAX_PCT) - 20) < 1e-9);
  assert.equal(routeLoadSlowdown(100), routeLoadSlowdown(ROUTE_LOAD_MAX_PCT));
});
