import assert from "node:assert/strict";
import test from "node:test";

import { fitNodeText } from "./TopologyCanvas";

/*
  节点上的字按格子宽度截：中文一个字一个字宽，英文数字 0.6 个；放得下就原样，放不下截短加「…」。
*/

test("放得下就原样，放不下截短加省略号，截完不超过格子宽", () => {
  assert.equal(fitNodeText("HK entry", 142, 12.5), "HK entry");
  const latin = fitNodeText("very-long-hostname-for-a-relay-box", 142, 12.5);
  assert.ok(latin.endsWith("…"));
  // 142 宽、每个英文 7.5、省略号 7.5：最多 17 个字再加省略号。
  assert.equal(latin, "very-long-hostnam…");
  // 106 宽、每个中文 12.5、省略号 7.5：7 个字再加省略号（8 个字就 100 + 7.5，超了）。
  const chinese = fitNodeText("香港入口一号机房备用线路", 106, 12.5);
  assert.equal(chinese, "香港入口一号机…");
});

test("表情这种两个单元的字不会被从中间切开；再窄也至少留一个字", () => {
  const withEmoji = fitNodeText("🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀", 40, 12.5);
  assert.ok(withEmoji.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(withEmoji), "不能留下半个表情");
  assert.equal(Array.from(withEmoji.slice(0, -1)).every((char) => char === "🚀"), true);
  assert.equal(fitNodeText("香港入口", 1, 12.5), "香…");
});
