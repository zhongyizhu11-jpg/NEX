import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * compact.css（精简布局）的几条底线。
 *
 * 一、每条规则都挂在 html[data-layout="compact"] 底下：标准布局不带属性，这个文件一条都不能生效，
 *    关掉精简就是原样。
 * 二、不按类名片段猜 DOM（和 workspaceCss.test.ts 一条规矩）。
 * 三、说明文字靠 data-fx-help 收，data-fx-keep 能留住 —— 状态、数值、报错不打标记，所以不会被收掉。
 */
const css = fs.readFileSync(path.resolve(import.meta.dirname, "compact.css"), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

function selectors(source: string) {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    // @media 块只跳过它自己的开头，里面的规则照查；块尾那个 } 会粘在下一条选择器前面，剥掉
    const selector = source.slice(i, open).replace(/^[\s}]+/, "").trim();
    if (selector.startsWith("@")) { i = open + 1; continue; }
    const close = source.indexOf("}", open);
    out.push(selector);
    i = close + 1;
  }
  return out;
}

test("每条规则都只在 html[data-layout=\"compact\"] 下生效", () => {
  const list = selectors(code);
  assert.ok(list.length > 30, "规则够多，不是空文件");
  for (const selector of list) {
    for (const part of selector.split(",")) {
      assert.match(part.trim(), /^html\[data-layout="compact"\]/, `「${part.trim()}」没有挂在精简布局底下`);
    }
  }
});

test("不按类名片段猜 DOM", () => {
  assert.deepEqual(code.match(/\[class[*^$]=[^\]]*\]/g) ?? [], []);
});

test("说明文字按 data-fx-help 收、data-fx-keep 留住；整块不要的按 data-fx-compact-hide", () => {
  assert.match(code, /\[data-fx-help\]:not\(\[data-fx-keep\]\)\s*\{\s*display:\s*none/);
  assert.match(code, /\[data-fx-compact-hide\]\s*\{\s*display:\s*none/);
});

test("精简只改尺寸，不改颜色：没有 color / background 的赋值", () => {
  assert.doesNotMatch(code, /(^|[;{\s])(color|background|background-color|border-color)\s*:/m);
});

test("触屏上控件不压到 32px：按钮、输入框的高度只在 pointer: fine 里写", () => {
  const coarseSafe = code.replace(/@media \(pointer: fine\)\s*\{[\s\S]*?\n\}/g, "");
  assert.doesNotMatch(coarseSafe, /\[data-slot="button"\][^{]*\{[^}]*height:\s*32px/);
  assert.doesNotMatch(coarseSafe, /\[data-slot="input"\][^{]*\{[^}]*height:\s*32px/);
});
