import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOverviewEdges,
  bundleOverviewEdges,
  labelTextWidth,
  layoutOverview,
  overviewViewport,
  placeOverviewLabels,
  truncateLabel,
  OVERVIEW_PAD_X,
} from "./networkOverview";
import { worldCountriesPath, WORLD_COUNTRIES_UNIT } from "./worldCountries";

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

test("落位：跨太平洋的两台挨着画（经度按 0~360 算范围更小时换过去），底图也跟着换", () => {
  const nodes = [node(1, [37.4, -122]), node(2, [35.7, 139.7]), node(3, [22.3, 114.2])];
  const placed = layoutOverview(nodes, 800, 340);
  const byId = new Map(placed.map((item) => [item.id, item]));
  assert.ok(byId.get(1)!.x > byId.get(2)!.x, "美西在东京的东边（右边），不是图的另一头");
  const viewport = overviewViewport(nodes, 800, 340)!;
  assert.equal(viewport.wrap, true);
  assert.ok(Math.abs(viewport.x(-122 + 360) - byId.get(1)!.x) < 1, "主机点和底图用同一套投影");
});

test("取景：主机挤在一小片时至少取 60° × 30°，横竖比例尺一样大（地球图不变形）；一台都没定位时没有底图", () => {
  const viewport = overviewViewport([node(1, [22.3, 114.2]), node(2, [22.4, 114.3])], 390, 240)!;
  const innerW = 390 - OVERVIEW_PAD_X * 2;
  assert.ok(Math.abs(innerW / viewport.sx - 60) < 0.01, `经度范围 ${innerW / viewport.sx}`);
  assert.ok(Math.abs(viewport.sy - viewport.sx) < 1e-9, `${viewport.sx} / ${viewport.sy}`);
  assert.equal(overviewViewport([node(1)], 390, 240), null);
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

test("标签：城市 + 主机名两行，城市就是主机名时一行；挑不压别人的位置，都在画布里", () => {
  const placed = layoutOverview([node(1, [22.3, 114.2]), node(2, [22.3, 114.2]), node(3, [1.35, 103.8]), node(4)], 390, 240);
  const labels = placeOverviewLabels(placed.map((item) => ({ ...item, city: item.id === 3 ? "h3" : "香港", flag: "🇭🇰" })), 390, 240);
  assert.equal(labels[0].line1, "🇭🇰 香港");
  assert.equal(labels[0].line2, "h1");
  assert.equal(labels[2].line2, null, "城市和主机名一样只写一行");
  assert.equal(labels[2].height, 24);
  assert.equal(labels[3].line2, "未定位");
  const boxes = labels.map((label, index) => ({ x: placed[index].x + label.dx, y: placed[index].y + label.dy, w: label.width, h: label.height }));
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.x + box.w <= 390 && box.y >= 0 && box.y + box.h <= 240, `出画布 ${JSON.stringify(box)}`);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      const overlap = Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
      assert.ok(!overlap, `标签 ${i} 和 ${j} 叠在一起`);
    }
  }
  assert.ok(labelTextWidth("香港", 12) > labelTextWidth("HK", 12), "汉字比字母宽");
});

test("标签：太长的城市 / 主机名截掉加 …，胶囊不会比画布宽", () => {
  const longName = "hk-entry-node-with-a-really-long-name-01";
  const placed = layoutOverview([{ ...node(1, [22.3, 114.2]), name: longName }], 390, 240);
  const [label] = placeOverviewLabels(placed.map((item) => ({ ...item, city: "一个特别特别长的城市名字", flag: null })), 390, 240);
  assert.equal(label.line1, "一个特别特别长的城…");
  assert.equal(label.line2, "hk-entry-node-wit…");
  assert.ok(label.width <= 390 - 22, `${label.width}`);
  assert.equal(truncateLabel("🇭🇰 香港", 10), "🇭🇰 香港", "够短的原样");
});

test("连线：隧道按经过的主机拆段，转发按对；两头不在图上的不画；同一对主机合成一条，状态取最差", () => {
  const model = {
    nodes: [1, 2, 3].map((id) => ({ ...node(id), countryCode: null, region: null, isOnline: true, linkCount: 0 })),
    links: [
      { id: 9, name: "t", path: [1, 2, 3], health: "down" as const, hopLatencies: [], kind: "down" as const },
      { id: 10, name: "u", path: [1, 2], health: "healthy" as const, hopLatencies: [], kind: "healthy" as const },
    ],
  };
  const edges = buildOverviewEdges(model as any, [
    { fromHostId: 2, toHostId: 1, rules: 2, enabled: 0 },
    { fromHostId: 1, toHostId: 99, rules: 3, enabled: 3 },
  ]);
  assert.deepEqual(edges.map((edge) => `${edge.kind}:${edge.from}>${edge.to}:${edge.tone}`), [
    "tunnel:1>2:down",
    "tunnel:2>3:down",
    "tunnel:1>2:healthy".replace("healthy", "ok"),
    "forward:2>1:off",
  ]);
  const bundles = bundleOverviewEdges(edges);
  const offline = { ...model, nodes: model.nodes.map((item) => (item.id === 3 ? { ...item, health: "down" as const } : item)) };
  const toDown = buildOverviewEdges(offline as any, [{ fromHostId: 1, toHostId: 3, rules: 1, enabled: 1 }, { fromHostId: 1, toHostId: 3, rules: 1, enabled: 0 }]);
  assert.deepEqual(toDown.filter((edge) => edge.kind === "forward").map((edge) => edge.tone), ["warn", "off"], "开着的转发指向掉线主机算降级，停用的还是停用");
  assert.deepEqual(bundles.map((bundle) => `${bundle.key}:${bundle.tone}:${bundle.tunnels}t/${bundle.forwards}f`), ["1-2:down:2t/2f", "2-3:down:1t/0f"]);
  assert.deepEqual(bundles[0].tunnelNames, ["t", "u"]);
  // 两条同名隧道是两条；同一条隧道来回经过同一对主机只算一次
  const sameName = bundleOverviewEdges(buildOverviewEdges({
    ...model,
    links: [
      { id: 1, name: "t", path: [1, 2], health: "healthy" as const, hopLatencies: [], kind: "healthy" as const },
      { id: 2, name: "t", path: [1, 2], health: "healthy" as const, hopLatencies: [], kind: "healthy" as const },
      { id: 3, name: "loop", path: [1, 2, 1], health: "healthy" as const, hopLatencies: [], kind: "healthy" as const },
    ],
  } as any, []));
  assert.equal(sameName[0].tunnels, 3);
  assert.deepEqual(sameName[0].tunnelNames, ["t", "loop"]);
});

test("国界底图：几十 KB 的一条 path，坐标单位 0.1°，没有南极，北京、伦敦附近有边界点", () => {
  const d = worldCountriesPath();
  assert.equal(WORLD_COUNTRIES_UNIT, 10);
  assert.ok(d.length > 20_000 && d.length < 60_000, `${d.length}`);
  assert.ok(d.startsWith("M") && d.endsWith("z"));
  const starts = [...d.matchAll(/M(-?\d+) (-?\d+)/g)].map((m) => [Number(m[1]) / 10, Number(m[2]) / 10]);
  assert.ok(starts.length > 150, `${starts.length} 圈`);
  for (const [lon, lat] of starts) {
    assert.ok(lon >= -180 && lon <= 180 && lat > -60 && lat < 85, `${lon},${lat}`);
  }
  assert.strictEqual(worldCountriesPath(), d);
});
