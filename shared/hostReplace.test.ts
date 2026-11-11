import assert from "node:assert/strict";
import test from "node:test";
import { parseRoutePaths } from "./routeGroup";
import { parseRouteLines } from "./routeLines";
import { defaultHostReplaceResolution, replaceIdInList, swapRouteLinesHost, swapRoutePathsHost } from "./hostReplace";

test("换 id：旧的换成新的，新的已经在里面就只是把旧的拿掉", () => {
  assert.deepEqual(replaceIdInList([1, 2, 3], 2, 9), [1, 9, 3]);
  assert.deepEqual(replaceIdInList([1, 2, 9], 2, 9), [1, 9]);
  assert.deepEqual(replaceIdInList([1, 3], 2, 9), [1, 3]);
});

test("路径里的中转换成新机，dial / issue 清掉等同步重算；没经过旧机的路径原样", () => {
  const raw = JSON.stringify([
    { key: "a", name: "主线路", hops: [5, 2], dest: null, weight: 50, probe: null, dial: { ip: "1.1.1.1", port: 1 }, issue: "x" },
    { key: "b", name: "备用", hops: [7], dest: null, weight: 50, probe: null, dial: { ip: "2.2.2.2", port: 2 } },
  ]);
  const swapped = swapRoutePathsHost(raw, 2, 9, 1);
  assert.equal(swapped.changed, true);
  assert.equal(swapped.blocked, null);
  const paths = parseRoutePaths(swapped.routePaths);
  assert.deepEqual(paths.map((path) => path.hops), [[5, 9], [7]]);
  assert.equal(paths[0].dial, null);
  assert.deepEqual(paths[1].dial, { ip: "2.2.2.2", port: 2 });
});

test("新机已经在这条路径上、或者新机就是入口时，换不了", () => {
  const raw = JSON.stringify([{ key: "a", name: "主线路", hops: [2, 9], dest: null, weight: 50, probe: null, dial: null }]);
  assert.ok(swapRoutePathsHost(raw, 2, 9, 1).blocked?.includes("已经经过新机"));
  const single = JSON.stringify([{ key: "a", name: "主线路", hops: [2], dest: null, weight: 50, probe: null, dial: null }]);
  assert.ok(swapRoutePathsHost(single, 2, 9, 9).blocked?.includes("入口"));
});

test("路径不经过旧机时什么都不改", () => {
  const raw = JSON.stringify([{ key: "a", name: "主线路", hops: [3], dest: null, weight: 50, probe: null, dial: null }]);
  assert.deepEqual(swapRoutePathsHost(raw, 2, 9, 1), { routePaths: null, changed: false, blocked: null, landingMember: false });
});

test("线路层里的候选机器换成新机，节点池层不动", () => {
  const raw = JSON.stringify([{
    key: "l1",
    name: "主线路",
    layers: [{ kind: "hosts", hostIds: [2, 4], pick: "best" }, { kind: "pool", poolId: 3, pick: "best" }],
    dests: [],
    weight: 50,
  }]);
  const swapped = swapRouteLinesHost(raw, 2, 9);
  assert.equal(swapped.changed, true);
  const lines = parseRouteLines(swapped.routeLines);
  assert.deepEqual(lines[0].layers[0].hostIds, [9, 4]);
  assert.equal(lines[0].layers[1].poolId, 3);
});

test("冲突默认能换端口就换，只能跳过的就跳过", () => {
  assert.equal(defaultHostReplaceResolution({ options: ["newPort", "skip"] }), "newPort");
  assert.equal(defaultHostReplaceResolution({ options: ["skip"] }), "skip");
});
