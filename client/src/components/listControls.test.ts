import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 精简布局 · 列表页控制行（2026-10-21 这一轮）：
 * 规则 / 主机 / 链路三页「新建」在精简下上到页头（桌面手机都一样），手机上搜索行收成分类条右边
 * 一枚图标（SearchToggle）。守在源码上，免得哪一页又各写一套。
 */
const pages = ["Rules.tsx", "Hosts.tsx", "Tunnels.tsx"].map((file) => [file, fs.readFileSync(path.resolve(import.meta.dirname, "../pages", file), "utf8")] as const);

test("三页都按 compactLayout（不分手机桌面）把「新建」挪到页头", () => {
  for (const [file, source] of pages) {
    assert.match(source, /const mergeListControls = compactLayout;/, `${file} 的 mergeListControls 不该再带 !isMobile`);
    assert.doesNotMatch(source, /mergeListControls = compactLayout && !isMobile/, file);
  }
});

test("三页的分类条都包在 fx-tabs-row 里，手机 + 精简下带 SearchToggle，搜索行按 phoneSearchOpen 显示", () => {
  for (const [file, source] of pages) {
    assert.match(source, /className="fx-tabs-row"/, file);
    assert.match(source, /import \{ SearchToggle \} from "@\/components\/ListControls"/, file);
    assert.match(source, /collapsePhoneSearch \? \(\s*<SearchToggle/, file);
    assert.match(source, /const \[phoneSearchOpen, setPhoneSearchOpen\] = useState\(false\)/, file);
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
