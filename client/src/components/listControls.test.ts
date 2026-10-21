import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 列表页控制行（规则 / 主机 / 链路）：「新建」在页头（两种布局、两种视口都一样），手机上搜索行收成
 * 分类条右边一枚图标（SearchToggle）。2026-10-21 起紧凑外壳就是标准布局，这里不再按 compactLayout 分叉。
 * 守在源码上，免得哪一页又各写一套。
 */
const pages = ["Rules.tsx", "Hosts.tsx", "Tunnels.tsx"].map((file) => [file, fs.readFileSync(path.resolve(import.meta.dirname, "../pages", file), "utf8")] as const);

test("三页都不再按布局分叉「新建」放哪：没有 mergeListControls 这个开关", () => {
  for (const [file, source] of pages) {
    assert.doesNotMatch(source, /mergeListControls/, `${file} 不该再有 mergeListControls`);
    assert.match(source, /const collapsePhoneSearch = isMobile(Viewport)?;/, `${file} 手机上收搜索只看视口`);
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

test("四个主页面的根上带 data-fx-std-cards（标准下有、精简下没有），卡片按原来的标准画", () => {
  for (const file of ["Rules.tsx", "Hosts.tsx", "Tunnels.tsx", "Home.tsx"]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../pages", file), "utf8");
    assert.match(source, /data-fx-std-cards=\{compactLayout \? undefined : ""\}/, `${file} 的页面根要带 data-fx-std-cards`);
  }
});

test("SearchToggle 自己：图标按钮，有条件时带一个点；compact.css 在手机上把它和筛选图标压到 36px", () => {
  const toggle = fs.readFileSync(path.resolve(import.meta.dirname, "ListControls.tsx"), "utf8");
  assert.match(toggle, /aria-pressed=\{open\}/);
  assert.match(toggle, /fx-search-toggle-dot/);
  const compact = fs.readFileSync(path.resolve(import.meta.dirname, "../styles/compact.css"), "utf8");
  assert.match(compact, /\[data-fx-compact-hide-phone\]\s*\{\s*display:\s*none/);
  assert.match(compact, /\.fx-search-toggle \{ width: 36px; height: 36px; min-height: 36px; \}/);
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
