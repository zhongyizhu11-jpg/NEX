import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 用户管理（标准布局重构工作包二）：「流量与权限 › 资源授权」按类型切换，只列选中那一类；
 * 订阅卡三个按钮收成「加赠流量 + ···」。两种布局都这样（2026-10-21 用户定的：除了四个主页面的卡片，
 * 五个工作包就是标准布局）。守在源码上。
 */
const source = fs.readFileSync(path.resolve(import.meta.dirname, "Users.tsx"), "utf8");

test("资源授权：按类型切换（八类各自只按选中项显示，顶上一排药丸，不分布局）", () => {
  assert.equal((source.match(/\{resourceGrantKind === "\w+" && \(/g) ?? []).length, 8);
  assert.doesNotMatch(source, /!compactLayout \|\| resourceGrantKind/);
  assert.match(source, /<FilterChips\s+ariaLabel="资源类型"\s+wrap/);
  // 只显示一段，段与段之间不能再有分隔线（会变成一排空线，2.3.469 手机截图）
  const start = source.indexOf('<TabsContent value="hosts"');
  const grantTab = source.slice(start, source.indexOf("</TabsContent>", start));
  assert.ok(start > 0 && grantTab.length > 0);
  assert.equal((grantTab.match(/<Separator/g) ?? []).length, 0, "授权页里不该再有分隔线");
});

test("订阅卡：只留「加赠流量」一个按钮，更改到期 / 取消进菜单（不分布局）", () => {
  assert.match(source, /aria-label="订阅的更多操作"/);
  assert.doesNotMatch(source, /className="h-8 flex-1 px-2 text-xs sm:flex-none"/, "三个并排按钮那一版已经没有了");
  assert.doesNotMatch(source, /useCompactLayout/, "用户页不再按布局分叉");
});

test("主机 / 链路页：分类条和搜索那一行包进 fx-list-controls 之后，标准布局的 16px 间距不能丢", () => {
  for (const file of ["Hosts.tsx", "Tunnels.tsx"]) {
    const page = fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8");
    assert.match(page, /className="fx-list-controls space-y-4"/, `${file} 的 fx-list-controls 要带 space-y-4`);
  }
});

/*
  「流量与权限设置」不能把权限存成空。

  复现：打开某个用户的设置 → 关掉 → 再打开同一个用户 → 直接点「保存设置」。
  打开时 openTrafficSettings 把五个 ID 列表清成 []，回填靠的是「query data 变了」的 effect；
  第二次打开时 data 还是缓存里那个引用，effect 不跑，列表停在 []，而 isLoading 是 false、
  保存按钮能点，一点就把他的主机 / 转发组 / 隧道授权全写成空。
  修法：effect 以 [弹窗打开, 用户 id, data] 为键，每次打开都重新种子；「加载中」改看 data 到了没。
*/
test("权限弹窗：每次打开都从缓存重新种子，加载判断看 data 而不是 isLoading", () => {
  const perms = ["userHostPerms", "userForwardGroupPerms", "userTunnelPerms", "userProxyNodeShares", "userTrafficBillingPerms"];
  for (const name of perms) {
    assert.match(
      source,
      new RegExp(`\\}, \\[showTrafficSettings, trafficUserId, ${name}\\]\\);`),
      `${name} 的回填 effect 要以 [showTrafficSettings, trafficUserId, data] 为键`,
    );
    assert.doesNotMatch(source, new RegExp(`\\}, \\[${name}\\]\\);`), `${name} 的 effect 不能只看 data`);
    assert.doesNotMatch(source, new RegExp(`isLoading: ${name}Loading`), `${name} 不再用 isLoading 判断`);
  }
  // 「权限加载中」= 这个用户的五份数据有一份还没到
  const guard = source.slice(source.indexOf("const permissionDataLoading ="), source.indexOf(");", source.indexOf("const permissionDataLoading =")));
  for (const name of perms) assert.match(guard, new RegExp(`${name} === undefined`), `permissionDataLoading 要看 ${name} 是否到了`);
  assert.doesNotMatch(guard, /(Perms|Shares)Loading\b/, "permissionDataLoading 不能再用 isLoading");
  // 打开时五个列表一起清空，sharedProxyNodeIds 不能漏
  const opener = source.slice(source.indexOf("const openTrafficSettings = "), source.indexOf("setShowTrafficSettings(true);"));
  for (const setter of ["setAllowedHostIds", "setAllowedForwardGroupIds", "setAllowedTunnelIds", "setSharedProxyNodeIds", "setTrafficBillingHostIds", "setTrafficBillingTunnelIds", "setTrafficBillingForwardGroupIds"]) {
    assert.match(opener, new RegExp(`${setter}\\(\\[\\]\\);`), `打开时要清空 ${setter}`);
  }
  // 保存按钮在数据没到时禁用
  assert.match(source, /disabled=\{updateTrafficMutation\.isPending \|\| permissionDataLoading\}/);
});
