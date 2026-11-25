import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 主机卡片上那行「计费」说的得是真的。
 *
 * 「这台机器上的转发扣的是钱还是套餐流量」——第一版我去查了**主机**上的计费配置，
 * 于是新部署上每台都显示「走套餐流量」。可界面里主机那一档早就禁用了（legacy_host /
 * 旧版本主机计费资源），现在能新建的只有转发组 / 隧道 / 转发链，配置全挂在那边。
 * 换句话说：一个关于钱的结论，在最常见的配法下恒定说反。
 *
 * 所以这条测试盯的是**按转发组配的价**能不能在主机列表上显示出来——不是「函数会不会
 * 返回点什么」。
 */
test("按转发组配的计费，要在主机列表上显示成按量计费", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));
    const { hostsRouter } = await import(url("server/routers/hosts.ts"));

    const callerFor = (user) => hostsRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
    const tenant = { id: 2, username: "tenant", role: "user", accountEnabled: true };

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'hash', 'user')");
    // 三台机器：一台上的转发按转发组计费，一台按隧道计费，一台什么都没配。
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (10, '组计费机', '127.0.0.10', 'slave', 'tok10', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (20, '隧道计费机', '127.0.0.20', 'slave', 'tok20', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (30, '套餐机', '127.0.0.30', 'slave', 'tok30', 2)");
    await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, userId, isEnabled) VALUES (7, '香港组', 'host', 'failover', '127.0.0.1', 2, 1)");
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (8, '日本隧道', 10, 20, 9000, 2)");

    const rule = (id, hostId, extra) => exec(
      "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId, tunnelId, forwardGroupId, pendingDelete) VALUES (?, ?, ?, ?, '127.0.0.1', 8080, 2, ?, ?, ?)",
      [id, hostId, "rule" + id, 10000 + id, extra.tunnelId ?? null, extra.forwardGroupId ?? null, extra.pendingDelete ? 1 : 0],
    );
    await rule(101, 10, { forwardGroupId: 7 });
    await rule(102, 10, {});                       // 同一台机器上没配计费的那条
    await rule(201, 20, { tunnelId: 8 });
    await rule(301, 30, {});
    // 已经删掉、只等 Agent 确认的那条不该再影响「现在怎么计费」
    await rule(302, 30, { forwardGroupId: 7, pendingDelete: true });

    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({
      resourceType: "forward_group", resourceId: 7, enabled: true, pricePerGbMilliCents: 50000,
    });
    await billing.upsertTrafficBillingConfig({
      resourceType: "tunnel", resourceId: 8, enabled: true, pricePerGbMilliCents: 50000,
    });

    const pageFor = async (user) => {
      const page = await callerFor(user).listPage({ cursor: 0, limit: 50 });
      return new Map(page.items.map((item) => [Number(item.id), item]));
    };
    let rows = await pageFor(admin);

    assert.deepEqual(
      rows.get(10).trafficBilling,
      { billedRules: 1, totalRules: 2, pricePerGbMilliCents: 50000, hostDefault: false },
      "转发组上配的价必须看得见 —— 只查主机那一档的话这里会是 null",
    );
    assert.deepEqual(
      rows.get(20).trafficBilling,
      { billedRules: 1, totalRules: 1, pricePerGbMilliCents: 50000, hostDefault: false },
      "隧道上配的价同样算按量计费",
    );
    assert.equal(
      rows.get(30).trafficBilling,
      null,
      "什么都没配的机器才是走套餐流量；等删除确认的那条转发不算数",
    );

    // 非管理员看得到「在计费」，但看不到价钱 —— 服务端就不给。
    await exec("INSERT INTO user_host_permissions (userId, hostId) VALUES (2, 10)").catch(() => {});
    rows = await pageFor(tenant);
    assert.equal(rows.get(10).trafficBilling.billedRules, 1);
    assert.equal(rows.get(10).trafficBilling.pricePerGbMilliCents, 0, "价钱是商家的事，别透给租户");

    /*
      总开关关掉就一分钱都不扣（agentReportRoutes 里是同一个判断）。卡片上还挂着
      「按量计费 ¥0.5/GB」就是在骗人：管理员会以为这台机器在收钱。
    */
    await billing.setTrafficBillingEnabled(false);
    rows = await pageFor(admin);
    assert.equal(rows.get(10).trafficBilling, null, "总开关关着时不能还说在按量计费");
    assert.equal(rows.get(20).trafficBilling, null);

    /*
      整台兜底价：给主机 30 配一条，它上面那条没挂任何组 / 隧道的转发就该按它算。

      这是「每台机器按量计费」这个功能的全部机制 —— 转发找配置的最后一档本来就是
      主机，界面上重新接出来而已。所以这里验的是那一档真的兜得住，而不是弹窗能不能
      保存。
    */
    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({
      resourceType: "host", resourceId: 30, enabled: true, pricePerGbMilliCents: 20000,
    });
    rows = await pageFor(admin);
    assert.deepEqual(
      rows.get(30).trafficBilling,
      { billedRules: 1, totalRules: 1, pricePerGbMilliCents: 20000, hostDefault: true },
      "配了整台兜底价，这台上没单独计价的转发就该按它算",
    );

    /*
      **兜底不是覆盖**：主机 10 上那条挂着转发组 7 的转发要继续按组价（¥0.5/GB），
      同一台上另一条没挂组的才按主机价（¥0.2/GB）。

      这一条是这个功能最容易说错的地方。要是主机价盖过了组价，商家给某个组单独
      定的价会被一条「整台按 X」悄悄抹掉 —— 而他看界面完全看不出来。
    */
    await billing.upsertTrafficBillingConfig({
      resourceType: "host", resourceId: 10, enabled: true, pricePerGbMilliCents: 20000,
    });
    rows = await pageFor(admin);
    assert.equal(rows.get(10).trafficBilling.billedRules, 2, "整台兜底之后两条转发都在计费");
    assert.equal(rows.get(10).trafficBilling.totalRules, 2);
    assert.equal(
      rows.get(10).trafficBilling.pricePerGbMilliCents,
      -1,
      "组价和主机价不一样，界面就不该报一个价 —— 组价必须还在，没被兜底价盖掉",
    );
    assert.equal(
      (await billing.findTrafficBillingResourceForRule({ id: 101, hostId: 10, forwardGroupId: 7, tunnelId: null })).resourceType,
      "forward_group",
      "挂了转发组的转发按组走，不按主机走",
    );

    // 弹窗要拿这台机器自己那条配置回填，所以列表上得带着它；租户拿不到。
    assert.equal(rows.get(30).hostBillingConfig.pricePerGbMilliCents, 20000);
    assert.equal(rows.get(30).hostBillingConfig.requiresPermission, false);
    assert.equal(rows.get(20).hostBillingConfig, null, "没配过的机器是 null，不是一条价钱为 0 的假配置");
    rows = await pageFor(tenant);
    assert.equal(rows.get(30).hostBillingConfig, null, "配置和价钱都是商家的事，不下发给租户");
    assert.equal(rows.get(30).trafficBilling.hostDefault, true, "「整台兜底」这件事本身可以告诉他");

    // 停用那条配置，兜底就该立刻不算数 —— 停用的配置等于没配。
    await billing.upsertTrafficBillingConfig({
      resourceType: "host", resourceId: 30, enabled: false, pricePerGbMilliCents: 20000,
    });
    rows = await pageFor(admin);
    assert.equal(rows.get(30).trafficBilling, null, "停用的兜底价不能还在计费");
    assert.equal(
      rows.get(30).hostBillingConfig.enabled,
      false,
      "但配置本身要留着回填 —— 界面得能显示「配过、停着」，否则人会再配一条",
    );

    console.log("HOST_BILLING_OK");
  `, { name: "host-billing", env: { NODE_ENV: "test" } });
});
