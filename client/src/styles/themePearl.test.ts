import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 界面主题「珍珠」（theme-pearl.css）只许管自己：别的主题一条都不能被它改到。
 *
 * 每条选择器（包括 @media 里面的）要么挂在 html[data-ui-theme="pearl"] 下，要么是设置页那枚
 * 「珍珠」预览（.fx-uitheme-swatch[data-theme="pearl"]），要么是那枚只在珍珠下才渲染的侧栏标记
 * 的默认隐藏（.fx-pearl-nav-marker { display: none }）。
 */
const css = fs.readFileSync(path.resolve(import.meta.dirname, "theme-pearl.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 按顶层逗号切选择器列表：:is(a, b) 里的逗号不算 */
function splitList(list: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < list.length; k += 1) {
    if (list[k] === "(") depth += 1;
    else if (list[k] === ")") depth -= 1;
    else if (list[k] === "," && depth === 0) {
      parts.push(list.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((item) => item.trim()).filter(Boolean);
}

function selectors(source: string, out: string[] = []) {
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") depth -= 1;
      j += 1;
    }
    const head = source.slice(i, open).trim();
    const body = source.slice(open + 1, j - 1);
    if (head.startsWith("@media") || head.startsWith("@supports")) selectors(body, out);
    else if (head.startsWith("@")) out.push(head);
    else out.push(...splitList(head));
    i = j;
  }
  return out;
}

test("theme-pearl.css 的每条选择器都只在珍珠主题下生效", () => {
  const all = selectors(css);
  assert.ok(all.length > 50, "确实扫到了规则");
  const allowed = [
    /^html(\.dark)?\[data-ui-theme="pearl"\]/,
    /^(\.dark )?\.fx-uitheme-swatch\[data-theme="pearl"\]/,
    /^\.fx-pearl-nav-marker$/,
    /^@keyframes fx-pearl-/,
  ];
  const leaks = all.filter((selector) => !allowed.some((pattern) => pattern.test(selector)));
  assert.deepEqual(leaks, []);
});

test("不加载远程字体、不写层叠数字", () => {
  assert.doesNotMatch(css, /@font-face|@import|url\(\s*["']?https?:/);
  assert.doesNotMatch(css, /z-index/);
});

test("动效：有「减少动态效果」的兜底", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("MIT 声明保留在文件头", () => {
  const raw = fs.readFileSync(path.resolve(import.meta.dirname, "theme-pearl.css"), "utf8");
  assert.match(raw, /^\/\*! Pearl Glass adaptation of scaffold-master \(MIT\)/);
});
