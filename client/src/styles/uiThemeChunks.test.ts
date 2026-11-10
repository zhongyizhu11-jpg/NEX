import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PERSONALIZATION_UI_THEMES } from "../../../shared/personalization";
import { OFFICIAL_UI_THEME_IDS } from "../../../shared/uiThemePackage";

/**
 * 界面主题的样式按需加载（client/src/lib/uiThemeStyles.ts）守着的几条：
 *   · 内置的每套主题（经典除外）都有自己的样式包，包里是「主题 → compact.css」，compact 排最后（层叠先后和原来一样）；
 *   · 主样式表不再 @import 任何 theme-*.css，原来主题的位置换成 ui-theme-shared.css；
 *   · 主题文件里每条规则都只在自己那套下生效 —— 不然它就成了「没选这套就没有」的样式。哪套主题下都要画的
 *     （预览小屏、保存栏、品牌预览卡）只能写在 ui-theme-shared.css；只在这套下才渲染的元素（液态玻璃的
 *     照片底、珍珠的侧栏标记）记在下面的名单里；
 *   · 官方主题库里的那几套（themes/official/<id>/theme.css，原来也是内置的）同样守「只在自己那套下生效」，
 *     而且不再留在 client/src/styles 里 —— 留着就又被打进页面了。
 */
const dir = import.meta.dirname;
const themed = PERSONALIZATION_UI_THEMES.map((theme) => theme.id).filter((id) => id !== "classic");
const officialDir = path.resolve(dir, "../../../themes/official");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

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

const ONLY_RENDERED_UNDER: Record<string, RegExp[]> = {
  "liquid-glass": [/^(\.dark )?\.fx-lg-(backdrop|photo)/],
  pearl: [/^\.fx-pearl-nav-marker$/],
};

test("每套主题一个样式包：先主题、最后接 compact.css", () => {
  for (const id of themed) {
    const file = path.join(dir, "ui-themes", `ui-theme-${id}.css`);
    assert.ok(fs.existsSync(file), `缺 ui-themes/ui-theme-${id}.css`);
    const imports = [...strip(fs.readFileSync(file, "utf8")).matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(imports, [`../theme-${id}.css`, "../compact.css"], `ui-theme-${id}.css`);
  }
  const loader = fs.readFileSync(path.resolve(dir, "../lib/uiThemeStyles.ts"), "utf8");
  for (const id of themed) assert.match(loader, new RegExp(`import\\("\\.\\./styles/ui-themes/ui-theme-${id}\\.css"\\)`), id);
});

test("主样式表不带主题：原来主题那个位置是 ui-theme-shared.css，后面紧跟 compact.css", () => {
  const imports = [...strip(fs.readFileSync(path.resolve(dir, "../index.css"), "utf8")).matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(imports.filter((item) => /theme-[^/]+\.css$/.test(item) && !item.endsWith("ui-theme-shared.css")).length, 0, imports.join("\n"));
  const shared = imports.indexOf("./styles/ui-theme-shared.css");
  assert.ok(shared > imports.indexOf("./styles/workspace.css"));
  assert.equal(imports[shared + 1], "./styles/compact.css");
});

function leaks(id: string, file: string) {
  const css = strip(fs.readFileSync(file, "utf8"));
  const own = new RegExp(`^html(\\.[\\w-]+)*\\[data-ui-theme="${id}"\\]`);
  const allowed = [own, /^@keyframes /, /^@font-face$/, ...(ONLY_RENDERED_UNDER[id] || [])];
  return selectors(css).filter((selector) => !allowed.some((pattern) => pattern.test(selector)));
}

test("主题文件里每条规则都只在自己那套下生效", () => {
  for (const id of themed) assert.deepEqual(leaks(id, path.join(dir, `theme-${id}.css`)), [], `theme-${id}.css`);
});

test("官方主题库：每套一个目录，规则只在自己那套下生效，样式不再留在页面的源码里", () => {
  const directories = fs.readdirSync(officialDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(directories, [...OFFICIAL_UI_THEME_IDS].sort(), "themes/official 下的目录要和 OFFICIAL_UI_THEME_IDS 对得上");
  const loader = fs.readFileSync(path.resolve(dir, "../lib/uiThemeStyles.ts"), "utf8");
  for (const id of OFFICIAL_UI_THEME_IDS) {
    assert.deepEqual(leaks(id, path.join(officialDir, id, "theme.css")), [], `themes/official/${id}/theme.css`);
    assert.equal(fs.existsSync(path.join(dir, `theme-${id}.css`)), false, `client/src/styles/theme-${id}.css 不该还在`);
    assert.equal(fs.existsSync(path.join(dir, "ui-themes", `ui-theme-${id}.css`)), false, `ui-themes/ui-theme-${id}.css 不该还在`);
    assert.doesNotMatch(loader, new RegExp(`ui-theme-${id}\\.css`), `${id} 不该再有打包进页面的样式包`);
  }
});

test("哪套下都要画的在 ui-theme-shared.css：每套的预览小屏、保存栏、品牌预览卡", () => {
  const css = strip(fs.readFileSync(path.join(dir, "ui-theme-shared.css"), "utf8"));
  assert.match(css, /^\.fx-uitheme-swatch \{/m);
  // 内置的和官方主题库里的都有一份手画的预览（主题库里的还没装也要能看到样子）；别的主题包用通用的那份
  for (const id of [...themed, ...OFFICIAL_UI_THEME_IDS]) assert.match(css, new RegExp(`\\.fx-uitheme-swatch\\[data-theme="${id}"\\]`), id);
  const generic = css.indexOf(".fx-uitheme-swatch[data-theme-package]");
  assert.ok(generic > 0, "主题包的通用预览");
  for (const id of OFFICIAL_UI_THEME_IDS) {
    assert.ok(css.indexOf(`.fx-uitheme-swatch[data-theme="${id}"]`) > generic, `${id} 手画的预览要排在通用预览后面才盖得过它`);
  }
  assert.match(css, /^\.fx-save-dock \{/m);
  assert.match(css, /^\.fx-brand-preview \{/m);
  assert.doesNotMatch(css, /data-ui-theme/, "这里的规则不该挂在某一套主题下");
});
