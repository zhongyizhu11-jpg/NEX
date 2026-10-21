import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 精简布局的「条状」（用户 2026-10-21 照着老版本表格样稿定的）：
 * 桌面上规则 / 主机 / 链路三个列表页就是一张表 —— 记住的卡片视图不动、回标准布局还是卡片；
 * 视图切换按钮里卡片那几档不出现。手机上没有表，页面根带 data-fx-compact-page，compact.css 把卡片栅格画成两行的列表行。
 * 守在源码上。
 */
const read = (name: string) => fs.readFileSync(path.resolve(import.meta.dirname, name), "utf8");

test("转发页：精简 + 桌面强制表格（3D 图除外），视图按钮只剩表和 3D 图", () => {
  const source = read("Rules.tsx");
  assert.match(source, /const effectiveViewMode: RuleViewMode = isMobile \? "card" : compactLayout && viewMode !== "globe" \? "table" : viewMode;/);
  assert.match(source, /\.\.\.\(compactLayout \? \[\] : \[\s*\{ value: "compact" as const, label: "精简卡片"/);
  assert.match(source, /data-fx-std-page=\{compactLayout \? undefined : ""\} data-fx-compact-page=\{compactLayout \? "" : undefined\}/);
});

test("主机页：精简 + 桌面把两档卡片都换成表，地图照旧；视图按钮只剩表和地图", () => {
  const source = read("Hosts.tsx");
  assert.match(source, /compactLayout && !isBelowMd && \(preferredViewMode === "card" \|\| preferredViewMode === "compact-card"\)\s*\? "table"/);
  assert.match(source, /\.\.\.\(compactLayout \? \[\] : \[\s*\{ value: "compact-card" as const, label: "精简卡片"/);
  assert.match(source, /data-fx-std-page=\{compactLayout \? undefined : ""\} data-fx-compact-page=\{compactLayout \? "" : undefined\}/);
});

test("链路页：精简 + 桌面隧道和转发链 / 组的卡片都换成表；视图按钮里没有卡片那档", () => {
  const source = read("Tunnels.tsx");
  assert.match(source, /const forceTable = compactLayout && !isMobile;/);
  assert.match(source, /const viewMode: TunnelViewMode = forceTable && preferredViewMode === "card" \? "table" : preferredViewMode;/);
  assert.match(source, /const chainViewMode: TunnelViewMode = forceTable && preferredChainViewMode === "card" \? "table" : preferredChainViewMode;/);
  assert.match(source, /\.\.\.\(forceTable \? \[\] : \[\{ value: "card" as const, label: "卡片视图"/);
  assert.match(source, /data-fx-std-page=\{compactLayout \? undefined : ""\} data-fx-compact-page=\{compactLayout \? "" : undefined\}/);
});

test("compact.css 的条状只挂在 data-fx-compact-page 下：不碰监控页等别处的主机卡 / 卡片栅格", () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, "../styles/compact.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const hook of [".fx-rule-card", ".fx-host-card", ".standard-card-grid", ".fx-table-addr", ".fx-rules-table"]) {
    for (const line of css.split("\n").filter((row) => row.includes(hook) && row.includes("{"))) {
      assert.match(line, /html:root \[data-fx-compact-page\]/, `「${line.trim().slice(0, 80)}」没有挂在 data-fx-compact-page 下`);
    }
  }
});
