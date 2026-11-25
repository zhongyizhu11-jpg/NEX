import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 租户自己那一屏：「我有几条转发在按量扣钱、按什么价」。
 *
 * 「我的套餐」原来只讲套餐额度，一个纯按量计费的租户在那儿是一片空白，还被劝
 * 「去商店下单」—— 而他的「还剩多少」根本不是额度、是余额，在另一页。这条用例盯
 * 的是摆给他看的那两个数：条数和单价。他是照着它判断「我还用不用得起」的。
 */
test("租户看到的按量计费条数和单价要准", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, '张三', 'h', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (3, '李四', 'h', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (10, 'A', '127.0.0.10', 'slave', 't10', 1)");
    await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, userId, isEnabled) VALUES (7, '贵的组', 'host', 'port', '127.0.0.1', 1, 1)");
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (8, '便宜的隧道', 10, 10, 9000, 1)");

    const rule = (id, userId, opts = {}) => exec(
      "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId, tunnelId, forwardGroupId, isEnabled, pendingDelete) VALUES (?, 10, ?, ?, '127.0.0.1', 8080, ?, ?, ?, 1, ?)",
      [id, "r" + id, 10000 + id, userId, opts.tunnelId ?? null, opts.groupId ?? null, opts.pendingDelete ? 1 : 0],
    );
    await rule(201, 2, { groupId: 7 });     // 张三：贵的
    await rule(202, 2, { tunnelId: 8 });    // 张三：便宜的
    await rule(203, 2, {});                 // 张三：没配价的，走套餐
    await rule(204, 2, { groupId: 7, pendingDelete: true }); // 等删除确认的，不算
    await rule(301, 3, { groupId: 7 });     // 李四的，不该算进张三

    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({
      resourceType: "forward_group", resourceId: 7, enabled: true, pricePerGbMilliCents: 280000,
    });
    await billing.upsertTrafficBillingConfig({
      resourceType: "tunnel", resourceId: 8, enabled: true, pricePerGbMilliCents: 50000,
    });

    let mine = await billing.getUserMeteredForwardSummary(2);
    assert.equal(mine.meteredRules, 2, "两条在按量：没配价的和等删除确认的都不算");
    assert.equal(mine.totalRules, 3, "他名下还在跑的转发是 3 条");
    assert.equal(mine.minPricePerGbMilliCents, 50000, "最低价是隧道那条");
    assert.equal(mine.maxPricePerGbMilliCents, 280000, "最高价是转发组那条 —— 界面据此给区间，不编平均价");

    const other = await billing.getUserMeteredForwardSummary(3);
    assert.equal(other.meteredRules, 1, "别人的转发算在别人头上");

    /*
      总开关关着时一分钱都不扣，那就不能对租户说「你有 2 条在按量扣余额」。
      这一屏是他判断「我还用不用得起」的依据，说反了他会去充一笔不需要的钱。
    */
    await billing.setTrafficBillingEnabled(false);
    mine = await billing.getUserMeteredForwardSummary(2);
    assert.equal(mine.meteredRules, 0, "总开关关着时不能说他在被扣钱");

    await billing.setTrafficBillingEnabled(true);
    // 停用那条转发组的配置，贵的那条就回到套餐那一路，单价区间也跟着收窄。
    await billing.upsertTrafficBillingConfig({
      resourceType: "forward_group", resourceId: 7, enabled: false, pricePerGbMilliCents: 280000,
    });
    mine = await billing.getUserMeteredForwardSummary(2);
    assert.equal(mine.meteredRules, 1, "停用的配置等于没配");
    assert.equal(mine.minPricePerGbMilliCents, 50000);
    assert.equal(mine.maxPricePerGbMilliCents, 50000, "只剩一种价时区间要收成一个数，界面才不会显示「¥0.5–0.5」");

    console.log("METERED_ME_OK");
  `, { name: "metered-me", env: { NODE_ENV: "test" } });
});
