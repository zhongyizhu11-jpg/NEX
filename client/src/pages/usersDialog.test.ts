import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 用户管理（标准布局重构工作包二）：「流量与权限 › 资源授权」按类型切换，只列选中那一类；
 * 订阅卡三个按钮收成「加赠流量 + ···」。守在源码上。
 */
const source = fs.readFileSync(path.resolve(import.meta.dirname, "Users.tsx"), "utf8");

test("资源授权：精简下按类型切换（八类各自 gated，顶上一排药丸），标准下照旧全列", () => {
  assert.equal((source.match(/\{\(!compactLayout \|\| resourceGrantKind === "/g) ?? []).length, 8);
  assert.match(source, /\{compactLayout \? \(\s*<FilterChips\s+ariaLabel="资源类型"\s+wrap/);
  // 八段之间的分隔线也要跟着 gate：精简下只显示一段，不 gate 就是一排空线（2.3.469 手机截图）
  const start = source.indexOf('<TabsContent value="hosts"');
  const grantTab = source.slice(start, source.indexOf("</TabsContent>", start));
  assert.ok(start > 0 && grantTab.length > 0);
  assert.equal((grantTab.match(/<Separator \/>/g) ?? []).length, 5);
  assert.equal((grantTab.match(/\{!compactLayout && <Separator \/>\}/g) ?? []).length, 5, "授权页里的分隔线都要 gate 到标准布局");
});

test("主机 / 链路页：分类条和搜索那一行包进 fx-list-controls 之后，标准布局的 16px 间距不能丢", () => {
  for (const file of ["Hosts.tsx", "Tunnels.tsx"]) {
    const page = fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8");
    assert.match(page, /className="fx-list-controls space-y-4"/, `${file} 的 fx-list-controls 要带 space-y-4`);
  }
});

test("订阅卡：精简下只留一个按钮、其余进菜单，标准下照旧三个按钮", () => {
  assert.match(source, /aria-label="订阅的更多操作"/);
  assert.match(source, /className="h-8 flex-1 px-2 text-xs sm:flex-none"/);
});
