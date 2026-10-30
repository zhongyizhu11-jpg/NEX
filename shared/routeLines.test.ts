import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ROUTE_PATHS, parseRoutePaths, serializeRoutePaths, validateRouteGroup, newRouteGroupDraft, type RoutePath } from "./routeGroup";
import {
  expandRouteLines,
  newRouteLayer,
  newRouteLine,
  parseRouteLines,
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
