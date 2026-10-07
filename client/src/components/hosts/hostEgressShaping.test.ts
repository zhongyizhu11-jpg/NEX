import assert from "node:assert/strict";
import test from "node:test";
import {
  describeHostEgressShaping,
  hostEgressShapingCardText,
  normalizeHostEgressMbpsInput,
  normalizeHostEgressShapingMode,
} from "./hostEgressShaping";

test("主机公网出口整形：档位、上限输入收敛", () => {
  assert.equal(normalizeHostEgressShapingMode("auto"), "auto");
  assert.equal(normalizeHostEgressShapingMode("MANUAL"), "manual");
  assert.equal(normalizeHostEgressShapingMode(undefined), "off");
  assert.equal(normalizeHostEgressShapingMode("sometimes"), "off");
  assert.equal(normalizeHostEgressMbpsInput("500"), 500);
  assert.equal(normalizeHostEgressMbpsInput("-3"), 0);
  assert.equal(normalizeHostEgressMbpsInput("abc"), 0);
  assert.equal(normalizeHostEgressMbpsInput(5_000_000), 1_000_000);
});

test("主机公网出口整形：编辑框状态与卡片文字", () => {
  assert.equal(describeHostEgressShaping(null), "暂无上报");
  assert.equal(describeHostEgressShaping({ state: "watching" }), "还没遇到限速，没整形");
  assert.equal(describeHostEgressShaping({ state: "shaping", rateMbps: 470, learnedMbps: 488 }), "整形中，学到的上限 488 Mbit/s");
  assert.equal(describeHostEgressShaping({ state: "shaping", rateMbps: 420, learnedMbps: 0 }), "正在找限速点（420 Mbit/s）");
  assert.equal(describeHostEgressShaping({ state: "paused" }), "暂停（丢包不像限速器）");
  assert.equal(hostEgressShapingCardText({ egressShapingStatus: null }), "");
  assert.equal(hostEgressShapingCardText({ egressShapingStatus: { state: "watching" } }), "");
  assert.equal(hostEgressShapingCardText({ egressShapingStatus: { state: "shaping", learnedMbps: 488, rateMbps: 478 } }), "公网出口整形：488 Mbit/s");
  assert.equal(hostEgressShapingCardText({ egressShapingStatus: { state: "shaping", learnedMbps: 0, rateMbps: 420 } }), "公网出口整形：正在找限速点（420 Mbit/s）");
  assert.equal(hostEgressShapingCardText({ egressShapingStatus: { state: "paused" } }), "公网出口整形：暂停（不像限速器）");
  assert.equal(hostEgressShapingCardText(null), "");
});
