import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/** 套餐管理：两个 tab 的「新增」在页头同一个位置、按 tab 换文案；「配到哪一步了」平时折叠（2026-10-21 用户要的）。守在源码上。 */
test("套餐计费 → 新增套餐，流量计费 → 新增计费资源，都在页头", () => {
  const plans = fs.readFileSync(path.resolve(import.meta.dirname, "Plans.tsx"), "utf8");
  assert.match(plans, /activeTab === "billing" \? \(\s*<Button onClick=\{\(\) => setBillingCreateKey/);
  assert.match(plans, /<TrafficBillingSection createRequestKey=\{billingCreateKey\} \/>/);
  const section = fs.readFileSync(path.resolve(import.meta.dirname, "../components/TrafficBillingSection.tsx"), "utf8");
  assert.match(section, /ownCreateButton \? \(/, "页头给了 createRequestKey 时，计费那一块不再自己放「新增」");
});

test("「配到哪一步了」折叠成一行：标题 + 几步完成 + 箭头，点开才列四步", () => {
  const section = fs.readFileSync(path.resolve(import.meta.dirname, "../components/TrafficBillingSection.tsx"), "utf8");
  assert.match(section, /const \[stepsOpen, setStepsOpen\] = useState\(false\)/);
  assert.match(section, /aria-expanded=\{stepsOpen\}/);
  assert.match(section, /\$\{stepsDone\} \/ 4 步/);
  assert.match(section, /\{!stepsOpen \? null : isLoading \? \(/);
});
