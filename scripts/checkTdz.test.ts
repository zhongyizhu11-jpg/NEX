import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  2.3.488 的转发页整页白屏：组件里一个 useMemo 渲染时调用了前面的 useCallback，那个回调又用到了
  写在 useMemo 后面的 const —— "Cannot access 'uu' before initialization"。类型检查看不出来，
  只有真打开页面才炸。scripts/check-tdz.mjs 按语句顺序查这种「定义前就用到」，这里守着它：
  整棵 client/src + shared 得是干净的，而且它得认得出当年那个形状。
*/
const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "check-tdz.mjs");

test("client/src 和 shared 里没有「定义前就用到」的 const", () => {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("check-tdz 认得出 2.3.488 那种 useMemo → useCallback → 后面的 const", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-check-tdz-"));
  const file = path.join(directory, "repro.tsx");
  fs.writeFileSync(file, `
import { useCallback, useMemo } from "react";
export function Comp({ rules }: { rules: any[] }) {
  const resolve = useCallback((rule: any) => ({ names: helper(rule) }), []);
  const statuses = useMemo(() => {
    const out = new Map();
    for (const rule of rules) out.set(rule.id, resolve(rule));
    return out;
  }, [rules, resolve]);
  // 只在事件里才调用的，定义在后面没关系。
  const later = (rule: any) => { const name = String(rule.name); return name; };
  const helper = (rule: any): string[] => [String(rule.hostId)];
  const { data: isLoading } = { data: false }; // 解构里的属性名不是引用
  const onClick = () => later(rules[0]);
  return <div onClick={onClick}>{statuses.size}{String(isLoading)}</div>;
}
`);
  const result = spawnSync(process.execPath, [script, file], { cwd: root, encoding: "utf8" });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /用到了 helper，它在第 \d+ 行才定义/);
  assert.doesNotMatch(result.stderr, /later|isLoading/);
});
