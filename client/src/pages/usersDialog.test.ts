import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 用户管理（标准布局重构工作包二）：「流量与权限 › 资源授权」按类型切换，只列选中那一类；
 * 订阅卡三个按钮收成「加赠流量 + ···」。守在源码上。
 */
const source = fs.readFileSync(path.resolve(import.meta.dirname, "Users.tsx"), "utf8");

test("资源授权按类型切换：八类各自 gated，顶上一排药丸", () => {
  assert.equal((source.match(/\{resourceGrantKind === "/g) ?? []).length, 8);
  assert.match(source, /<FilterChips\s+ariaLabel="资源类型"/);
});

test("订阅卡只留一个按钮，其余进菜单", () => {
  assert.doesNotMatch(source, /className="h-8 flex-1 px-2 text-xs sm:flex-none"/);
  assert.match(source, /aria-label="订阅的更多操作"/);
});
