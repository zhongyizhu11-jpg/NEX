import assert from "node:assert/strict";
import test from "node:test";
import { latencyLevel, latencyTagTone } from "./latencyLevel";
import { getLatencyRating } from "../components/LatencyRating";

test("延迟刻度只有一套：规则卡标签、链路卡、评级文字同一个数同一个颜色", () => {
  assert.deepEqual([30, 120, 220, 400].map((ms) => latencyLevel(ms)?.tone), ["healthy", "ok", "warn", "down"]);
  assert.deepEqual([30, 120, 220, 400].map(latencyTagTone), ["ok", "ok", "warn", "down"]);
  // 120 ms：以前规则卡绿、评级文字琥珀
  assert.equal(getLatencyRating(120).className, getLatencyRating(30).className);
  assert.equal(getLatencyRating(120).label, "良好");
  assert.equal(latencyLevel(null), null);
});
