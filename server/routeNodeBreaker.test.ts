import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUTE_BREAKER_RECOVER_MS,
  recordRouteHopProbe,
  resetRouteStatsForTest,
  routeNodeHints,
  routePathDownstreamMs,
  routeTrippedNodeIds,
} from "./routeGroupStats";
import type { RoutePath } from "../shared/routeGroup";

const probe = (ruleId: number, pathKey: string, ok: boolean, nowMs: number, nextHostId = 9, latencyMs: number | null = 5) =>
  recordRouteHopProbe({ parentRuleId: ruleId, pathKey, hopIndex: 0, hostId: 2, hostName: "jinx", nextLabel: "HK2", ok, latencyMs: ok ? latencyMs : null, nextHostId, nowMs });

test("节点熔断：连续 3 次探不通、两分钟内没人探通 → 熔断；探通稳定一分钟才解除", () => {
  resetRouteStatsForTest();
  const t0 = 1_000_000_000;
  assert.equal(probe(1, "a", false, t0).breaker, null);
  assert.equal(probe(1, "a", false, t0 + 60_000).breaker, null);
  assert.deepEqual(probe(1, "a", false, t0 + 120_000).breaker, { hostId: 9, tripped: true });
  assert.ok(routeTrippedNodeIds().has(9));
  // 探通了，但还没稳定一分钟
  assert.equal(probe(1, "a", true, t0 + 130_000).breaker, null);
  assert.ok(routeTrippedNodeIds().has(9));
  assert.deepEqual(probe(1, "a", true, t0 + 130_000 + ROUTE_BREAKER_RECOVER_MS).breaker, { hostId: 9, tripped: false });
  assert.ok(!routeTrippedNodeIds().has(9));
});

test("别的线路两分钟内探通过这台：不熔断（只是一条线的问题）", () => {
  resetRouteStatsForTest();
  const t0 = 2_000_000_000;
  probe(2, "x", true, t0);
  probe(1, "a", false, t0 + 1000);
  probe(1, "a", false, t0 + 2000);
  assert.equal(probe(1, "a", false, t0 + 3000).breaker, null);
  assert.ok(!routeTrippedNodeIds().has(9));
});

test("节点提示：暂停 > 维护 > 离线 > 熔断；下游延迟按这条路径的中继探测相加", () => {
  resetRouteStatsForTest();
  const paths = [
    { key: "p", hops: [2], paused: true },
    { key: "m", hops: [3] },
    { key: "o", hops: [4] },
    { key: "t", hops: [9] },
    { key: "ok", hops: [2] },
  ] as unknown as RoutePath[];
  const nodes: Record<number, { name: string; online: boolean; maintenance: boolean }> = {
    2: { name: "jinx", online: true, maintenance: false },
    3: { name: "HK2", online: true, maintenance: true },
    4: { name: "SG", online: false, maintenance: false },
    9: { name: "JP", online: true, maintenance: false },
  };
  const hints = routeNodeHints(paths, (id) => nodes[id] || null, new Set([9]));
  assert.equal(hints.get("p")?.reason, "paused");
  assert.equal(hints.get("m")?.reason, "maintenance: HK2");
  assert.equal(hints.get("o")?.reason, "node offline: SG");
  assert.equal(hints.get("t")?.reason, "breaker: JP");
  assert.equal(hints.has("ok"), false);
  recordRouteHopProbe({ parentRuleId: 5, pathKey: "ok", hopIndex: 0, hostId: 2, hostName: "jinx", nextLabel: "落地", ok: true, latencyMs: 12.4 });
  // 界面上要 0.8 + 1.5 = 2.3 这种：留一位小数（下发给 Agent 时心跳那边再取整）。
  assert.equal(routePathDownstreamMs(5, paths[4]), 12.4);
});
