import assert from "node:assert/strict";
import test from "node:test";

import { exitManualWeights, exitStrategyNote } from "./exitGroupBalance";

const hosts = new Map<number, { id: number; name: string; lineBandwidthMbps?: number }>([
  [1, { id: 1, name: "东京", lineBandwidthMbps: 500 }],
  [2, { id: 2, name: "大阪", lineBandwidthMbps: 300 }],
  [3, { id: 3, name: "首尔" }],
]);

test("按权重：手填的全有就按填的分，没填按线路带宽，有一台不知道带宽时平均分", () => {
  assert.equal(exitStrategyNote("weighted", [{ hostId: 1, aggregationWeight: 5 }, { hostId: 2, aggregationWeight: 2 }], hosts), "现在按 5 : 2 分");
  assert.equal(exitStrategyNote("weighted", [{ hostId: 1 }, { hostId: 2 }], hosts), "按线路带宽 500M · 300M → 5 : 3 分");
  assert.equal(exitStrategyNote("weighted", [{ hostId: 1 }, { hostId: 3 }], hosts), "首尔 没填线路带宽，现在平均分");
  assert.equal(exitStrategyNote("weighted", [{ hostId: 1 }], hosts), "至少要两台出口");
  assert.match(exitStrategyNote("weighted", [{ hostId: 1, aggregationWeight: 5 }, { hostId: 2 }], hosts)!, /全部填了/);
});

test("自动 / 按负载：只在有出口没填带宽时补一句；别的方式不补", () => {
  assert.equal(exitStrategyNote("auto", [{ hostId: 1 }, { hostId: 2 }], hosts), null);
  assert.equal(exitStrategyNote("least_load", [{ hostId: 1 }, { hostId: 3 }], hosts), "首尔 没填线路带宽，按连接数算");
  assert.equal(exitStrategyNote("fallback", [{ hostId: 1 }, { hostId: 3 }], hosts), null);
  assert.equal(exitStrategyNote("auto", [{ hostId: 1 }, { hostId: 3, isEnabled: false }], hosts), null, "停用的不算");
});

test("实际效果那句话的份数：每台都填了才给", () => {
  assert.deepEqual(exitManualWeights([{ hostId: 1, aggregationWeight: 5 }, { hostId: 2, aggregationWeight: 3 }], hosts), { weights: [5, 3], memberNames: ["东京", "大阪"] });
  assert.deepEqual(exitManualWeights([{ hostId: 1, aggregationWeight: 5 }, { hostId: 2 }], hosts), {});
});
