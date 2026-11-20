import assert from "node:assert/strict";
import test from "node:test";

import { recordRouteHopFastState, recordRouteHopProbe, resetRouteStatsForTest, routeHopDownHints, ROUTE_HOP_FAST_STALE_MS } from "./routeGroupStats";
import { ROUTE_HOP_STANDBY_INTERVAL_MS, routeHopProberHostId, routeHopProbeSpecForParent, routeHopRelayIsStandby } from "./routeGroups";

/*
  线路组「中转后面的落地」：以前只靠中转机一分钟一轮的普通探测，连续三次（两三分钟）才算断。
  快速探测（Agent 2.2.258）在探的那台机器上按线路组节奏判好断 / 通，报一次面板就生效。
*/

const paths = [
  { key: "main-hkt", hops: [3], dest: { ip: "203.0.113.10", port: 443 } },
  { key: "main-rfc", hops: [3], dest: { ip: "203.0.113.20", port: 443 } },
] as any[];
const base = { parentRuleId: 900, hopIndex: 0, hostId: 3, hostName: "hep ix", nextLabel: "落地", latencyMs: 3 };

test("快速探测报一次「断了」立刻生效；普通探测那边一次成功不会把它冲掉", () => {
  resetRouteStatsForTest();
  const now = 1_800_000_000_000;
  const down = recordRouteHopFastState({ ...base, pathKey: "main-hkt", down: true, nowMs: now });
  assert.equal(down.downChanged, true);
  assert.equal(down.down, true);
  assert.equal(routeHopDownHints(900, paths, now + 1000).get("main-hkt")?.down, true);
  assert.equal(routeHopDownHints(900, paths, now + 1000).get("main-rfc")?.down ?? false, false, "另一个落地不受影响");
  // 同一跳的普通探测（一分钟一轮）这一次碰巧通了：快速探测的结论还新鲜，以它为准
  recordRouteHopProbe({ ...base, pathKey: "main-hkt", ok: true, nowMs: now + 2000 });
  assert.equal(routeHopDownHints(900, paths, now + 3000).get("main-hkt")?.down, true);
  const up = recordRouteHopFastState({ ...base, pathKey: "main-hkt", down: false, nowMs: now + 9000 });
  assert.equal(up.downChanged, true);
  assert.equal(up.down, false);
});

test("快速探测停了（90 秒没报）退回普通探测的结论：连续三次才算断", () => {
  resetRouteStatsForTest();
  const now = 1_800_000_000_000;
  recordRouteHopFastState({ ...base, pathKey: "main-hkt", down: false, nowMs: now });
  const later = now + ROUTE_HOP_FAST_STALE_MS + 1000;
  recordRouteHopProbe({ ...base, pathKey: "main-hkt", ok: false, nowMs: later });
  assert.equal(routeHopDownHints(900, paths, later).get("main-hkt")?.down ?? false, false);
  recordRouteHopProbe({ ...base, pathKey: "main-hkt", ok: false, nowMs: later + 60_000 });
  recordRouteHopProbe({ ...base, pathKey: "main-hkt", ok: false, nowMs: later + 120_000 });
  assert.equal(routeHopDownHints(900, paths, later + 120_000).get("main-hkt")?.down, true);
});

test("探测节奏跟线路组的切换设置走；下一跳由真正去拨它的机器探", () => {
  // 模板：3 秒切换、连续 2 次 → 每 1.5 秒探一次、两次不通就断
  assert.deepEqual(routeHopProbeSpecForParent({ failoverSeconds: 3, routeFailureThreshold: 2 }), { intervalMs: 1500, timeoutMs: 2000, failThreshold: 2, recoverOks: 3 });
  // 老规则（60 秒）：最慢 5 秒一次
  assert.equal(routeHopProbeSpecForParent({ failoverSeconds: 60 }).intervalMs, 5000);
  // gost 中继：它所在的机器；隧道段：隧道出口机；出口机本机的不探
  assert.equal(routeHopProberHostId({ routeParentRuleId: 9, hostId: 3 }, null), 3);
  assert.equal(routeHopProberHostId({ routeParentRuleId: 9, hostId: 3, tunnelId: 7, targetIp: "203.0.113.10" }, { id: 7, exitHostId: 5 }), 5);
  assert.equal(routeHopProberHostId({ routeParentRuleId: 9, hostId: 3, tunnelId: 7, targetIp: "127.0.0.1" }, { id: 7, exitHostId: 5 }), 0);
  assert.equal(routeHopProberHostId({ routeParentRuleId: 0, hostId: 3 }, null), 0, "不是中继规则不探");
});

/*
  候补线路的下一跳探得慢（2.3.542）：主备线路组里入口报了在走的那条，别的线路上的中继 10 秒探一次；
  在走的、不是主备的、入口还没报的照旧按切换节奏。
*/
test("候补线路的下一跳 10 秒探一次，在走的照旧", () => {
  assert.equal(routeHopProbeSpecForParent({ failoverSeconds: 3, routeFailureThreshold: 2 }, { standby: true }).intervalMs, ROUTE_HOP_STANDBY_INTERVAL_MS);
  assert.equal(routeHopProbeSpecForParent({ failoverSeconds: 3, routeFailureThreshold: 2 }, { standby: false }).intervalMs, 1500);
  // 慢的本来就比 10 秒慢（没有这种配置，上限 5 秒）：取大的
  assert.equal(routeHopProbeSpecForParent({ failoverSeconds: 60 }, { standby: true }).intervalMs, ROUTE_HOP_STANDBY_INTERVAL_MS);
  const routePaths = JSON.stringify([
    { key: "main", hops: [], dest: { ip: "203.0.113.10", port: 443 } },
    { key: "backup", hops: [3], dest: { ip: "203.0.113.10", port: 443 } },
  ]);
  const parent = {
    id: 900, failoverEnabled: true, routeMode: "failover", routePaths, failoverStrategy: "fallback",
    targetIp: "203.0.113.10", targetPort: 443, hostId: 1,
  } as any;
  // 入口报了在走主线路（拨的是落地）：备用线路上的中继是候补
  const relayOnBackup = { routePathKey: "backup" };
  assert.equal(routeHopRelayIsStandby({ ...parent, failoverActiveTarget: "203.0.113.10:443" }, relayOnBackup), true);
  // 入口还没报过：不知道谁在走，不慢
  assert.equal(routeHopRelayIsStandby(parent, relayOnBackup), false);
  // 入口报的和任何线路都对不上：同样不慢
  assert.equal(routeHopRelayIsStandby({ ...parent, failoverActiveTarget: "198.51.100.9:1" }, relayOnBackup), false);
  // 几条一起走（轮流）：没有候补
  assert.equal(routeHopRelayIsStandby({ ...parent, failoverActiveTarget: "203.0.113.10:443", routeMode: "weighted", failoverStrategy: "round_robin" }, relayOnBackup), false);
});
