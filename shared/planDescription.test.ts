import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_DESCRIPTION_MAX_LENGTH, PLAN_DESCRIPTION_TEMPLATE, planDescriptionSummary } from "./planDescription";

test("列表摘要去掉排版记号，只留文字", () => {
  assert.equal(planDescriptionSummary("### 适合谁\n\n- **游戏** 加速\n- [官网](https://x.test)"), "适合谁 游戏 加速 官网");
  assert.equal(planDescriptionSummary("<div><h3>介绍</h3><p>香港&nbsp;落地</p><script>alert(1)</script></div>"), "介绍 香港 落地");
  assert.equal(planDescriptionSummary("纯文本说明"), "纯文本说明");
  assert.equal(planDescriptionSummary(null), "");
  assert.equal(planDescriptionSummary("字".repeat(100), 10), "字".repeat(10) + "…");
});

test("模板在上限以内，上限放得进 MySQL TEXT", () => {
  assert.ok(PLAN_DESCRIPTION_TEMPLATE.length < PLAN_DESCRIPTION_MAX_LENGTH);
  assert.ok(PLAN_DESCRIPTION_MAX_LENGTH * 4 <= 65535);
});
