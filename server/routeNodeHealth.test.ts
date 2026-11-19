import assert from "node:assert/strict";
import test from "node:test";
import { agentFastLivenessTracker } from "./agentFastLiveness";
import {
  configureRouteNodeHealthForTests,
  ensureRouteNodeHealthFresh,
  getRouteNodeStatus,
  invalidateRouteNodeHealth,
} from "./routeNodeHealth";

/*
  线路里「这台机器在不在线」的提示（P12）：
    · 带快速存活上报的主机只认面板内存里的存活状态，不看库里可能滞后的 isOnline；
    · 读库失败时留着上一份快照，而不是变成一张空表（所有机器都查不到）。
*/

function row(id: number, isOnline: number, patch: Record<string, unknown> = {}) {
  return { id, name: `node-${id}`, isOnline, maintenanceMode: 0, trafficFailoverEnabled: 0, trafficLimit: 0, trafficFailoverExcluded: 0, ...patch };
}

test("带快速存活的主机按内存里的存活状态算在线，其余的按库里那一列", async () => {
  agentFastLivenessTracker.clear();
  // 主机 1、2 面板刚收到过上报（内存里是在线）；主机 2 在库里还是离线（离线 → 在线还没来得及落库）。
  const now = Date.now();
  try {
    agentFastLivenessTracker.registerHost({ id: 1, agentVersion: "2.2.264" }, { activityAt: now });
    agentFastLivenessTracker.registerHost({ id: 2, agentVersion: "2.2.264" }, { activityAt: now });
    configureRouteNodeHealthForTests(async () => [row(1, 1), row(2, 0), row(3, 1), row(4, 0)]);
    await ensureRouteNodeHealthFresh();
    assert.equal(getRouteNodeStatus(1)?.online, true);
    assert.equal(getRouteNodeStatus(2)?.online, true, "库里的离线标记滞后时，以面板刚收到的上报为准");
    assert.equal(getRouteNodeStatus(3)?.online, true, "没有快速存活状态的主机照旧看库");
    assert.equal(getRouteNodeStatus(4)?.online, false);
    assert.equal(getRouteNodeStatus(99), null);
  } finally {
    agentFastLivenessTracker.clear();
    configureRouteNodeHealthForTests(null);
  }
});

test("读库失败时留着上一份快照，不变成空表", async () => {
  agentFastLivenessTracker.clear();
  let fail = false;
  let reads = 0;
  configureRouteNodeHealthForTests(async () => {
    reads += 1;
    if (fail) throw new Error("connection lost");
    return [row(7, 1, { maintenanceMode: 1 })];
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await ensureRouteNodeHealthFresh();
    assert.deepEqual(getRouteNodeStatus(7), { id: 7, name: "node-7", online: true, maintenance: true, quota: false });
    fail = true;
    invalidateRouteNodeHealth();
    await ensureRouteNodeHealthFresh();
    assert.equal(reads, 2);
    assert.equal(getRouteNodeStatus(7)?.maintenance, true, "数据库出错时沿用上一份");
    // 失败后短时间内不再重读（两秒后才试），期间照样有数据
    await ensureRouteNodeHealthFresh();
    assert.equal(reads, 2);
    assert.equal(getRouteNodeStatus(7)?.online, true);
  } finally {
    console.warn = originalWarn;
    configureRouteNodeHealthForTests(null);
  }
});
