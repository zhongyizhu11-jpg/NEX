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
