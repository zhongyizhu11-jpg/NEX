import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

import { canAddSelfServiceHost, selfServiceHostLimitForUser } from "./routers/hosts";

/**
 * 「这个租户能自助加几台机器」。
 *
 * 原来只有一个全局设置，所有人一个数。想给某个人多开两台就得把全体调高。
 *
 * 关键取舍：用户行上的 0 表示**跟随全局**，不是「不限」。别的配额（maxRules、
 * maxProxyInbounds）0 都是不限，这里刻意不一样 —— 因为全局那一档本来就是个真实
 * 上限（默认 10 台）。要是 0 也当成不限，管理员把某人调成 0 反而等于给他松了绑，
 * 恰好和他想做的事相反。那种「填 0 结果全放开」的字段迟早出事。
 */
test("留空就用全局那一档", () => {
  assert.equal(selfServiceHostLimitForUser({ maxSelfServiceHosts: null }, 10), 10);
  assert.equal(selfServiceHostLimitForUser({}, 10), 10);
  assert.equal(selfServiceHostLimitForUser(null, 10), 10);
  assert.equal(selfServiceHostLimitForUser(undefined, 3), 3);
});

test("给这个人单独设了就用他的，不管全局是多少", () => {
  assert.equal(selfServiceHostLimitForUser({ maxSelfServiceHosts: 2 }, 10), 2, "调低");
  assert.equal(selfServiceHostLimitForUser({ maxSelfServiceHosts: 50 }, 10), 50, "调高");
});

/**
 * 这一条是这个字段的全部意义所在。
 *
 * 「留空」和「0」必须是两件事：留空 = 跟着全局走，0 = 一台都不给他。早先我把 0
 * 也当成「跟随全局」，那样管理员**根本没有办法**卡死某一个人 —— 而「能自定义给他
 * 几台」这句话里，最自然的那个数就是 0。
 *
 * 另一个反方向的坑同样要避开：旧的 canAddSelfServiceHost 写的是 `limit <= 0 就放行`
 * （那时候只有全局设置、0 表示不限），照那个算，卡到 0 反而是把人放开。
 */
test("0 是一台都不许加，不是「不限」也不是「跟随全局」", () => {
  const limit = selfServiceHostLimitForUser({ maxSelfServiceHosts: 0 }, 10);
  assert.equal(limit, 0, "0 要原样留住，不能被当成没填");
  assert.equal(
    canAddSelfServiceHost({ role: "user" }, 0, limit),
    false,
    "一台都还没加就该被挡住 —— 否则这个字段是个陷阱",
  );
});

test("全局设成 0（不限）时，没单独设的人也不限", () => {
  const limit = selfServiceHostLimitForUser({}, 0);
  assert.equal(limit, null, "不限要用 null 表示，别和「0 台」挤在同一个数上");
  assert.equal(canAddSelfServiceHost({ role: "user" }, 999, limit), true);
});

test("脏值一律回落到全局，不会算出一个负数上限", () => {
  for (const bad of [-5, "abc", NaN]) {
    assert.equal(selfServiceHostLimitForUser({ maxSelfServiceHosts: bad }, 10), 10, String(bad));
  }
});

test("管理员不受这个限制 —— 拦了反而碍事", () => {
  assert.equal(canAddSelfServiceHost({ role: "admin" }, 999, 1), true);
  assert.equal(canAddSelfServiceHost({ role: "admin" }, 999, 0), true);
});

/** 光有解析逻辑不够：这一列得真的存得下、读得回来。 */
test("SQLite 管理员设的台数存得下、读得回来", () => {
  runInDatabase(String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const { selfServiceHostLimitForUser } = await import(url("server/routers/hosts.ts"));

    await exec("INSERT INTO users (id, username, password, role) VALUES (1,'tenant','h','user')");

    const fresh = await users.getUserById(1);
    assert.equal(fresh.maxSelfServiceHosts ?? null, null, "新用户是留空 = 跟随全局");
    assert.equal(selfServiceHostLimitForUser(fresh, 10), 10);

    // 走管理员那条真实路径（users 路由最后调的就是它），别测一个不存在的函数。
    await billing.updateUserManualEntitlements(1, { maxSelfServiceHosts: 3 });
    const capped = await users.getUserById(1);
    assert.equal(Number(capped.maxSelfServiceHosts), 3, "管理员设的数要真的落库");
    assert.equal(selfServiceHostLimitForUser(capped, 10), 3, "落库之后要压过全局");
  `, { name: "host-limit" });
});
