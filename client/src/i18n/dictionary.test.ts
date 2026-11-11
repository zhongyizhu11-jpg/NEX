import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PATTERNS } from "./patterns";
import { createTranslator, hasCjk, normalizeSource } from "./translate";

const dictionary = JSON.parse(readFileSync(new URL("./en.json", import.meta.url), "utf8")) as Record<string, unknown>;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("词典：键是归一化过的中文原文，值是非空英文，占位一一对应", () => {
  const entries = Object.entries(dictionary);
  assert.ok(entries.length > 3000, `词典只有 ${entries.length} 条`);
  const problems: string[] = [];
  for (const [key, value] of entries) {
    if (typeof value !== "string" || !value.trim()) problems.push(`空值：${key}`);
    else if (value.trim() !== value) problems.push(`值有首尾空白：${key}`);
    else if (hasCjk(value)) problems.push(`值里还有汉字：${key} → ${value}`);
    else if (value === key) problems.push(`值和原文一样：${key}`);
    if (normalizeSource(key) !== key) problems.push(`键没归一化：${JSON.stringify(key)}`);
    if (!hasCjk(key)) problems.push(`键里没有汉字：${key}`);
    if (typeof value === "string" && placeholders(key).join() !== placeholders(value).join()) problems.push(`占位对不上：${key} → ${value}`);
  }
  assert.deepEqual(problems.slice(0, 20), []);
});

test("词典：常用界面文字都有英文", () => {
  const translator = createTranslator(dictionary as Record<string, string>, PATTERNS);
  for (const source of ["总览", "主机管理", "转发规则", "系统设置", "个人资料", "退出登录", "登录", "保存", "取消", "删除", "确认删除", "暂无数据", "上一页", "下一页", "个性化配置", "界面主题"]) {
    const translated = translator.translate(source);
    assert.ok(translated && !hasCjk(translated), `${source} 没有英文`);
  }
});
