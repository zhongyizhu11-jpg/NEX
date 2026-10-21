import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * compact.css（紧凑外壳，2026-10-21 起就是标准布局）的几条底线。
 *
 * 一、每条规则都挂在 html:root（两种布局都生效）或 html[data-layout="compact"]（只在精简下）底下，
 *    不写裸选择器 —— 特指度和 workspace.css、各主题的关系靠这个前缀定住。
 *    四个主页面整页（data-fx-std-page）要让出去：令牌先接住再还回去，其余每条规则都带 :not。
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

test("每条规则都挂在 html:root 或 html[data-layout=\"compact\"] 下", () => {
  const list = selectors(code);
  assert.ok(list.length > 30, "规则够多，不是空文件");
  for (const selector of list) {
    for (const part of selector.split(",")) {
      assert.match(part.trim(), /^html(:root|\[data-layout="compact"\])/, `「${part.trim()}」没有带前缀`);
    }
  }
});

test("四个主页面整页让出去：令牌从 html 接住、在 body 上覆盖、在 data-fx-std-page 里还回去；其余每条规则都带 :not", () => {
  assert.match(code, /html:root \{[^}]*--fx-std-size-primary: var\(--fx-size-primary\)/);
  assert.match(code, /html:root body \{[^}]*--fx-size-primary: 15px/);
  assert.match(code, /html:root \[data-fx-std-page\] \{[^}]*--fx-size-primary: var\(--fx-std-size-primary\)[^}]*--radius: var\(--fx-std-radius\)/);
  const tokenBlocks = new Set(["html:root", "html:root body", "html:root [data-fx-std-page]"]);
  for (const selector of selectors(code)) {
    if (tokenBlocks.has(selector)) continue;
    for (const part of selector.split(",")) {
      assert.ok(part.trim().endsWith(":not([data-fx-std-page] *)"), `「${part.trim()}」没有让出四个主页面`);
    }
  }
});

test("不按类名片段猜 DOM", () => {
  assert.deepEqual(code.match(/\[class[*^$]=[^\]]*\]/g) ?? [], []);
});

test("说明文字按 data-fx-help 收、data-fx-keep 留住；整块不要的按 data-fx-compact-hide", () => {
  assert.match(code, /\[data-fx-help\]:not\(\[data-fx-keep\]\)(:not\(\[data-fx-std-page\] \*\))?\s*\{\s*display:\s*none/);
  assert.match(code, /\[data-fx-compact-hide\](:not\(\[data-fx-std-page\] \*\))?\s*\{\s*display:\s*none/);
});

test("精简只改尺寸，不改颜色：没有 color / background 的赋值（拿掉一个框的 background: none 不算）", () => {
  const withoutClearing = code.replace(/background:\s*(none|transparent)\s*;/g, "");
  assert.doesNotMatch(withoutClearing, /(^|[;{\s])(color|background|background-color|border-color)\s*:/m);
});

test("触屏上控件不压到 32px：按钮、输入框的高度只在 pointer: fine 里写", () => {
  const coarseSafe = code.replace(/@media \(pointer: fine\)\s*\{[\s\S]*?\n\}/g, "");
  assert.doesNotMatch(coarseSafe, /\[data-slot="button"\][^{]*\{[^}]*height:\s*32px/);
  assert.doesNotMatch(coarseSafe, /\[data-slot="input"\][^{]*\{[^}]*height:\s*32px/);
});
