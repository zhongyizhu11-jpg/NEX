import assert from "node:assert/strict";
import test from "node:test";

import { diagramRowOffsets } from "./RouteLineDiagram";
import { lineCardRank } from "./RouteBoardList";
import type { RouteStatus } from "./RouteGroupSheet";

/*
  线路详情的分层图（效果图 ①）：节点放在第几行。入口、落地在中间那一行（0）。
*/

const cols = (...columns: string[][]) => columns;

test("主线路、备用各经一台中转：中转列上下居中（效果图那种）", () => {
  const offsets = diagramRowOffsets(
    [{ hopKeys: ["h1"] }, { hopKeys: ["h2"] }],
    cols(["entry"], ["h1", "h2"], ["d"]),
  );
  assert.deepEqual(offsets, [[0], [-0.5, 0.5], [0]]);
});

test("主线路直连、备用经中转：中间那一行留给直连线，中转放下面（以前中转框压在在走的直线上）", () => {
  const offsets = diagramRowOffsets(
    [{ hopKeys: [] }, { hopKeys: ["h7"] }],
    cols(["entry"], ["h7"], ["d"]),
  );
  assert.deepEqual(offsets[1], [1]);
  const three = diagramRowOffsets(
    [{ hopKeys: [] }, { hopKeys: ["h7"] }, { hopKeys: ["h8"] }],
    cols(["entry"], ["h7", "h8"], ["d"]),
  );
  assert.deepEqual(three[1], [1, 2], "两条备用都在下面，谁也不在中间");
});

test("主线路经中转、备用直连：主线路的中转放上面", () => {
  const offsets = diagramRowOffsets(
    [{ hopKeys: ["h1"] }, { hopKeys: [] }, { hopKeys: ["h2"] }],
    cols(["entry"], ["h1", "h2"], ["d"]),
  );
  assert.deepEqual(offsets[1], [-1, 1]);
});

test("两列中转、有一条只经一跳：第二列也让开中间", () => {
  const offsets = diagramRowOffsets(
    [{ hopKeys: ["h1", "h2"] }, { hopKeys: ["h3"] }],
    cols(["entry"], ["h1", "h3"], ["h2"], ["d"]),
  );
  assert.deepEqual(offsets[1], [-0.5, 0.5], "第一列两条都经过，居中");
  assert.deepEqual(offsets[2], [-1], "第二列备用跳过了，主线路的放上面");
});

function status(groups: Array<{ tier: number; active?: boolean; down?: boolean }>): RouteStatus {
  return {
    paths: groups.map((group, index) => ({
      key: `p${index}`,
      index,
      tier: group.tier,
      lineKey: `l${group.tier}`,
      active: !!group.active,
      down: !!group.down,
      hops: [],
      dest: null,
    })),
  } as unknown as RouteStatus;
}

test("线路卡排序：全坏的最前，再是走着备用的，再是还没报的，正常走主线路的最后", () => {
  const allDown = status([{ tier: 0, down: true }, { tier: 1, down: true }]);
  const onBackup = status([{ tier: 0, down: true }, { tier: 1, active: true }]);
  const unreported = status([{ tier: 0 }, { tier: 1 }]);
  const onMain = status([{ tier: 0, active: true }, { tier: 1 }]);
  assert.deepEqual([onMain, unreported, allDown, onBackup].map(lineCardRank).sort(), [0, 1, 2, 3]);
  assert.equal(lineCardRank(allDown), 0);
  assert.equal(lineCardRank(onBackup), 1);
  assert.equal(lineCardRank(unreported), 2);
  assert.equal(lineCardRank(onMain), 3);
});

test("落地写名字：有名字写名字，没有写地址，地址也没有才写「落地」", async () => {
  const { routeLandingName } = await import("./routeLineText");
  const path = (patch: Record<string, unknown>) => ({ dest: { ip: "", port: 0 }, destName: null, ...patch }) as unknown as Parameters<typeof routeLandingName>[0];
  assert.equal(routeLandingName(path({ destName: "HK 落地机", dest: { ip: "203.0.113.9", port: 443 } })), "HK 落地机");
  assert.equal(routeLandingName(path({ dest: { ip: "hkboil.ddos.top", port: 24895 } })), "hkboil.ddos.top");
  assert.equal(routeLandingName(path({})), "落地");
  assert.equal(routeLandingName(null), "落地");
});

/*
  线路行上状态胶囊前面的小提示（Agent 2.2.251 起）：TCP 通、UDP 不通的标「UDP 不通」，沿途负载 70% 起标「负载 N%」；
  暂停着、整条不通的不标（状态胶囊已经说了），老 Agent 没报（null）也不标。
*/
test("线路行的提示：UDP 不通、负载 85% 才标，暂停 / 不通 / 没报的不标", async () => {
  const { routeLineHints } = await import("./RouteLineOverview");
  const path = (overrides: Record<string, unknown> = {}) => ({
    key: "p", index: 0, healthy: true, udpHealthy: null, udpLatencyMs: null, loadPct: null, down: false, downReason: "", paused: false, ...overrides,
  }) as unknown as RouteStatus["paths"][number];
  const group = (shown: RouteStatus["paths"][number], overrides: Record<string, unknown> = {}) => ({
    key: "main", index: 0, name: "主线路", paths: [shown], shown, active: true, paused: false, allDown: false, reason: "", failures: 0, ...overrides,
  }) as Parameters<typeof routeLineHints>[0];

  assert.deepEqual(routeLineHints(group(path())), [], "老 Agent 没报 UDP / 负载：什么都不标");
  assert.deepEqual(routeLineHints(group(path({ udpHealthy: false }))).map((hint) => [hint.text, hint.tone]), [["UDP 不通", "warn"]]);
  assert.deepEqual(routeLineHints(group(path({ healthy: false, udpHealthy: true }))).map((hint) => hint.text), ["仅 UDP 通"]);
  assert.deepEqual(routeLineHints(group(path({ loadPct: 85 }))).map((hint) => [hint.text, hint.tone]), [["负载 85%", "warn"]]);
  assert.deepEqual(routeLineHints(group(path({ loadPct: 97 }))).map((hint) => hint.tone), ["down"], "95% 起染红");
  assert.deepEqual(routeLineHints(group(path({ loadPct: 60 }))), [], "70% 以下评分不扣，不标");
  assert.deepEqual(routeLineHints(group(path({ udpHealthy: false, loadPct: 85 }))).map((hint) => hint.text), ["UDP 不通", "负载 85%"]);
  assert.deepEqual(routeLineHints(group(path({ udpHealthy: false, loadPct: 85 }), { paused: true })), [], "暂停着不标");
  assert.deepEqual(routeLineHints(group(path({ udpHealthy: false, loadPct: 85, down: true }), { allDown: true })), [], "整条不通不标");
});
