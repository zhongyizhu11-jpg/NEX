import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 列表页控制行（规则 / 主机 / 链路）：精简下「新建」在页头、手机上搜索行收成分类条右边一枚图标
 * （SearchToggle）；标准下这三页整页按原来的样子（data-fx-std-page）。守在源码上，免得哪一页又各写一套。
 */
const pages = ["Rules.tsx", "Hosts.tsx", "Tunnels.tsx"].map((file) => [file, fs.readFileSync(path.resolve(import.meta.dirname, "../pages", file), "utf8")] as const);

test("三页都按 compactLayout 决定「新建」放哪、手机上收不收搜索", () => {
  for (const [file, source] of pages) {
    assert.match(source, /const mergeListControls = compactLayout;/, file);
    assert.match(source, /const collapsePhoneSearch = compactLayout && isMobile(Viewport)?;/, file);
  }
});

test("规则 / 主机页头的「···」：手机 + 标准挪到状态点那一行右边（chipsAside，不描边），其余时候在标题行", () => {
  for (const [file, source] of pages.filter(([file]) => file !== "Tunnels.tsx")) {
    assert.match(source, /const overflowInHeader = mergeListControls \|\| !isMobile(Viewport)?;/, file);
    assert.match(source, /chipsAside=\{[^}]*OverflowMenu\("ghost"\)/, file);
    assert.match(source, /OverflowMenu\("outline"\)/, file);
  }
});

test("三页的分类条都包在 fx-tabs-row 里，手机上带 SearchToggle，搜索行按 phoneSearchOpen 显示", () => {
  for (const [file, source] of pages) {
    assert.match(source, /className="fx-tabs-row"/, file);
    assert.match(source, /import \{ SearchToggle \} from "@\/components\/ListControls"/, file);
    assert.match(source, /collapsePhoneSearch \? \(\s*<SearchToggle/, file);
    assert.match(source, /const \[phoneSearchOpen, setPhoneSearchOpen\] = useState\(false\)/, file);
  }
});

test("四个主页面的根上带 data-fx-std-page（标准下有、精简下没有），整页按原来的标准画", () => {
  for (const file of ["Rules.tsx", "Hosts.tsx", "Tunnels.tsx", "Home.tsx"]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../pages", file), "utf8");
    assert.match(source, /data-fx-std-page=\{compactLayout \? undefined : ""\}/, `${file} 的页面根要带 data-fx-std-page`);
  }
});

test("SearchToggle 自己：图标按钮，有条件时带一个点；compact.css 在手机上把它和筛选图标压到 36px", () => {
  const toggle = fs.readFileSync(path.resolve(import.meta.dirname, "ListControls.tsx"), "utf8");
  assert.match(toggle, /aria-pressed=\{open\}/);
  assert.match(toggle, /fx-search-toggle-dot/);
  const compact = fs.readFileSync(path.resolve(import.meta.dirname, "../styles/compact.css"), "utf8");
  assert.match(compact, /\[data-fx-compact-hide-phone\](:not\(\[data-fx-std-page\] \*\))?\s*\{\s*display:\s*none/);
  assert.match(compact, /\.fx-search-toggle(:not\(\[data-fx-std-page\] \*\))? \{ width: 36px; height: 36px; min-height: 36px; \}/);
});

test("手机「更多」页：系统设置的分区直接列出来（和设置页同一份定义），没有「偏好」那一组", () => {
  const more = fs.readFileSync(path.resolve(import.meta.dirname, "../pages/More.tsx"), "utf8");
  assert.match(more, /import \{ settingsGroups, settingsTabItems \} from "\.\/settingsSections"/);
  assert.match(more, /path: `\/settings\?tab=\$\{value\}`/);
  assert.doesNotMatch(more, /header="偏好"/);
  assert.doesNotMatch(more, /label="深色外观"/);
  const settings = fs.readFileSync(path.resolve(import.meta.dirname, "../pages/Settings.tsx"), "utf8");
  assert.match(settings, /from "\.\/settingsSections"/);
  assert.match(settings, /new URLSearchParams\(window\.location\.search\)\.has\("tab"\)/, "带 ?tab= 进来直接进分区");
});
