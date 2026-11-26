import assert from "node:assert/strict";
import test from "node:test";
import { LINK_PROBE_FRESH_MS } from "@shared/linkProbePolicy";
import {
  buildStableRuleProbeMap,
  clearRuleProbeCache,
  hasRuleProbeAfterInvalidation,
  updateRuleProbeCache,
} from "./ruleProbeCache";

const now = Date.UTC(2026, 6, 27, 12, 0, 0);

function success(latencyMs: number, latestLatencyAt: number) {
  return {
    latestLatencyMs: latencyMs,
    latestLatencyIsTimeout: false,
    latestLatencyAt,
  };
}

test("a fresh cached probe survives a temporary missing traffic row", () => {
  const probe = success(42, now - 30_000);
  updateRuleProbeCache("temporary-gap", new Map([[11, probe]]));

  const stable = buildStableRuleProbeMap("temporary-gap", [11], new Map(), now);

  assert.equal(stable.get(11), probe);
});

test("probe caches are isolated by user", () => {
  updateRuleProbeCache("cache-owner", new Map([[12, success(18, now - 10_000)]]));

  const otherUser = buildStableRuleProbeMap("different-user", [12], new Map(), now);

  assert.equal(otherUser.has(12), false);
});

test("an out-of-order response cannot replace a newer cached probe", () => {
  const newest = success(25, now - 10_000);
  const older = success(90, now - 20_000);
  updateRuleProbeCache("out-of-order", new Map([[13, newest]]));
  updateRuleProbeCache("out-of-order", new Map([[13, older]]));

  const stable = buildStableRuleProbeMap("out-of-order", [13], new Map(), now);

  assert.equal(stable.get(13), newest);
});

test("an expired fallback is dropped while an authoritative current probe remains visible", () => {
  const oldProbe = success(61, now - LINK_PROBE_FRESH_MS - 1);
  updateRuleProbeCache("expired-fallback", new Map([[14, oldProbe]]));

  assert.equal(
    buildStableRuleProbeMap("expired-fallback", [14], new Map(), now).has(14),
    false,
  );
  assert.equal(
    buildStableRuleProbeMap("expired-fallback", [14], new Map([[14, oldProbe]]), now).get(14),
    oldProbe,
  );
});

test("invalidation blocks the old probe until a result recorded after the change arrives", () => {
  const beforeInvalidation = success(36, Date.now() - 10_000);
  updateRuleProbeCache("invalidated-rule", new Map([[15, beforeInvalidation]]));
  clearRuleProbeCache("invalidated-rule", [15]);
  const invalidated = new Set([15]);

  updateRuleProbeCache("invalidated-rule", new Map([[15, beforeInvalidation]]));
  assert.equal(
    hasRuleProbeAfterInvalidation("invalidated-rule", 15, beforeInvalidation),
    false,
  );
  assert.equal(
    buildStableRuleProbeMap("invalidated-rule", [15], new Map([[15, beforeInvalidation]]), Date.now(), invalidated).has(15),
    false,
  );

  // The server clock can trail the browser clock. A newly observed probe only
  // needs to be newer than the result that was visible before invalidation.
  const afterInvalidation = success(29, Number(beforeInvalidation.latestLatencyAt) + 1_000);
  updateRuleProbeCache("invalidated-rule", new Map([[15, afterInvalidation]]));
  assert.equal(
    hasRuleProbeAfterInvalidation("invalidated-rule", 15, afterInvalidation),
    true,
  );
  invalidated.delete(15);
  assert.equal(
    buildStableRuleProbeMap("invalidated-rule", [15], new Map(), Date.now(), invalidated).get(15),
    afterInvalidation,
  );
});

/*
  负载均衡的规则：卡上的数是服务端现拼的（panel / exit-target / live），时间戳来自不同的探测，不保证往前走。
  用户面板（2026-11-26）：hkt/3 先收到一份「超时」（主出口的定时探测，时间戳 12:06:48），之后服务端算出走 hep ix 通、
  两段探测的时间戳是 12:06:40 —— 按时间戳挑，卡片一直红。
*/
test("服务端按实时数据给的结论以这一次为准，不被时间戳更新的旧超时顶掉", () => {
  const user = "live-derived";
  const staleTimeout = { latestLatencyMs: null, latestLatencyIsTimeout: true, latestLatencyAt: now - 10_000, latestLatencySource: "probe" };
  updateRuleProbeCache(user, new Map([[21, staleTimeout]]));
  const panel = { latestLatencyMs: 9, latestLatencyIsTimeout: false, latestLatencyAt: now - 20_000, latestLatencySource: "panel" };
  assert.equal(buildStableRuleProbeMap(user, [21], new Map([[21, panel]]), now).get(21), panel, "当前这份两段相加的结论直接用");
  updateRuleProbeCache(user, new Map([[21, panel]]));
  assert.equal(buildStableRuleProbeMap(user, [21], new Map(), now).get(21), panel, "缓存里也换成它，这一行暂时缺席时不退回旧超时");

  // 在用出口已知、延迟还没测到（live）：不是超时，也不能退回缓存里的旧红色
  updateRuleProbeCache(user, new Map([[22, staleTimeout]]));
  const livePending = { latestLatencyMs: null, latestLatencyIsTimeout: false, latestLatencyAt: now - 30_000, latestLatencySource: "live" };
  assert.equal(buildStableRuleProbeMap(user, [22], new Map([[22, livePending]]), now).get(22), livePending);
  updateRuleProbeCache(user, new Map([[22, livePending]]));
  assert.equal(buildStableRuleProbeMap(user, [22], new Map(), now).has(22), false, "旧的超时已经作废");

  // 规则自己的定时探测（probe）照旧防乱序
  const newest = { latestLatencyMs: 25, latestLatencyIsTimeout: false, latestLatencyAt: now - 10_000, latestLatencySource: "probe" };
  const older = { latestLatencyMs: 90, latestLatencyIsTimeout: false, latestLatencyAt: now - 20_000, latestLatencySource: "probe" };
  updateRuleProbeCache(user, new Map([[23, newest]]));
  assert.equal(buildStableRuleProbeMap(user, [23], new Map([[23, older]]), now).get(23), newest);
});
