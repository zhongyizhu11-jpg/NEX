import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ROUTE_PATHS, isDefaultRouteLineName, parseRoutePaths, routeDestSpreadReady, routeDestSpreadTargetFields, routePathLabel, routePathLandingKey, serializeRoutePaths, validateRouteGroup, newRouteGroupDraft, type RoutePath } from "./routeGroup";
import {
  expandRouteLines,
  newRouteLayer,
  newRouteLine,
  parseRouteLines,
  routeLinesForEditor,
  routeLinesFromPaths,
  routeLinesOf,
  serializeRouteLines,
  type RouteExpandContext,
  type RouteLine,
} from "./routeLines";

const HOSTS: Record<number, { online: boolean; maintenance?: boolean }> = {
  1: { online: true }, // 入口
  2: { online: true },
  3: { online: true },
  4: { online: false },
  5: { online: true, maintenance: true },
  6: { online: true },
  9: { online: true }, // 隧道出口
};

function ctx(patch: Partial<RouteExpandContext> = {}): RouteExpandContext {
  return {
    entryHostId: 1,
    poolMembers: (poolId) => (poolId === 7 ? [2, 3, 4, 5] : null),
    hostUsable: (hostId) => !!HOSTS[hostId]?.online && !HOSTS[hostId]?.maintenance,
    tunnel: (tunnelId) => (tunnelId === 50 ? { id: 50, entryHostId: 1, exitHostId: 9, name: "华南-香港", usable: true } : tunnelId === 51 ? { id: 51, entryHostId: 2, exitHostId: 6, name: "HK-JP", usable: true } : null),
    estimateMs: (from, to) => ({ "0-2": 30, "0-3": 10, "0-9": 5, "2-6": 20, "9-6": 15 } as Record<string, number>)[`${from}-${to}`] ?? null,
    ...patch,
  };
}

function line(key: string, patch: Partial<RouteLine> = {}): RouteLine {
  return { ...newRouteLine(0), key, name: key, ...patch };
}

test("一层一个池：维护中、离线的跳过，按估计延迟排，主线路一组 tier 0", () => {
  const main = line("main", { layers: [newRouteLayer({ kind: "pool", poolId: 7 })] });
  const backup = line("bk", { layers: [newRouteLayer({ kind: "hosts", hostIds: [6] })] });
  const { paths, issues } = expandRouteLines([main, backup], ctx());
  assert.equal(issues.size, 0);
  const mainPaths = paths.filter((path) => path.lineKey === "main");
  assert.deepEqual(mainPaths.map((path) => path.hops), [[3], [2]]);
  assert.ok(mainPaths.every((path) => path.tier === 0));
  assert.deepEqual(paths.filter((path) => path.lineKey === "bk").map((path) => [path.hops, path.tier, path.key]), [[[6], 1, "bk"]]);
  // 组合不变 key 就不变
  const again = expandRouteLines([main, backup], ctx()).paths;
  assert.deepEqual(again.map((path) => path.key), paths.map((path) => path.key));
});

test("可跳过的层多一个直连选项；落地多个候选各出一条", () => {
  const main = line("main", {
    layers: [newRouteLayer({ kind: "hosts", hostIds: [2], skippable: true, pick: "order" })],
    dests: [{ dest: { ip: "1.1.1.1", port: 443 }, destNodeId: null }, { dest: { ip: "2.2.2.2", port: 443 }, destNodeId: null }],
  });
  const { paths } = expandRouteLines([main], ctx());
  assert.equal(paths.length, 4);
  assert.deepEqual(paths.map((path) => [path.hops.join(","), path.dest?.ip]), [["2", "1.1.1.1"], ["2", "2.2.2.2"], ["", "1.1.1.1"], ["", "2.2.2.2"]]);
});

test("隧道段：入口得是上一个节点，走完到出口机，hopVia 记隧道", () => {
  const ok = line("t", { layers: [newRouteLayer({ kind: "tunnel", tunnelIds: [50] }), newRouteLayer({ kind: "hosts", hostIds: [6] })] });
  const { paths, issues } = expandRouteLines([ok], ctx());
  assert.equal(issues.size, 0);
  assert.deepEqual(paths[0].hops, [9, 6]);
  assert.deepEqual(paths[0].hopVia, [50, null]);
  // 隧道 51 的入口是 2，不是入口机：接不上
  const bad = line("b", { layers: [newRouteLayer({ kind: "tunnel", tunnelIds: [51] })] });
  const result = expandRouteLines([bad], ctx());
  assert.equal(result.paths.length, 0);
  assert.match(result.issues.get("b") || "", /入口不是上一个节点/);
  // 先经 2，再走 51：接得上
  const chained = line("c", { layers: [newRouteLayer({ kind: "hosts", hostIds: [2] }), newRouteLayer({ kind: "tunnel", tunnelIds: [51] })] });
  assert.deepEqual(expandRouteLines([chained], ctx()).paths[0].hopVia, [null, 51]);
});

test("总数不超过上限：每条线路先保一条，余下主线路先拿", () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ dest: { ip: `10.0.0.${index + 1}`, port: 80 }, destNodeId: null }));
  const main = line("main", { dests: many, layers: [newRouteLayer({ kind: "hosts", hostIds: [2, 3, 6] })] });
  const backups = [line("b1", { layers: [newRouteLayer({ kind: "hosts", hostIds: [6] })] }), line("b2")];
  const { paths } = expandRouteLines([main, ...backups], ctx());
  assert.equal(paths.length, MAX_ROUTE_PATHS);
  assert.equal(paths.filter((path) => path.lineKey === "b1").length, 1);
  assert.equal(paths.filter((path) => path.lineKey === "b2").length, 1);
  assert.equal(paths.filter((path) => path.lineKey === "main").length, MAX_ROUTE_PATHS - 2);
  // 路径按线路顺序排：tier 不降
  assert.deepEqual(paths.map((path) => path.tier), [...paths.map((path) => path.tier)].sort((a, b) => Number(a) - Number(b)));
});

test("一层全用不了：这条线路记 issue、不出路径，别的线路照常", () => {
  const dead = line("dead", { layers: [newRouteLayer({ kind: "hosts", hostIds: [4, 5] })] });
  const live = line("live");
  const { paths, issues } = expandRouteLines([dead, live], ctx());
  assert.deepEqual(paths.map((path) => path.lineKey), ["live"]);
  assert.match(issues.get("dead") || "", /用不了/);
});

test("暂停的线路展开的路径带 paused；全暂停不让保存", () => {
  const { paths } = expandRouteLines([line("a", { paused: true }), line("b", { layers: [newRouteLayer({ kind: "hosts", hostIds: [2] })] })], ctx());
  assert.equal(paths[0].paused, true);
  const group = newRouteGroupDraft({ timezone: "Asia/Shanghai" });
  group.paths = paths.map((path) => ({ ...path, paused: true }));
  assert.match(validateRouteGroup(group, { entryHostId: 1, hasRuleTarget: true }) || "", /暂停/);
});

test("序列化来回不丢；老路径推线路再展开得到同样的路径", () => {
  const lines = [line("main", { layers: [newRouteLayer({ kind: "pool", poolId: 7, skippable: true }), newRouteLayer({ kind: "tunnel", tunnelIds: [51] })], dests: [{ dest: null, destNodeId: 12 }] })];
  assert.deepEqual(parseRouteLines(serializeRouteLines(lines)), lines);
  const old: RoutePath[] = parseRoutePaths(JSON.stringify([
    { key: "main", name: "", hops: [], dest: null, weight: 50, probe: null, dial: null },
    { key: "backup", name: "备用", hops: [2, 6], dest: { ip: "3.3.3.3", port: 1 }, weight: 50, probe: null, dial: null },
  ]));
  const derived = routeLinesFromPaths(old);
  assert.deepEqual(derived.map((item) => item.key), ["main", "backup"]);
  const expanded = expandRouteLines(derived, ctx()).paths;
  assert.deepEqual(expanded.map((path) => [path.key, path.hops, path.dest]), [["main", [], null], ["backup", [2, 6], { ip: "3.3.3.3", port: 1 }]]);
  assert.deepEqual(routeLinesOf({ routePaths: serializeRoutePaths(old), routeLines: null }).map((item) => item.key), ["main", "backup"]);
  // 新字段在路径 JSON 里来回不丢
  const withTier = parseRoutePaths(serializeRoutePaths(expanded));
  assert.deepEqual(withTier.map((path) => [path.tier, path.lineKey]), [[0, "main"], [1, "backup"]]);
});

test("中继布局：没有隧道段和以前一样；隧道段建在上一个节点，出口直接拨后面", async () => {
  const { routePathRelayPlan, ROUTE_ENTRY_RELAY_INDEX } = await import("./routeLines");
  const plain = routePathRelayPlan({ hops: [2, 3] });
  assert.deepEqual(plain.slots.map((slot) => [slot.hopIndex, slot.hostId, slot.tunnelId, slot.target]), [
    [0, 2, null, { kind: "relay", node: 2, loopback: false }],
    [1, 3, null, { kind: "landing" }],
  ]);
  assert.deepEqual(plain.dial, { kind: "relay", node: 1, loopback: false });
  assert.deepEqual(routePathRelayPlan({ hops: [] }).dial, { kind: "landing" });
  // 入口 →(隧道 50)→ 出口 9 → 落地：入口机上一条走隧道的中继，调度器拨本机。
  const tunnel = routePathRelayPlan({ hops: [9], hopVia: [50] });
  assert.deepEqual(tunnel.slots.map((slot) => [slot.hopIndex, slot.hostId, slot.tunnelId, slot.target]), [[ROUTE_ENTRY_RELAY_INDEX, null, 50, { kind: "landing" }]]);
  assert.deepEqual(tunnel.dial, { kind: "relay", node: 0, loopback: true });
  // 入口 →(隧道 50)→ 9 → 6 → 落地：隧道出口拨 6 上的中继；9 自己不建。
  const mixed = routePathRelayPlan({ hops: [9, 6], hopVia: [50, null] });
  assert.deepEqual(mixed.slots.map((slot) => [slot.hostId, slot.tunnelId, slot.target]), [
    [null, 50, { kind: "relay", node: 2, loopback: false }],
    [6, null, { kind: "landing" }],
  ]);
  // 入口 → 2 →(隧道 51)→ 6 →(隧道 52)→ 7 → 落地：6 上有中继（接 52），51 的出口拨本机。
  const chained = routePathRelayPlan({ hops: [2, 6, 7], hopVia: [null, 51, 52] });
  assert.deepEqual(chained.slots.map((slot) => [slot.hostId, slot.tunnelId, slot.target]), [
    [2, 51, { kind: "relay", node: 2, loopback: true }],
    [6, 52, { kind: "landing" }],
  ]);
});

test("线路上的探测地址：存得下、展开给每条路径；老路径推线路时带过来", () => {
  const probe = { ip: "203.0.113.80", port: 443 };
  const lines = [line("main", { layers: [newRouteLayer({ kind: "hosts", hostIds: [2, 3] })], probe }), line("bk")];
  const parsed = parseRouteLines(serializeRouteLines(lines));
  assert.deepEqual(parsed[0].probe, probe);
  assert.equal(parsed[1].probe, undefined, "没填的不写");
  const { paths } = expandRouteLines(parsed, ctx());
  for (const path of paths.filter((item) => item.lineKey === "main")) assert.deepEqual(path.probe, probe, "以前展开时写死 null，编辑框里填了也丢");
  assert.equal(paths.find((item) => item.lineKey === "bk")?.probe, null);
  const back = routeLinesFromPaths(paths.filter((item) => item.lineKey === "main"));
  assert.deepEqual(back[0].probe, probe);
});

test("编辑框只认线路：存的线路 → 存的路径 → 老 failover 列推出来的路径 → 一条空主线路", () => {
  const stored = [line("main", { layers: [newRouteLayer({ kind: "hosts", hostIds: [2] })] })];
  assert.equal(routeLinesForEditor({ routeLines: serializeRouteLines(stored), routePaths: null }, [])[0].key, "main");
  const legacyPaths = expandRouteLines([line("a", { layers: [newRouteLayer({ kind: "hosts", hostIds: [3] })] })], ctx()).paths;
  const fromLegacy = routeLinesForEditor({ routeLines: null, routePaths: null }, legacyPaths);
  assert.equal(fromLegacy.length, 1);
  assert.deepEqual(fromLegacy[0].layers[0].hostIds, [3]);
  const empty = routeLinesForEditor({ routeLines: null, routePaths: null }, []);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].layers.length, 0);
});

test("按权重：一条线路一个数，展开出来的几条路径一起分它那一份（候选多的线路不会多分）", () => {
  const main = line("main", { weight: 60, layers: [newRouteLayer({ kind: "pool", poolId: 7 })] }); // 池里能用的 2 台 → 2 条路径
  const backup = line("bk", { weight: 40, layers: [newRouteLayer({ kind: "hosts", hostIds: [6] })] });
  const { paths } = expandRouteLines([main, backup], ctx());
  const sum = (key: string) => paths.filter((path) => path.lineKey === key).reduce((total, path) => total + path.weight, 0);
  assert.deepEqual(paths.filter((path) => path.lineKey === "main").map((path) => path.weight), [30, 30]);
  assert.equal(sum("main"), 60);
  assert.equal(sum("bk"), 40);
});

// ---------------------------------------------------------------- 落地池（2.3.500）

const LANDING = (nodeId: number) => (nodeId === 88
  ? { poolId: 40, name: "亚太落地池", members: [{ hostId: 6, dest: { ip: "198.18.0.6", port: 443 } }, { hostId: 3, dest: { ip: "198.18.0.3", port: 443 } }, { hostId: 2, dest: { ip: "198.18.0.2", port: 20001 } }] }
  : nodeId === 89 ? { poolId: 41, name: "空池", members: [] } : null);

test("落地选了落地池的池节点：一台成员一条路径，路径带 destHostId，key 按机器算（换 IP 不变）", () => {
  const { paths, issues } = expandRouteLines([line("main", { dests: [{ dest: null, destNodeId: 88 }] })], ctx({ landingPool: LANDING }));
  assert.equal(issues.size, 0);
  assert.deepEqual(paths.map((path) => [path.destNodeId, path.destHostId, path.dest?.port]), [[88, 6, 443], [88, 3, 443], [88, 2, 20001]]);
  const moved = expandRouteLines([line("main", { dests: [{ dest: null, destNodeId: 88 }] })], ctx({
    landingPool: (nodeId) => {
      const info = LANDING(nodeId);
      return info ? { ...info, members: info.members.map((member) => ({ ...member, dest: { ip: `10.0.0.${member.hostId}`, port: member.dest.port } })) } : null;
    },
  }));
  assert.deepEqual(moved.paths.map((path) => path.key), paths.map((path) => path.key), "成员换了地址，路径 key 不变（历史留着）");
  const roundTrip = parseRoutePaths(serializeRoutePaths(paths));
  assert.deepEqual(roundTrip.map((path) => path.destHostId), [6, 3, 2]);
  assert.deepEqual(routeLinesFromPaths(roundTrip)[0].dests, [{ dest: null, destNodeId: 88 }], "还原成线路：几台成员是同一个落地候选");
});

test("规则目标绑着池节点：「规则目标」那个落地展开成池里几台；成员是入口或这条路上的中转就跳过", () => {
  const { paths } = expandRouteLines([line("main", { layers: [newRouteLayer({ hostIds: [2] })] })], ctx({ landingPool: LANDING, ruleTargetNodeId: 88 }));
  assert.deepEqual(paths.map((path) => [path.hops.join("."), path.destHostId]), [["2", 6], ["2", 3]], "经 2 中转时不落回 2");
  const empty = expandRouteLines([line("main", { dests: [{ dest: null, destNodeId: 89 }] })], ctx({ landingPool: LANDING }));
  assert.equal(empty.paths.length, 0);
  assert.match(String(empty.issues.get("main")), /空池/);
});

test("落地池的几台不算重复路径；同一台出现两次才算", () => {
  const { paths } = expandRouteLines([line("main", { dests: [{ dest: null, destNodeId: 88 }] })], ctx({ landingPool: LANDING }));
  const group = { ...newRouteGroupDraft({ timezone: "Asia/Shanghai" }), paths };
  assert.equal(validateRouteGroup({ paths, policy: group.policy } as any, { entryHostId: 1, hostIds: null, hasRuleTarget: true, rejectDuplicates: true }), null);
  const twice = [paths[0], { ...paths[0], key: "dup" }];
  assert.match(String(validateRouteGroup({ paths: twice, policy: group.policy } as any, { entryHostId: 1, hostIds: null, hasRuleTarget: true, rejectDuplicates: true })), /同一条/);
});

// ---------------------------------------------------------------- 并列和别的线路重叠、默认名按位置（2.3.500）

const VALIDATE = { entryHostId: 1, hostIds: null, hasRuleTarget: true, rejectDuplicates: true } as const;
const policyOf = () => newRouteGroupDraft({ timezone: "Asia/Shanghai" }).policy;

test("备用并列的一台和主线路那条重了：只展开新的那台，照样能保存", () => {
  const main = line("main", { layers: [newRouteLayer({ kind: "hosts", hostIds: [2] })] });
  const backup = line("bk1", { layers: [newRouteLayer({ kind: "hosts", hostIds: [3, 2] })] });
  const { paths, issues } = expandRouteLines([main, backup], ctx());
  assert.equal(issues.size, 0);
  assert.deepEqual(paths.map((path) => [path.lineKey, path.hops.join("."), path.tier]), [["main", "2", 0], ["bk1", "3", 1]], "经 2 那条已经在主线路，备 1 只留经 3");
  assert.equal(validateRouteGroup({ paths, policy: policyOf() } as any, VALIDATE), null);
});

test("主线路「直连 / 2」、备 1 只经 2：备 1 整条和主线路重了，保存时点名两条", () => {
  const main = line("main", { name: "主线路", layers: [newRouteLayer({ kind: "hosts", hostIds: [2], skippable: true })] });
  const backup = line("bk1", { name: "备用 1", layers: [newRouteLayer({ kind: "hosts", hostIds: [2] })] });
  const { paths } = expandRouteLines([main, backup], ctx());
  assert.deepEqual(paths.filter((path) => path.lineKey === "main").map((path) => path.hops.join(".")).sort(), ["", "2"], "主线路直连、经 2 各一条");
  assert.deepEqual(paths.filter((path) => path.lineKey === "bk1").map((path) => path.hops.join(".")), ["2"], "整条都重的线路照样展开，让检查点出来");
  assert.match(String(validateRouteGroup({ paths, policy: policyOf() } as any, VALIDATE)), /「主线路」和「备用 1」走的是同一条路/);
});

test("两条直连线路各并列一台：主线路「直连 / 2」、备 1「直连 / 3」，备 1 只多出经 3 那条", () => {
  const main = line("main", { layers: [newRouteLayer({ kind: "hosts", hostIds: [2], skippable: true })] });
  const backup = line("bk1", { layers: [newRouteLayer({ kind: "hosts", hostIds: [3], skippable: true })] });
  const { paths } = expandRouteLines([main, backup], ctx());
  assert.deepEqual(paths.filter((path) => path.lineKey === "bk1").map((path) => path.hops.join(".")), ["3"], "直连那条主线路已经有了");
  assert.equal(validateRouteGroup({ paths, policy: policyOf() } as any, VALIDATE), null);
});

test("默认名字按线路现在的位置叫：删了主线路，原来的「备用 1」就是主线路；人起的名字不变", () => {
  const lines = [
    line("a", { name: "备用 1", layers: [newRouteLayer({ kind: "hosts", hostIds: [2] })] }),
    line("b", { name: "主线路", layers: [newRouteLayer({ kind: "hosts", hostIds: [3] })] }),
    line("c", { name: "晚高峰", layers: [newRouteLayer({ kind: "hosts", hostIds: [6] })] }),
    line("d", { name: "", layers: [] }),
  ];
  const { paths } = expandRouteLines(lines, ctx());
  assert.deepEqual(paths.map((path) => path.name), ["主线路", "备用 1", "晚高峰", "备用 3"]);
  // 老数据里存着的路径名（2.3.499 以前展开时写进去的）按 tier 叫
  assert.equal(routePathLabel({ name: "备用 1", tier: 0 }, 3), "主线路");
  assert.equal(routePathLabel({ name: "备用", tier: 2 }, 0), "备用 2");
  assert.equal(routePathLabel({ name: "主线路" }, 1), "备用 1", "没有 tier 的老路径按自己的位置");
  assert.equal(routePathLabel({ name: "晚高峰", tier: 0 }, 0), "晚高峰");
  for (const name of ["主线路", "主", "备用", "备用线路", "备用 2", "备2", "备 12"]) assert.ok(isDefaultRouteLineName(name), `「${name}」是默认名`);
  for (const name of ["晚高峰", "备用香港", "主力"]) assert.equal(isDefaultRouteLineName(name), false, `「${name}」是人起的`);
});

test("暂停的线路不占路：主线路停着时备 1 里和它重的那台照样展开，保存不报重复", () => {
  const main = line("main", { paused: true, layers: [newRouteLayer({ kind: "hosts", hostIds: [2] })] });
  const backup = line("bk1", { layers: [newRouteLayer({ kind: "hosts", hostIds: [3, 2] })] });
  const { paths } = expandRouteLines([main, backup], ctx());
  assert.deepEqual(paths.filter((path) => path.lineKey === "main").map((path) => [path.hops.join("."), !!path.paused]), [["2", true]], "主线路照样展开，带 paused");
  assert.deepEqual(paths.filter((path) => path.lineKey === "bk1").map((path) => path.hops.join(".")).sort(), ["2", "3"], "主线路停着，备 1 两台都在");
  assert.equal(validateRouteGroup({ paths, policy: policyOf() } as any, VALIDATE), null);
  // 主线路没停：经 2 归主线路，备 1 只剩经 3
  const active = expandRouteLines([{ ...main, paused: false }, backup], ctx()).paths;
  assert.deepEqual(active.filter((path) => path.lineKey === "bk1").map((path) => path.hops.join(".")), ["3"]);
});

// ---------------------------------------------------------------- 多落地怎么用（2.3.501）

test("线路的「落地怎么分」：存得下、认不出的当主备；展开时带到这条线路的每条路径上，路径存取不丢、还原回线路", () => {
  const raw = serializeRouteLines([
    line("main", { dests: [{ dest: { ip: "1.1.1.1", port: 443 }, destNodeId: null }, { dest: { ip: "2.2.2.2", port: 443 }, destNodeId: null }], destSpread: "least_load" }),
    line("bk", { layers: [newRouteLayer({ kind: "hosts", hostIds: [6] })], destSpread: "one" }),
  ]);
  assert.match(String(raw), /"destSpread":"least_load"/);
  assert.doesNotMatch(String(raw), /"destSpread":"one"/, "主备不存");
  const lines = parseRouteLines(raw);
  assert.equal(lines[0].destSpread, "least_load");
  assert.equal(lines[1].destSpread, undefined);
  assert.equal(parseRouteLines(JSON.stringify([{ key: "x", name: "x", layers: [], dests: [], weight: 50, destSpread: "bogus" }]))[0].destSpread, undefined, "认不出的当主备");

  const { paths } = expandRouteLines(lines, ctx());
  assert.deepEqual(paths.map((path) => [path.lineKey, path.destSpread ?? null]), [["main", "least_load"], ["main", "least_load"], ["bk", null]]);
  const roundTrip = parseRoutePaths(serializeRoutePaths(paths));
  assert.deepEqual(roundTrip.map((path) => path.destSpread ?? null), ["least_load", "least_load", null]);
  assert.equal(routeLinesFromPaths(roundTrip)[0].destSpread, "least_load", "老数据只有路径时还原回线路也带着");
});

test("落地是哪一个：落地池按池节点 + 成员机，节点按节点，地址按地址，没写是规则目标；经不同中转到同一个落地算一个", () => {
  assert.equal(routePathLandingKey({ dest: { ip: "198.18.0.6", port: 443 }, destNodeId: 88, destHostId: 6 }), "n88h6");
  assert.equal(routePathLandingKey({ dest: { ip: "203.0.113.7", port: 443 }, destNodeId: 7 }), "n7");
  assert.equal(routePathLandingKey({ dest: { ip: "203.0.113.7", port: 443 }, destNodeId: null }), "203.0.113.7:443");
  assert.equal(routePathLandingKey({ dest: null, destNodeId: null }), "target");
  const main = line("main", { layers: [newRouteLayer({ kind: "hosts", hostIds: [2, 3] })], dests: [{ dest: null, destNodeId: 88 }], destSpread: "round_robin" });
  const { paths } = expandRouteLines([main], ctx({ landingPool: LANDING }));
  // 经 2：落到 6、3（不落回 2）；经 3：落到 6、2 —— 4 条路径、3 个落地
  assert.equal(paths.length, 4);
  assert.deepEqual([...new Set(paths.map(routePathLandingKey))].sort(), ["n88h2", "n88h3", "n88h6"]);
  assert.ok(paths.every((path) => path.destSpread === "round_robin"));
});

test("下发给 Agent：一次走一条线路、有线路选了一起分、Agent 够新才带；按权重 / 聚合（分层）/ 老 Agent 不带", () => {
  const main = line("main", { dests: [{ dest: { ip: "1.1.1.1", port: 443 }, destNodeId: null }, { dest: { ip: "2.2.2.2", port: 443 }, destNodeId: null }], destSpread: "ip_hash" });
  const backup = line("bk", { layers: [newRouteLayer({ kind: "hosts", hostIds: [6] })] });
  const { paths } = expandRouteLines([main, backup], ctx());
  const newAgent = () => true;
  const oldAgent = (version: string) => version !== "2.2.245";
  assert.equal(routeDestSpreadReady({ strategy: "fallback", tiered: false, paths, agentAtLeast: newAgent }), true);
  assert.equal(routeDestSpreadReady({ strategy: "least_load", tiered: false, paths, agentAtLeast: newAgent }), false, "按权重（整组分）不带");
  assert.equal(routeDestSpreadReady({ strategy: "fallback", tiered: true, paths, agentAtLeast: newAgent }), false, "聚合 / 复制（分层）不带");
  assert.equal(routeDestSpreadReady({ strategy: "fallback", tiered: false, paths, agentAtLeast: oldAgent }), false, "老 Agent 不带");
  assert.equal(routeDestSpreadReady({ strategy: "fallback", tiered: false, paths: expandRouteLines([backup], ctx()).paths, agentAtLeast: newAgent }), false, "没有线路选一起分不带");
  assert.deepEqual(paths.map((path) => routeDestSpreadTargetFields(path, true)), [
    { line: 0, landing: "1.1.1.1:443", spread: "ip_hash" },
    { line: 0, landing: "2.2.2.2:443", spread: "ip_hash" },
    {},
  ]);
  assert.deepEqual(routeDestSpreadTargetFields(paths[0], false), {});
});
