import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 「按量计费这一套配好了没有」——计费中心页那份开通清单的数。
 *
 * 这件事原来散在四个地方，其中总开关所在的页面侧边栏点不到，而套餐管理上那张
 * 「按量计费」卡片因为查询被 tab 门控着，**永远显示「已关闭」**（哪怕库里是开的）。
 * 四处都对了才收得到钱，错一处就是静悄悄不生效。
 *
 * 清单上每一环给的都是能拿来做判断的数，所以这条用例盯的是那几个数本身 ——
 * 报错了比不报更糟，人会照着它以为自己配好了。
 */
test("计费开通清单的四个数要算准", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));

    await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'admin', 'h', 'admin', 0)");
    await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (2, '有钱的', 'h', 'user', 5000)");
    await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (3, '没钱的', 'h', 'user', 0)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (10, 'A', '127.0.0.10', 'slave', 't10', 1)");
    await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, userId, isEnabled) VALUES (7, '组', 'host', 'port', '127.0.0.1', 1, 1)");
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (8, '隧道', 10, 10, 9000, 1)");

    let status = await billing.getTrafficBillingSetupStatus();
    assert.equal(status.enabled, false, "默认没开");
    assert.equal(status.configs.active, 0);
    assert.equal(status.tenantUsers, 2, "管理员不算租户 —— 清单问的是「租户用不用得上」");
    assert.equal(status.fundedUsers, 1, "只有一个租户有余额");

    await billing.setTrafficBillingEnabled(true);
    // 一个公开资源（有余额就能用）、一个要单独授权的
    await billing.upsertTrafficBillingConfig({
      resourceType: "forward_group", resourceId: 7, enabled: true, requiresPermission: false, pricePerGbMilliCents: 100000,
    });
    await billing.upsertTrafficBillingConfig({
      resourceType: "tunnel", resourceId: 8, enabled: true, requiresPermission: true, pricePerGbMilliCents: 200000,
    });
    // 再加一条**停用**的：它不该算进「在计费」
    await billing.upsertTrafficBillingConfig({
      resourceType: "host", resourceId: 10, enabled: false, requiresPermission: true, pricePerGbMilliCents: 300000,
    });

    status = await billing.getTrafficBillingSetupStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.configs.total, 3, "三条配置都在库里");
    assert.equal(status.configs.active, 2, "停用的那条不算在计费");
    assert.equal(status.configs.open, 1, "公开的一个");
    assert.equal(status.configs.permissionOnly, 1, "要授权的一个（停用那条不算）");
    assert.equal(status.authorizedUsers, 0, "还没给谁授权");

    /*
      授权要只数**启用中**资源上的。

      给那条停用的主机配置授权两个人，清单不该因此说「已经授权了 2 个人」——
      那是个假的就绪状态：这两个人现在一个资源都用不上。
    */
    await exec("INSERT INTO user_traffic_billing_permissions (userId, resourceType, resourceId) VALUES (2, 'host', 10)");
    await exec("INSERT INTO user_traffic_billing_permissions (userId, resourceType, resourceId) VALUES (3, 'host', 10)");
    status = await billing.getTrafficBillingSetupStatus();
    assert.equal(status.authorizedUsers, 0, "停用资源上的旧授权不代表谁现在用得上");

    await exec("INSERT INTO user_traffic_billing_permissions (userId, resourceType, resourceId) VALUES (2, 'tunnel', 8)");
    status = await billing.getTrafficBillingSetupStatus();
    assert.equal(status.authorizedUsers, 1, "启用中的隧道上授权了一个人");

    // 同一个人在多个资源上被授权，算一个人不是两次。
    await exec("INSERT INTO user_traffic_billing_permissions (userId, resourceType, resourceId) VALUES (2, 'forward_group', 7)");
    status = await billing.getTrafficBillingSetupStatus();
    assert.equal(status.authorizedUsers, 1, "按人去重，不是按授权条数");

    console.log("SETUP_OK");
  `, { name: "setup-status", env: { NODE_ENV: "test" } });
});
