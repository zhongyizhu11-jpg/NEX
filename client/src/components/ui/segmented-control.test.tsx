import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { cn } from "@/lib/utils";
import { SegmentedControl, segmentedKeyTarget } from "./segmented-control";
import { segmentedControlClassName } from "./segmented";

const OPTIONS = [
  { value: "1h", label: "1 小时" },
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天", disabled: true },
] as const;

test("分段选择：读成单选组，Tab 只停在选中那一格", () => {
  const html = renderToStaticMarkup(<SegmentedControl ariaLabel="时间范围" value="24h" options={OPTIONS} onChange={() => {}} listClassName="grid grid-cols-3 gap-1" />);
  assert.match(html, /role="radiogroup" aria-label="时间范围"/);
  assert.equal((html.match(/role="radio"/g) || []).length, 3);
  assert.match(html, /role="radio" aria-checked="true" tabindex="0"[^>]*>24 小时</);
  assert.match(html, /role="radio" aria-checked="false" tabindex="-1"[^>]*>1 小时</);
  assert.match(html, /tabindex="-1" disabled=""[^>]*>7 天</);
  // 给了 listClassName 就在槽里再包一层，和原来的两层写法一样
  assert.match(html, /<div class="grid grid-cols-3 gap-1"><button/);
});

test("分段选择：没有选中时 Tab 停第一格能点的", () => {
  const html = renderToStaticMarkup(<SegmentedControl ariaLabel="x" value={null} options={[{ value: "a", label: "A", disabled: true }, { value: "b", label: "B" }]} onChange={() => {}} />);
  assert.match(html, /tabindex="0"[^>]*>B</);
});

test("分段选择：方向键循环、跳过禁用；Home / End 到头尾；别的键不管", () => {
  const disabled = (index: number) => index === 2;
  assert.equal(segmentedKeyTarget("ArrowRight", 0, 4, disabled), 1);
  assert.equal(segmentedKeyTarget("ArrowRight", 1, 4, disabled), 3, "跳过禁用的第 3 格");
  assert.equal(segmentedKeyTarget("ArrowDown", 3, 4, disabled), 0, "到尾了绕回第一格");
  assert.equal(segmentedKeyTarget("ArrowLeft", 0, 4, disabled), 3);
  assert.equal(segmentedKeyTarget("ArrowUp", 3, 4, disabled), 1);
  assert.equal(segmentedKeyTarget("Home", 3, 4, (index) => index === 0), 1);
  assert.equal(segmentedKeyTarget("End", 0, 4, (index) => index === 3), 2);
  assert.equal(segmentedKeyTarget("Enter", 0, 4, disabled), -1);
  assert.equal(segmentedKeyTarget("ArrowRight", 0, 0, disabled), -1);
});

test("分段选择：调用方给的槽样子能盖掉默认的底色和圆角", () => {
  const merged = cn(segmentedControlClassName, "rounded-[10px] bg-[color-mix(in_oklab,var(--fx-text)_7%,var(--fx-l1-surface))]");
  assert.doesNotMatch(merged, /rounded-md/);
  assert.doesNotMatch(merged, /bg-\[var\(--fx-l3-control-fill\)\]/);
});
