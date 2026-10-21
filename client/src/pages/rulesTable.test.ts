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

test("一个数组、精简只换几列：标准是流量列 + 开关列；精简是协议列 + 累计列，开关并进操作列；状态点并进规则名，不再有「状态」列", () => {
  assert.match(source, /ruleTableColumns: RuleTableColumn\[\] = \[/);
  assert.doesNotMatch(source, /ruleTableColumns: RuleTableColumn\[\] = compactLayout/, "不再整个数组两支");
  assert.match(source, /key: "traffic",\s*width: \d+,\s*head: "流量"/);
  assert.match(source, /key: "protocol",\s*width: \d+,\s*head: "协议"/);
  assert.match(source, /key: "total",\s*width: \d+,\s*head: "累计"/);
  assert.match(source, /\.\.\.\(compactLayout \? \[\] : \[\{\s*key: "enabled"/, "精简下没有单独的开关列");
  assert.match(source, /cell: \(rule\) => compactLayout \? \(\s*<div[^>]*>\s*\{renderRuleEnabledSwitch\(rule\)\}\s*\{renderRuleActions\(rule, false, true\)\}/, "精简下开关和编辑 / ··· 在操作列里排一起，诊断进菜单");
  assert.match(source, /primary=\{tableCompact\s*\? \(readOnly \? \[\] : \[editAction\]\)/);
  assert.doesNotMatch(source, /key: "status",\s*width: \d+,\s*head: "状态"/);
  assert.doesNotMatch(source, /<TableHead[^>]*>状态<\/TableHead>/, "表头不再手写");
});

test("表里的入口 / 出口地址带 fx-table-addr（精简下画成药丸，compact.css）", () => {
  assert.ok((source.match(/className="fx-table-addr min-w-0 truncate"/g) ?? []).length >= 2);
});
