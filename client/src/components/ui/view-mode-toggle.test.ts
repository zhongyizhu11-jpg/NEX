import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 「卡片 / 列表 / 地图」那组图标按钮只有 ViewModeToggle 这一份实现（标准布局重构工作包三）。
 * 原来主机、Token、分组、服务、套餐、转发组、规则、链路、主机监控各复制了一份同样的几行，
 * 改一处漏八处。守在源码上：别的文件里再出现那串按钮类名就报出来。
 * 本地存储的读写同理，只能走 lib/viewModeStorage.ts。
 */
const root = path.resolve(import.meta.dirname, "../..");

function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("视图切换按钮组只有 ViewModeToggle 一份实现", () => {
  const offenders = walk(root)
    .filter((file) => !file.endsWith(path.join("ui", "view-mode-toggle.tsx")))
    .filter((file) => fs.readFileSync(file, "utf8").includes("h-8 w-8 rounded-none"));
  assert.deepEqual(offenders.map((file) => path.relative(root, file)), []);
});

test("视图偏好的本地存储只走 lib/viewModeStorage.ts", () => {
  const offenders = walk(root)
    .filter((file) => !file.endsWith(path.join("lib", "viewModeStorage.ts")))
    .filter((file) => /localStorage\.(getItem|setItem)\(\w*VIEW_MODE\w*\)/i.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((file) => path.relative(root, file)), []);
  // 反向对照：确实有人在用共享的那份
  const users = walk(root).filter((file) => fs.readFileSync(file, "utf8").includes("readStoredViewMode<"));
  assert.ok(users.length >= 8, `用 readStoredViewMode 的文件应该不少于 8 个，现在 ${users.length} 个`);
});
