import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 规则表格（标准布局重构工作包一）：列定义只写一遍，colgroup、表头、单元格都从 ruleTableColumns 出；
 * 不再按管理员 / 排序各写一个 1610～1764px 的最小宽度。守在源码上。
 */
const source = fs.readFileSync(path.resolve(import.meta.dirname, "Rules.tsx"), "utf8");

test("规则表格的列只在 ruleTableColumns 里定义一遍", () => {
  assert.ok((source.match(/ruleTableColumns\.map\(/g) ?? []).length >= 3, "colgroup、表头、单元格三处都从 ruleTableColumns 出");
  // 最小宽度只剩一档（1366 宽不横滚）；不再按管理员 / 排序各写一个
  assert.doesNotMatch(source, /min-w-\[1764px\]|min-w-\[1654px\]|min-w-\[1720px\]|min-w-\[1610px\]/);
  assert.match(source, /"fx-rules-table table-fixed min-w-\[1000px\]"/);
  assert.match(source, /colSpan=\{ruleTableColumnCount\}/, "分组表头那一行的跨列数跟着列数组走");
});

test("只有一套列（两种布局共用）：累计 / 24H 合成流量列，状态点并进规则名，不再有「状态」列", () => {
  assert.match(source, /ruleTableColumns: RuleTableColumn\[\] = \[/);
  assert.doesNotMatch(source, /ruleTableColumns: RuleTableColumn\[\] = compactLayout/);
  assert.match(source, /key: "traffic",\s*width: \d+,\s*head: "流量"/);
  assert.doesNotMatch(source, /key: "status",\s*width: \d+,\s*head: "状态"/);
  assert.doesNotMatch(source, /<TableHead[^>]*>状态<\/TableHead>/, "表头不再手写");
});
