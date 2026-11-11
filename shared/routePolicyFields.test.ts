import assert from "node:assert/strict";
import test from "node:test";

import { routeGroupOf, type RouteGroupRule } from "./routeGroup";
import { ROUTE_POLICY_NON_POLICY_READS, ROUTE_POLICY_RULE_FIELDS } from "./routePolicyFields";

const paths = JSON.stringify([
  { key: "a", name: "主线路", hops: [], dest: { ip: "203.0.113.10", port: 80 }, weight: 50, probe: null, dial: null },
  { key: "b", name: "备用 1", hops: [], dest: { ip: "203.0.113.11", port: 80 }, weight: 50, probe: null, dial: null },
]);

/** 拿一个记录读取的代理去算策略：算的过程中读了规则的哪些列。 */
function columnsReadFor(rule: Record<string, unknown>) {
  const read = new Set<string>();
  const proxy = new Proxy(rule, {
    get(target, key, receiver) {
      if (typeof key === "string") read.add(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string") read.add(key);
      return Reflect.has(target, key);
    },
  });
  routeGroupOf(proxy as unknown as RouteGroupRule, { nowMs: Date.UTC(2026, 10, 10) });
  return read;
}

test("算线路组策略时读到的规则列，都在「调度字段清单」里：新加了调度参数却没进清单，这里会红", () => {
  const allowed = new Set<string>([...ROUTE_POLICY_RULE_FIELDS, ...ROUTE_POLICY_NON_POLICY_READS]);
  // 两种读法都走一遍：新式（有 routeMode）和老数据（没有 routeMode，从 failover* 列推模式）
  const base = { failoverEnabled: true, routePaths: paths, targetIp: "203.0.113.10", targetPort: 80, failoverPinnedIndex: 1, failoverPinnedUntil: null, failoverSchedule: JSON.stringify({ timezone: "UTC", windows: [{ days: [1], from: "18:00", to: "01:00", targetIndex: 1 }] }) };
  const read = new Set<string>([
    ...columnsReadFor({ ...base, routeMode: "hybrid", failoverStrategy: "fallback" }),
    ...columnsReadFor({ ...base, routeMode: null, failoverStrategy: "round_robin", failoverPreferFastest: true }),
  ]);
  const outside = Array.from(read).filter((key) => !allowed.has(key)).sort();
  assert.deepEqual(outside, [], `routePolicyOf 读了清单外的列：${outside.join("、")}。它们要是调度参数，加进 shared/routePolicyFields.ts 的 ROUTE_POLICY_RULE_FIELDS（子规则才会从模板带上）`);
});

test("清单里的每一列都真的被读法用到：没人读的列别留在清单里装样子", () => {
  // 钉着的时候才会去读到期时间，所以带上一个钉子
  const base = { failoverEnabled: true, routePaths: paths, targetIp: "203.0.113.10", targetPort: 80, failoverPinnedIndex: 1 };
  const read = new Set<string>([
    ...columnsReadFor({ ...base, routeMode: "hybrid", failoverStrategy: "fallback" }),
    ...columnsReadFor({ ...base, routeMode: null, failoverStrategy: "round_robin", failoverPreferFastest: true }),
  ]);
  const unused = ROUTE_POLICY_RULE_FIELDS.filter((key) => !read.has(key));
  assert.deepEqual(unused, []);
});
