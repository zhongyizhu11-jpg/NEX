import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/*
  强调色上的字（--fx-on-accent）：每个主题的浅色、深色两段都要自己定一个。
  漏了就继承面板默认那一档，和这个主题自己的强调色未必配得上（珍珠深色下强调色接近白，
  原来写死的白字就是这么看不见的）。
*/
const dir = import.meta.dirname;
// 内置的（这个目录下的 theme-*.css）和官方主题库里的（themes/official/<id>/theme.css）都要守这一条
const officialDir = path.resolve(dir, "../../../themes/official");
const themes: Array<{ name: string; file: string }> = [
  ...fs.readdirSync(dir).filter((name) => /^theme-.+\.css$/.test(name)).map((name) => ({ name: name.replace(/^theme-|\.css$/g, ""), file: path.join(dir, name) })),
  ...fs.readdirSync(officialDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, file: path.join(officialDir, entry.name, "theme.css") })),
];

function block(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  return css.slice(start, css.indexOf("\n}", start));
}

test("每个主题的浅色、深色两段都定了 --fx-on-accent", () => {
  assert.ok(themes.length >= 7, `只找到 ${themes.length} 个主题文件`);
  for (const { name, file } of themes) {
    const css = fs.readFileSync(file, "utf8");
    assert.match(block(css, `html[data-ui-theme="${name}"]`), /--fx-on-accent:\s*#[0-9a-f]{3,6};/i, `${name} 浅色段`);
    assert.match(block(css, `html.dark[data-ui-theme="${name}"]`), /--fx-on-accent:\s*#[0-9a-f]{3,6};/i, `${name} 深色段`);
  }
});

test("面板默认令牌两段都有，Tailwind 认 text-on-accent", () => {
  const tokens = fs.readFileSync(path.resolve(dir, "../../../shared/design-tokens.css"), "utf8");
  assert.equal((tokens.match(/--fx-on-accent:/g) || []).length, 2);
  const index = fs.readFileSync(path.resolve(dir, "../index.css"), "utf8");
  assert.match(index, /--color-on-accent:\s*var\(--fx-on-accent\)/);
});
