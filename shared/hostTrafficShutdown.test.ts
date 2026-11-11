import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTrafficShutdown,
  HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION,
  normalizeTrafficShutdownPercent,
  trafficShutdownTriggeredThisCycle,
} from "./hostTrafficShutdown";

const GB = 1024 ** 3;
const base = {
  host: { trafficShutdownEnabled: true, trafficShutdownThresholdPercent: 90, trafficLimit: 100 * GB } as Record<string, unknown>,
  usedBytes: 95 * GB,
  cycleMark: 1_700_000_000 as unknown,
  agentVersion: HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION as string,
  agentSupported: true as boolean | undefined,
};

test("门槛版本是具名常量 2.2.253", () => {
  assert.equal(HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION, "2.2.253");
});

test("开着、到了阈值、Agent 够新且能关、本周期没关过 → 该关", () => {
  const result = evaluateTrafficShutdown(base);
  assert.equal(result.due, true);
  assert.equal(result.thresholdBytes, 90 * GB);
});

test("默认关；没有套餐流量不关", () => {
  assert.deepEqual(evaluateTrafficShutdown({ ...base, host: { ...base.host, trafficShutdownEnabled: false } }), { due: false, reason: "disabled", thresholdBytes: null });
  assert.deepEqual(evaluateTrafficShutdown({ ...base, host: { trafficLimit: 100 * GB } }), { due: false, reason: "disabled", thresholdBytes: null });
  assert.equal((evaluateTrafficShutdown({ ...base, host: { ...base.host, trafficLimit: 0 } }) as any).reason, "no-limit");
});

test("Agent 太旧、没报过能不能关、不是 root Linux → 不关", () => {
  assert.equal((evaluateTrafficShutdown({ ...base, agentVersion: "2.2.252" }) as any).reason, "agent-too-old");
  assert.equal((evaluateTrafficShutdown({ ...base, agentVersion: "" }) as any).reason, "agent-too-old");
  assert.equal((evaluateTrafficShutdown({ ...base, agentSupported: undefined }) as any).reason, "agent-unsupported");
  assert.equal((evaluateTrafficShutdown({ ...base, agentSupported: false }) as any).reason, "agent-unsupported");
  assert.equal(evaluateTrafficShutdown({ ...base, agentVersion: "2.2.300" }).due, true);
});

test("没到阈值不关；同一周期只关一次，流量重置换了周期才重新生效", () => {
  assert.equal((evaluateTrafficShutdown({ ...base, usedBytes: 89 * GB }) as any).reason, "below-threshold");
  const triggered = { ...base.host, trafficShutdownTriggeredAt: 1_700_100_000, trafficShutdownCycleMark: base.cycleMark };
  assert.equal(trafficShutdownTriggeredThisCycle(triggered, base.cycleMark), true);
  assert.equal((evaluateTrafficShutdown({ ...base, host: triggered }) as any).reason, "already-triggered");
  // 重置过（resetAt 变了）
  assert.equal(evaluateTrafficShutdown({ ...base, host: triggered, cycleMark: 1_700_000_000 + 86_400 }).due, true);
  // 从没重置过的主机，周期标记是 0
  const neverReset = { ...base.host, trafficShutdownTriggeredAt: 1, trafficShutdownCycleMark: 0 };
  assert.equal(trafficShutdownTriggeredThisCycle(neverReset, null), true);
  // 重新布防（标记清空）
  assert.equal(trafficShutdownTriggeredThisCycle({ ...base.host, trafficShutdownTriggeredAt: null, trafficShutdownCycleMark: null }, 0), false);
});

test("阈值规整到 1–100", () => {
  assert.equal(normalizeTrafficShutdownPercent(undefined), 100);
  assert.equal(normalizeTrafficShutdownPercent(0), 1);
  assert.equal(normalizeTrafficShutdownPercent(250), 100);
  assert.equal(normalizeTrafficShutdownPercent("abc"), 100);
  assert.equal(normalizeTrafficShutdownPercent(55.7), 55);
});
