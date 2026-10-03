import assert from "node:assert/strict";
import test from "node:test";

import { buildOverviewEdges, layoutOverview, overviewBends, OVERVIEW_PAD_X } from "./networkOverview";

const node = (id: number, geo?: [number, number]) => ({
  id, name: `h${id}`, city: "", health: "healthy" as const,
  geo: geo ? { lat: geo[0], lng: geo[1] } : null,
});

test("落位：按经纬度摆，西边的在左、北边的在上", () => {
  const placed = layoutOverview([node(1, [22.3, 114.2]), node(2, [35.7, 139.7]), node(3, [1.35, 103.8])], 800, 340);
  const byId = new Map(placed.map((item) => [item.id, item]));
  assert.ok(byId.get(3)!.x < byId.get(1)!.x && byId.get(1)!.x < byId.get(2)!.x, "新加坡 < 香港 < 东京（从西到东）");
  assert.ok(byId.get(2)!.y < byId.get(1)!.y && byId.get(1)!.y < byId.get(3)!.y, "东京在上，新加坡在下");
  for (const item of placed) {
    assert.ok(item.x >= OVERVIEW_PAD_X && item.x <= 800 - OVERVIEW_PAD_X);
  }
});

test("落位：跨太平洋的两台挨着画（经度按 0~360 算范围更小时换过去）", () => {
  const placed = layoutOverview([node(1, [37.4, -122]), node(2, [35.7, 139.7]), node(3, [22.3, 114.2])], 800, 340);
  const byId = new Map(placed.map((item) => [item.id, item]));
  assert.ok(byId.get(1)!.x > byId.get(2)!.x, "美西在东京的东边（右边），不是图的另一头");
});

test("落位：同城的几台推开，不叠在一起；没定位的排在底下", () => {
  const placed = layoutOverview([node(1, [22.3, 114.2]), node(2, [22.3, 114.2]), node(3, [22.31, 114.21]), node(4)], 600, 300);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i], b = placed[j];
      assert.ok(Math.abs(a.x - b.x) >= 40 || Math.abs(a.y - b.y) >= 30, `${a.id} 和 ${b.id} 叠在一起`);
    }
  }
  const unlocated = placed.find((item) => item.id === 4)!;
  assert.equal(unlocated.unlocated, true);
  assert.ok(placed.filter((item) => item.id !== 4).every((item) => item.y < unlocated.y), "没定位的在最下面一行");
});

test("连线：隧道按经过的主机拆段，转发按对；两头不在图上的不画；同一对主机的线往两边弯", () => {
  const model = {
    nodes: [1, 2, 3].map((id) => ({ ...node(id), countryCode: null, region: null, isOnline: true, linkCount: 0 })),
    links: [{ id: 9, name: "t", path: [1, 2, 3], health: "down" as const, hopLatencies: [], kind: "down" as const }],
  };
  const edges = buildOverviewEdges(model as any, [
    { fromHostId: 2, toHostId: 1, rules: 1, enabled: 0 },
    { fromHostId: 1, toHostId: 99, rules: 3, enabled: 3 },
  ]);
  assert.deepEqual(edges.map((edge) => `${edge.kind}:${edge.from}>${edge.to}:${edge.tone}`), [
    "tunnel:1>2:down",
    "tunnel:2>3:down",
    "forward:2>1:off",
  ]);
  const bends = overviewBends(edges);
  const a = bends.get(edges[0].key)!, b = bends.get(edges[2].key)!;
  // 1→2 和 2→1：方向相反，弯的符号相同才会分到两边（曲线法向跟着方向翻）
  assert.ok(Math.sign(a) === Math.sign(b) && Math.abs(a) !== Math.abs(b), `${a} / ${b}`);
});
