import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOverviewEdges,
  bundleOverviewEdges,
  clusterOverview,
  clusterOverviewBundles,
  labelTextWidth,
  layoutOverview,
  overviewViewport,
  placeOverviewLabels,
  projectOverview,
  truncateLabel,
  OVERVIEW_PAD_X,
} from "./networkOverview";
import { WORLD_GEO_UNIT, worldBordersPath, worldLandPath } from "./worldGeo";

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

test("取景：主机挤在一小片时至少取 28° × 14°，横竖比例尺一样大（地图不变形）；一台都没定位时没有底图", () => {
  const viewport = overviewViewport([node(1, [22.3, 114.2]), node(2, [22.4, 114.3])], 390, 240)!;
  const innerW = 390 - OVERVIEW_PAD_X * 2;
  assert.ok(innerW / viewport.sx >= 28 - 0.01 && innerW / viewport.sx < 40, `经度范围 ${innerW / viewport.sx}`);
  assert.ok(Math.abs(viewport.sy - viewport.sx) < 1e-9, `${viewport.sx} / ${viewport.sy}`);
  assert.equal(overviewViewport([node(1)], 390, 240), null);
});

test("落位：点就在真实经纬度上，不为了避让挪动；挨得比 18px 近的合成一个点（位置取重心），没定位的合成底下一个点", () => {
  const nodes = [
    { ...node(1, [23.13, 113.26]), city: "广州" },
    { ...node(2, [23.13, 113.26]), city: "广州" },
    { ...node(3, [22.32, 114.17]), city: "香港", health: "down" as const },
    { ...node(4, [-33.87, 151.21]), city: "悉尼" },
    node(5),
  ];
  const projected = projectOverview(nodes, 390, 240);
  const viewport = overviewViewport(nodes, 390, 240)!;
  assert.ok(Math.abs(projected[3].x - viewport.x(151.21)) < 1e-6 && Math.abs(projected[3].y - viewport.y(-33.87)) < 1e-6, "悉尼就在悉尼");
  const clusters = layoutOverview(nodes, 390, 240);
  const south = clusters.find((cluster) => cluster.members.some((member) => member.id === 1))!;
  assert.deepEqual(south.members.map((member) => member.id), [1, 2, 3], "广州两台和香港挨得太近，合成一个点");
  assert.equal(south.id, 1);
  assert.equal(south.city, "广州 · 香港", "台数多的城市在前");
  assert.equal(south.name, "3 台");
  assert.equal(south.health, "down", "点的状态取最差的那台");
  const cx = (projected[0].x * 2 + projected[2].x) / 3;
  assert.ok(Math.abs(south.x - cx) < 1e-6, "合出来的点在重心");
  const sydney = clusters.find((cluster) => cluster.id === 4)!;
  assert.deepEqual(sydney.members.map((member) => member.id), [4]);
  assert.equal(sydney.city, "悉尼");
  const unlocated = clusters.find((cluster) => cluster.unlocated)!;
  assert.deepEqual(unlocated.members.map((member) => member.id), [5]);
  assert.ok(clusters.filter((cluster) => !cluster.unlocated).every((cluster) => cluster.y < unlocated.y), "没定位的在最下面");
});

test("合点：有问题的主机不被正常的点吞掉，除非几乎压在一起", () => {
  const at = (id: number, x: number, health: "healthy" | "down") => ({ id, name: `h${id}`, city: `c${id}`, health, x, y: 100, unlocated: false });
  const apart = clusterOverview([at(1, 100, "healthy"), at(2, 100, "healthy"), at(3, 114, "down")]);
  assert.equal(apart.length, 2, "差 14px：断了的那台自己一个点");
  assert.equal(apart.find((cluster) => cluster.id === 3)!.health, "down");
  const healthy = clusterOverview([at(1, 100, "healthy"), at(2, 100, "healthy"), at(3, 114, "healthy")]);
  assert.equal(healthy.length, 1, "同样的距离，都正常就合");
  const stacked = clusterOverview([at(1, 100, "healthy"), at(3, 106, "down")]);
  assert.equal(stacked.length, 1, "差 6px：压在一起了，还是合");
  assert.equal(stacked[0].health, "down");
});

test("合线：两头落在同一个点里的线不画，最差的状态记到那个点上；跨点的线照常合", () => {
  const edges = [
    { key: "a", kind: "tunnel" as const, tunnelId: 1, from: 1, to: 2, tone: "down" as const, label: "t", count: 1 },
    { key: "b", kind: "tunnel" as const, tunnelId: 2, from: 2, to: 4, tone: "ok" as const, label: "u", count: 1 },
    { key: "c", kind: "forward" as const, from: 3, to: 4, tone: "ok" as const, label: "1 条转发", count: 1 },
  ];
  const clusters = [
    { id: 1, members: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    { id: 4, members: [{ id: 4 }] },
  ] as any;
  const { bundles, inner } = clusterOverviewBundles(edges, clusters);
  assert.equal(inner.get(1), "down");
  assert.deepEqual(bundles.map((bundle) => `${bundle.key}:${bundle.tone}:${bundle.tunnels}t/${bundle.forwards}f`), ["1-4:ok:1t/1f"]);
});

test("标签：一行「旗 城市」，合起来的点写「广州 · 香港」；有问题的先挑位置；挑不压别人的位置，都在画布里", () => {
  const nodes = [
    { ...node(1, [23.13, 113.26]), city: "广州" },
    { ...node(2, [23.13, 113.26]), city: "广州" },
    { ...node(3, [25.03, 121.56]), city: "台北", health: "down" as const },
    { ...node(4, [-33.87, 151.21]), city: "悉尼" },
    node(5),
  ];
  const clusters = layoutOverview(nodes, 390, 240);
  const labels = placeOverviewLabels(clusters.map((cluster) => ({
    ...cluster,
    flag: cluster.id === 4 ? "🇦🇺" : null,
    priority: cluster.health === "down" ? 3 : 0,
    radius: cluster.members.length > 1 ? 9.5 : 5.5,
    count: cluster.members.length,
  })), 390, 240);
  const byText = labels.map((label) => label.line1);
  assert.ok(byText.includes("广州"), byText.join("|"));
  assert.ok(byText.includes("台北"));
  assert.ok(byText.includes("🇦🇺 悉尼"));
  assert.ok(byText.includes("未定位"));
  assert.ok(labels.every((label) => label.line2 === null && label.height === 24), "都是一行");
  const boxes = labels.map((label, index) => ({ x: clusters[index].x + label.dx, y: clusters[index].y + label.dy, w: label.width, h: label.height }));
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.x + box.w <= 390 && box.y >= 0 && box.y + box.h <= 240, `出画布 ${JSON.stringify(box)}`);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      const overlap = Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
      assert.ok(!overlap, `标签 ${byText[i]} 和 ${byText[j]} 叠在一起`);
    }
  }
  assert.ok(labelTextWidth("香港", 12) > labelTextWidth("HK", 12), "汉字比字母宽");
});

test("标签：太长的城市名截掉加 …，胶囊不会比画布宽", () => {
  const longName = "hk-entry-node-with-a-really-long-name-01";
  const placed = layoutOverview([{ ...node(1, [22.3, 114.2]), name: longName }], 390, 240);
  const [label] = placeOverviewLabels(placed.map((item) => ({ ...item, city: "一个特别特别特别长的城市名字", flag: null })), 390, 240);
  assert.equal(label.line1, "一个特别特别特别长的城…");
  const [byName] = placeOverviewLabels(placed.map((item) => ({ ...item, city: "", flag: null })), 390, 240);
  assert.equal(byName.line1, "hk-entry-no…", "没有城市时写主机名，同样截短");
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

test("底图：50m 陆地和国界两条 path，坐标单位 0.05°，没有南极；香港、伦敦附近都有海岸线的点", () => {
  const land = worldLandPath();
  const borders = worldBordersPath();
  assert.equal(WORLD_GEO_UNIT, 20);
  assert.ok(land.length > 50_000 && land.length < 120_000, `${land.length}`);
  assert.ok(borders.length > 10_000 && borders.length < 40_000, `${borders.length}`);
  assert.ok(land.startsWith("M") && land.endsWith("z"));
  assert.ok(borders.startsWith("M") && !borders.endsWith("z"), "国界是线，不闭合");
  // 每圈的起点（绝对坐标）都在合理范围里
  const starts = [...land.matchAll(/M(-?\d+) (-?\d+)/g)].map((m) => [Number(m[1]) / 20, Number(m[2]) / 20]);
  assert.ok(starts.length > 500, `${starts.length} 圈`);
  for (const [lon, lat] of starts) assert.ok(lon >= -180 && lon <= 180 && lat > -60 && lat < 85, `${lon},${lat}`);
  // 把陆地所有点还原出来，看香港、伦敦附近有没有海岸线
  const points: Array<[number, number]> = [];
  for (const ring of land.split("z")) {
    const m = ring.match(/^M(-?\d+) (-?\d+)l(.*)$/);
    if (!m) continue;
    let x = Number(m[1]), y = Number(m[2]);
    points.push([x / 20, y / 20]);
    const nums = (m[3].match(/-?\d+/g) || []).map(Number);
    for (let k = 0; k + 1 < nums.length; k += 2) { x += nums[k]; y += nums[k + 1]; points.push([x / 20, y / 20]); }
  }
  const near = (lon: number, lat: number, r: number) => points.some(([x, y]) => Math.abs(x - lon) < r && Math.abs(y - lat) < r);
  assert.ok(near(114.17, 22.3, 0.3), "香港附近有海岸线");
  assert.ok(near(-0.1, 51.5, 1.5), "伦敦附近（泰晤士河口）有海岸线");
  assert.ok(!near(-150, -20, 2), "南太平洋中间没有");
});
