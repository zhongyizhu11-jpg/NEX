import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/*
  经典主题的主色控件（「添加主机」「新建规则」这类主按钮、选中的分段项 / chip、手机底栏选中项）
  是白字压在 --fx-primary-gradient / --fx-primary-fill 上。2.3.375～2.3.525 那道浅天蓝渐变
  （#8ccfff → #56aaf2）配白字只有 1.7～2.5:1，亮屏上字发虚（2026-11 走查）。
  这里守着：浅色、深色两段里，渐变的每一个色标、底色、悬停色，和白字的对比都 ≥ 4.5:1（WCAG AA 正文）。
*/
const dir = import.meta.dirname;
const tokens = fs.readFileSync(path.resolve(dir, "../../../shared/design-tokens.css"), "utf8");

function block(css: string, selector: string) {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `找不到 ${selector}`);
  return css.slice(start, css.indexOf("\n}", start));
}

function declaration(css: string, name: string) {
  const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `缺 ${name}`);
  return match[1].trim();
}

function hexes(value: string) {
  return [...value.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase());
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const [mode, selector] of [["浅色", ":root"], ["深色", ".dark"]] as const) {
  test(`经典${mode}：主色控件上的字和每一个底色都 ≥ 4.5:1`, () => {
    const css = block(tokens, selector);
    const text = declaration(css, "--fx-primary-text");
    assert.match(text, /^#[0-9a-f]{6}$/i);
    const backgrounds = [
      ...hexes(declaration(css, "--fx-primary-gradient")),
      ...hexes(declaration(css, "--fx-primary-gradient-hover")),
      declaration(css, "--fx-primary-fill"),
      declaration(css, "--fx-primary-fill-hover"),
    ];
    assert.ok(backgrounds.length >= 6, `${mode}：底色没取全 ${backgrounds.join(", ")}`);
    for (const background of backgrounds) {
      assert.match(background, /^#[0-9a-f]{6}$/i, `${mode}：${background} 不是 #rrggbb，没法算对比`);
      const ratio = contrast(text, background);
      assert.ok(ratio >= 4.5, `${mode}：${text} 压在 ${background} 上只有 ${ratio.toFixed(2)}:1`);
    }
  });
}

test("经典侧栏选中项是淡底 + 主色字，不再是实色胶囊配白字", () => {
  const css = fs.readFileSync(path.resolve(dir, "workspace.css"), "utf8");
  assert.match(css, /html:not\(\[data-ui-theme\]\) \.workspace-layout \[data-sidebar="menu-button"\]\[data-active="true"\] \{ background: color-mix\(in srgb, var\(--fx-primary-fill\) 11%, transparent\); color: var\(--fx-primary-fill\); \}/);
  assert.match(css, /html\.dark:not\(\[data-ui-theme\]\) \.workspace-layout \[data-sidebar="menu-button"\]\[data-active="true"\] \{ background: var\(--fx-accent-soft\); color: var\(--fx-accent\); \}/);
  // 浅色：主色字压在「主色兑 11% 叠白」的淡底上
  const fill = declaration(block(tokens, ":root"), "--fx-primary-fill");
  const tint = "#" + [1, 3, 5].map((i) => Math.round(parseInt(fill.slice(i, i + 2), 16) * 0.11 + 255 * 0.89).toString(16).padStart(2, "0")).join("");
  assert.ok(contrast(fill, tint) >= 4.5, `侧栏选中项 ${fill} 压在 ${tint} 上只有 ${contrast(fill, tint).toFixed(2)}:1`);
});

/*
  液态玻璃（theme-liquid-glass.css）和深空浅色那套绿（themes/official/deepspace）：主色控件同样是白字。
  2026-11 手机走查量出来：液态玻璃浅色起点 #3b82f6 只有 3.7:1，深色那道 #60a5fa → #3b82f6 只有 2.5～3.7:1，
  深空浅色 #00a676 只有 3.1:1。这里守着它们和经典一样 ≥ 4.5:1。
  主题的块里没写 --fx-primary-text 就是继承下来的白字。
*/
const themeBlocks = [
  ["液态玻璃浅色", "theme-liquid-glass.css", 'html[data-ui-theme="liquid-glass"]'],
  ["液态玻璃深色", "theme-liquid-glass.css", 'html.dark[data-ui-theme="liquid-glass"]'],
  ["深空浅色", "../../../themes/official/deepspace/theme.css", 'html[data-ui-theme="deepspace"]:not(.dark)'],
] as const;

for (const [name, file, selector] of themeBlocks) {
  test(`${name}：主色控件上的字和每一个底色都 ≥ 4.5:1`, () => {
    const css = block(fs.readFileSync(path.resolve(dir, file), "utf8"), selector);
    const text = css.match(/--fx-primary-text:\s*(#[0-9a-f]{6})\b/i)?.[1] ?? "#ffffff";
    const backgrounds = ["--fx-primary-gradient", "--fx-primary-gradient-hover", "--fx-primary-fill", "--fx-primary-fill-hover"]
      .flatMap((token) => hexes(declaration(css, token)));
    assert.ok(backgrounds.length >= 6, `${name}：底色没取全 ${backgrounds.join(", ")}`);
    for (const background of backgrounds) {
      const ratio = contrast(text, background);
      assert.ok(ratio >= 4.5, `${name}：${text} 压在 ${background} 上只有 ${ratio.toFixed(2)}:1`);
    }
  });
}
