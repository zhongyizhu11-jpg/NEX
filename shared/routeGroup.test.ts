import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ROUTE_PATHS,
  applyRouteMode,
  describeRoutePath,
  describeRouteReason,
  legacyFailoverFields,
  legacyRoutePaths,
  parseRoutePaths,
  routeAgentStrategy,
  routeGroupOf,
  routePathDial,
  routePathLabel,
  routePolicyOf,
  routeTemplateGuards,
  routeWeightShares,
  serializeRoutePaths,
  validateRouteGroup,
  type RouteGroup,
  type RoutePath,
} from "./routeGroup";

/**
 * 线路组的模型：路径、六种模式、模板、和老主备列的互推。
 *
 * 老 failover* 列由线路组推导出来，老 Agent 和一大批读规则的代码靠它们；推错了的表现是
 * 「面板上配的是路径 B 走中转，机器上拨的却是落地」—— 而且没有任何地方会报错。
 */

const path = (overrides: Partial<RoutePath>): RoutePath => ({
  key: "p", name: "", hops: [], dest: null, weight: 50, probe: null, dial: null, issue: null, ...overrides,
});

const rule = { targetIp: "198.51.100.7", targetPort: 443 };

test("routePaths 一列解析：认不出的扔掉、key 去重、中转去重截断", () => {
  const parsed = parseRoutePaths(JSON.stringify([
    { key: "main", name: "主线路", hops: [3, 3, 5], dest: null, weight: 70 },
    { key: "main", name: "撞 key", hops: [], dest: { ip: "203.0.113.9", port: 443 }, weight: 30, probe: { ip: "203.0.113.9", port: 9000 } },
    "not a path",
    { key: "BAD KEY!", hops: [1, 2, 3, 4, 5, 6, 7], dest: { ip: "", port: 1 } },
  ]));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0].hops, [3, 5]);
  assert.equal(parsed[1].key, "main-2", "第二条撞了 key 该改名，不该覆盖第一条");
  assert.deepEqual(parsed[1].probe, { ip: "203.0.113.9", port: 9000 });
  assert.equal(parsed[2].key, "p4", "非法 key 按序号给一个");
  assert.equal(parsed[2].hops.length, 5, "中转最多五台");
  assert.equal(parsed[2].dest, null, "空地址的落地当没填");
  assert.deepEqual(parseRoutePaths("{not json"), []);
});

test("序列化和解析互为反函数", () => {
  const paths = [
    path({ key: "a", name: "香港主线路", hops: [2, 4], weight: 70, dial: { ip: "10.0.0.2", port: 40001 } }),
    path({ key: "b", name: "晚高峰", dest: { ip: "203.0.113.9", port: 443 }, weight: 30, issue: "中转离线" }),
  ];
  assert.deepEqual(parseRoutePaths(serializeRoutePaths(paths)), paths);
  assert.equal(serializeRoutePaths([]), null);
});

test("老主备推成路径：主线路是规则目标，备用各是一个直连落地，探测地址跟着走", () => {
  const paths = legacyRoutePaths({
    ...rule,
    failoverProbeTarget: "198.51.100.7:9000",
    failoverTargets: JSON.stringify([
      { targetIp: "198.51.100.8", targetPort: 443 },
      { targetIp: "198.51.100.9", targetPort: 443, probeIp: "198.51.100.9", probePort: 9000 },
    ]),
  });
  assert.equal(paths.length, 3);
  assert.deepEqual(paths[0].probe, { ip: "198.51.100.7", port: 9000 });
  assert.deepEqual(routePathDial(paths[0], rule), { ip: "198.51.100.7", port: 443 });
  assert.deepEqual(routePathDial(paths[1], rule), { ip: "198.51.100.8", port: 443 });
  assert.deepEqual(paths[2].probe, { ip: "198.51.100.9", port: 9000 });
  assert.equal(routePathLabel(paths[1], 1), "备用 1");
});

test("有中转而还没解析出拨号地址的路径拨不了，不能退回直连落地", () => {
  const viaRelay = path({ key: "b", hops: [7] });
  assert.equal(routePathDial(viaRelay, rule), null);
  assert.deepEqual(routePathDial({ ...viaRelay, dial: { ip: "10.0.0.7", port: 40010 } }, rule), { ip: "10.0.0.7", port: 40010 });
});

test("老数据的模式要推：分配方式不是主备的算权重负载，开了择优算智能，有时段表算定时", () => {
  assert.equal(routePolicyOf({ failoverStrategy: "round_robin" }).mode, "weighted");
  assert.equal(routePolicyOf({ failoverStrategy: "round_robin" }).spread, "round_robin");
  assert.equal(routePolicyOf({ failoverPreferFastest: true }).mode, "smart");
  const schedule = JSON.stringify({ timezone: "Asia/Shanghai", windows: [{ days: [], from: "18:00", to: "01:00", targetIndex: 1 }] });
  assert.equal(routePolicyOf({ failoverSchedule: schedule }).mode, "scheduled");
  assert.equal(routePolicyOf({ failoverSchedule: schedule, failoverPreferFastest: true }).mode, "hybrid");
  assert.equal(routePolicyOf({}).mode, "failover");
  // 存了模式就以它为准，不再猜。
  assert.equal(routePolicyOf({ routeMode: "manual", failoverPreferFastest: true }).mode, "manual");
  // 参数越界的收回范围里，没填的用默认值。
  const policy = routePolicyOf({ routeFailureThreshold: 99, routeScoreMargin: 0, routePrewarmSeconds: "abc" });
  assert.equal(policy.failureThreshold, 20);
  assert.equal(policy.scoreMargin, 1);
  assert.equal(policy.prewarmSeconds, 300);
});

test("线路组 → 老 failover 列：备用是各路径的拨号地址，模式决定策略、择优、时段表和指定", () => {
  const group: RouteGroup = {
    paths: [
      path({ key: "a", name: "A", hops: [2], dial: { ip: "10.0.0.2", port: 40001 }, probe: { ip: "203.0.113.1", port: 443 } }),
      path({ key: "b", name: "B", hops: [3], dial: { ip: "10.0.0.3", port: 40002 } }),
      path({ key: "c", name: "C", hops: [4] }),
    ],
    policy: {
      ...routeTemplateGuards("hybrid"),
      mode: "hybrid",
      spread: "weighted",
      schedule: { timezone: "Asia/Shanghai", windows: [{ days: [1], from: "18:00", to: "01:00", targetIndex: 1 }] },
      pin: { index: 1, untilMs: 1_800_000_000_000 },
    },
  };
  const legacy = legacyFailoverFields(group, rule);
  assert.equal(legacy.failoverStrategy, "fallback");
  assert.deepEqual(JSON.parse(legacy.failoverTargets), [{ targetIp: "10.0.0.3", targetPort: 40002 }], "没解析出拨号地址的 C 不能下发");
  assert.equal(legacy.failoverProbeTarget, "203.0.113.1:443");
  assert.equal(legacy.failoverPreferFastest, true);
  assert.ok(legacy.failoverSchedule, "混合模式带时段表");
  assert.equal(legacy.failoverPinnedIndex, 1);
  assert.equal(legacy.failoverPinnedUntil, 1_800_000_000_000);

  const weighted = legacyFailoverFields({ ...group, policy: { ...group.policy, mode: "weighted", spread: "ip_hash" } }, rule);
  assert.equal(weighted.failoverStrategy, "ip_hash");
  assert.equal(weighted.failoverSchedule, null, "权重负载没有首选，时段表不下发");
  assert.equal(weighted.failoverPinnedIndex, null);
  assert.equal(weighted.failoverPreferFastest, false);
  assert.equal(routeAgentStrategy({ mode: "weighted", spread: "weighted" }), "weighted");
  assert.equal(routeAgentStrategy({ mode: "smart", spread: "weighted" }), "fallback");
});

test("整个线路组只在开了主备时才有", () => {
  assert.equal(routeGroupOf({ failoverEnabled: false }), null);
  const group = routeGroupOf({ failoverEnabled: true, ...rule, failoverTargets: JSON.stringify([{ targetIp: "198.51.100.8", targetPort: 443 }]) });
  assert.equal(group?.paths.length, 2);
  assert.equal(group?.policy.mode, "failover");
});

test("换模式：参数按模板预填，定时和混合补默认时段，手动补指定，权重清掉指定", () => {
  const base = { ...routeTemplateGuards("failover"), mode: "failover" as const, spread: "weighted" as const, schedule: null, pin: null };
  const scheduled = applyRouteMode(base, "scheduled", { timezone: "Asia/Shanghai", pathCount: 3 });
  assert.equal(scheduled.schedule?.windows[0].targetIndex, 1);
  assert.equal(scheduled.schedule?.timezone, "Asia/Shanghai");
  const manual = applyRouteMode(base, "manual", { timezone: "Asia/Shanghai", pathCount: 2 });
  assert.deepEqual(manual.pin, { index: 0, untilMs: null });
  assert.equal(manual.minHoldSeconds, 0);
  const weighted = applyRouteMode({ ...base, pin: { index: 1, untilMs: null } }, "weighted", { timezone: "UTC", pathCount: 2 });
  assert.equal(weighted.pin, null);
  const smart = applyRouteMode(base, "smart", { timezone: "UTC", pathCount: 2 });
  assert.equal(smart.scoreMargin, 10);
  assert.equal(smart.minHoldSeconds, 600);
  assert.equal(smart.schedule, null);
  // 已经配好的时段表换到混合模式时要保留，不能被默认时段覆盖。
  const hybrid = applyRouteMode(scheduled, "hybrid", { timezone: "UTC", pathCount: 3 });
  assert.equal(hybrid.schedule?.timezone, "Asia/Shanghai");
});

test("校验：至少两条、中转不能是入口自己、时段和指定不能指向不存在的路径", () => {
  const context = { entryHostId: 1, hostIds: new Set([2, 3]), hasRuleTarget: true };
  const policy = { ...routeTemplateGuards("failover"), mode: "failover" as const, spread: "weighted" as const, schedule: null, pin: null };
  assert.match(validateRouteGroup({ paths: [path({ key: "a" })], policy }, context)!, /至少要两条/);
  assert.match(validateRouteGroup({ paths: [path({ key: "a" }), path({ key: "b", hops: [1] })], policy }, context)!, /入口机器自己/);
  assert.match(validateRouteGroup({ paths: [path({ key: "a" }), path({ key: "b", hops: [9] })], policy }, context)!, /不在你的主机列表/);
  assert.match(validateRouteGroup({ paths: [path({ key: "a" }), path({ key: "a" })], policy }, context)!, /标识重复/);
  assert.match(validateRouteGroup({ paths: [path({ key: "a" }), path({ key: "b" })], policy }, { ...context, hasRuleTarget: false })!, /没写落地/);
  const twoPaths = [path({ key: "a" }), path({ key: "b", hops: [2, 3] })];
  assert.equal(validateRouteGroup({ paths: twoPaths, policy }, context), null);
  assert.match(validateRouteGroup({ paths: twoPaths, policy: { ...policy, mode: "scheduled" } }, context)!, /至少配一个时段/);
  const schedule = { timezone: "UTC", windows: [{ days: [], from: "18:00", to: "01:00", targetIndex: 5 }] };
  assert.match(validateRouteGroup({ paths: twoPaths, policy: { ...policy, mode: "scheduled", schedule } }, context)!, /一共只有 2 条/);
  assert.match(validateRouteGroup({ paths: twoPaths, policy: { ...policy, mode: "manual" } }, context)!, /指定走哪条/);
  assert.match(validateRouteGroup({ paths: twoPaths, policy: { ...policy, mode: "manual", pin: { index: 4, untilMs: null } } }, context)!, /不存在了/);
  assert.equal(validateRouteGroup({ paths: Array.from({ length: MAX_ROUTE_PATHS + 1 }, (_, i) => path({ key: `p${i}` })), policy }, context)?.includes("最多"), true);
});

test("路径怎么走的一句话，和原因的翻译", () => {
  const names = new Map([[2, "东京中转 01"], [3, "大阪中转 01"]]);
  const text = describeRoutePath(path({ key: "a", hops: [2, 3] }), rule, (id) => names.get(id) || `主机 ${id}`);
  assert.equal(text, "东京中转 01 → 大阪中转 01 → 198.51.100.7:443");
  assert.equal(describeRoutePath(path({ key: "b", dest: { ip: "2001:db8::9", port: 443 } }), rule, () => ""), "[2001:db8::9]:443");
  assert.equal(describeRouteReason("health check"), "连续探测不通");
  assert.equal(describeRouteReason("relay down: 东京中转 01"), "中转异常：东京中转 01");
  assert.equal(describeRouteReason("precheck: 丢包 15%"), "预检未通过：丢包 15%");
  assert.equal(describeRouteReason("slow dial: 820ms x3, probe 40ms"), "新连接连续 3 次拨得慢（拨号约 820ms，探测 40ms）：记一次失败，立刻复查");
  assert.equal(describeRouteReason("slow dial: 600ms x3, probe 0ms"), "新连接连续 3 次拨得慢（拨号约 600ms）：记一次失败，立刻复查");
  assert.equal(describeRouteReason("something else"), "something else");
  assert.deepEqual(routeWeightShares([{ weight: 70 }, { weight: 30 }]), [70, 30]);
  assert.deepEqual(routeWeightShares([{ weight: 0 }, { weight: 0 }]), [50, 50]);
});
