import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 配整台兜底价之前，先算清楚「会把谁接管过去、会停掉谁」。
 *
 * 兜底价是转发找计费配置的最后一档，所以它接管的是这台机器上**所有**没被转发组 /
 * 隧道单独计价的转发 —— 包括走套餐的租户的。计费那条路上没有「这个人是套餐户还是
 * 计费户」这种判断（面板里没这个字段），而套餐户通常余额是 0：余额 ≤ 0 会被停掉
 * **名下全部**转发，不只是这台机器上的。
 *
 * 这条用例盯的是那个摆给人看的数字本身对不对 —— 它是人拿来做决定的依据，报小了
 * 比不报更糟。
 */
test("整台兜底价的预检要算准接管几条、停掉谁", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));

    const GB = 1024 ** 3;

    // 套餐户：有额度、余额 0 —— 正是会被兜底价接管、然后因为扣不动被停掉的那一类
    await exec("INSERT INTO users (id, username, password, role, trafficLimit, balanceCents, canAddRules, accountEnabled) VALUES (2, '套餐户', 'h', 'user', ?, 0, 1, 1)", [100 * GB]);
    // 计费户：有余额
    await exec("INSERT INTO users (id, username, password, role, trafficLimit, balanceCents, canAddRules, accountEnabled) VALUES (3, '计费户', 'h', 'user', 0, 10000, 1, 1)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (10, '共用机', '127.0.0.10', 'slave', 'tok10', 1)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (20, '空机器', '127.0.0.20', 'slave', 'tok20', 1)");
    await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, userId, isEnabled) VALUES (7, '计费组', 'host', 'port', '127.0.0.1', 1, 1)");

    const rule = (id, hostId, userId, groupId, opts = {}) => exec(
      "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId, forwardGroupId, isEnabled, pendingDelete) VALUES (?, ?, ?, ?, '127.0.0.1', 8080, ?, ?, ?, ?)",
      [id, hostId, "rule" + id, 10000 + id, userId, groupId, opts.disabled ? 0 : 1, opts.pendingDelete ? 1 : 0],
    );
    await rule(201, 10, 2, null);   // 套餐户，没配价 → 会被接管
    await rule(202, 10, 2, null);   // 同上，第二条
    await rule(203, 20, 2, null);   // 别的机器上的一条：不该算进「接管」，但要算进「会被停掉」
    await rule(301, 10, 3, 7);      // 计费户，挂在配了价的转发组上 → 不受影响
    await rule(302, 10, 3, null);   // 计费户，没配价 → 会被接管，但他有余额，不会被停
    await rule(303, 10, 3, null, { pendingDelete: true }); // 等删除确认的，不算数

    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({
      resourceType: "forward_group", resourceId: 7, enabled: true, pricePerGbMilliCents: 100000,
    });

    const preview = await billing.previewHostTrafficBillingTakeover(10);
    assert.equal(preview.totalRules, 4, "这台上还在跑的 4 条；等删除确认的那条不算数");
    assert.equal(
      preview.takeoverRules,
      3,
      "挂在计费组上的那条已经有价了，不该算进「会被接管」—— 上面的档优先",
    );

    const byName = new Map(preview.users.map((row) => [row.username, row]));
    assert.equal(byName.get("套餐户").takeoverRules, 2);
    assert.equal(byName.get("套餐户").hasPlanQuota, true, "有套餐额度的要标出来 —— 他本来走的是套餐");
    assert.equal(byName.get("套餐户").wouldStop, true, "余额 0，扣不动");
    assert.equal(
      byName.get("套餐户").enabledRules,
      3,
      "停的是他名下全部转发（含别的机器上那条），只报这台上的会把后果说小",
    );
    assert.equal(byName.get("计费户").wouldStop, false, "有余额的不会被停");

    assert.equal(preview.stopUsers, 1);
    assert.equal(preview.stopRules, 3, "会被停掉的总条数按人头汇总，不是按这台机器");
    assert.equal(preview.users[0].username, "套餐户", "会被停的排在最前面 —— 那是要先看见的");

    // 给他充上钱，预检立刻不再报停。
    await exec('UPDATE "users" SET "balanceCents" = 5000 WHERE "id" = 2');
    const afterTopUp = await billing.previewHostTrafficBillingTakeover(10);
    assert.equal(afterTopUp.stopUsers, 0, "充了钱就扣得动了，不该还在吓人");
    assert.equal(afterTopUp.takeoverRules, 3, "但接管的条数不变 —— 那是另一件事");

    /*
      这台已经配过兜底价了，再打开弹窗：预检仍然要说「3 条在按兜底价走」。

      解析的时候必须跳过主机那一档 —— 不跳的话，那 3 条会被判成「已经有价了」，
      预检就变成 0，等于告诉人「改这个价谁都不影响」。而实际上受影响的正是这 3 条。
      这一条是上一个反向对照没盯住的洞：那时这台还没有主机级配置，抹不抹 hostId
      结果都一样，断言是空的。
    */
    await billing.upsertTrafficBillingConfig({
      resourceType: "host", resourceId: 10, enabled: true, pricePerGbMilliCents: 20000,
    });
    const alreadyPriced = await billing.previewHostTrafficBillingTakeover(10);
    assert.equal(
      alreadyPriced.takeoverRules,
      3,
      "这台已经有兜底价时，预检要说的是「这 3 条正靠它计费」，不是「0 条受影响」",
    );
    assert.equal(
      new Map(alreadyPriced.users.map((row) => [row.username, row])).get("套餐户").takeoverRules,
      2,
      "按人汇总同样不能被自己的兜底价吃掉",
    );

    // 没有转发的机器，预检不该编出东西来。
    const emptyHost = await billing.previewHostTrafficBillingTakeover(20);
    assert.equal(emptyHost.takeoverRules, 1, "空机器上那条也会被接管");
    const noHost = await billing.previewHostTrafficBillingTakeover(999);
    assert.deepEqual(
      { total: noHost.totalRules, takeover: noHost.takeoverRules, users: noHost.users.length },
      { total: 0, takeover: 0, users: 0 },
    );

    console.log("PREVIEW_OK");
  `, { name: "takeover-preview", env: { NODE_ENV: "test" } });
});
