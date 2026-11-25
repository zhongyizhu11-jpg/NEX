import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

import { inetAtonIpv4, restrictedForwardTargetClass, ruleTargetAddresses } from "./ruleTargetPolicy";

test("受限目标：环回、内网、链路本地、组播、未指定都认得出来，换写法也一样", () => {
  const restricted: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["localhost", "loopback"],
    ["db.localhost", "loopback"],
    ["::1", "loopback"],
    ["[0:0:0:0:0:0:0:1]", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    // inet_aton 的写法：看着像域名，getaddrinfo 却当成 127.0.0.1
    ["2130706433", "loopback"],
    ["0x7f000001", "loopback"],
    ["127.1", "loopback"],
    ["0177.0.0.1", "loopback"],
    ["10.0.0.5", "private"],
    ["192.168.1.1", "private"],
    ["172.16.3.4", "private"],
    ["100.64.0.1", "private"],
    ["fd00::1", "private"],
    ["169.254.169.254", "linkLocal"],
    ["fe80::1", "linkLocal"],
    ["224.0.0.1", "multicast"],
    ["0.0.0.0", "reserved"],
    ["::", "reserved"],
    ["255.255.255.255", "reserved"],
    ["240.0.0.1", "reserved"],
  ];
  for (const [address, kind] of restricted) {
    assert.equal(restrictedForwardTargetClass(address), kind, address);
  }
  // 公网地址和域名不受限；shared/ipAddress 为 SSRF 划宽了的那几段在这里按 RFC 算，不误伤。
  for (const address of ["8.8.8.8", "203.0.1.1", "198.51.1.1", "192.0.1.1", "203.0.113.10", "2001:db8::1", "2606:4700::1111", "example.com", "cafe.be", "1.2.3.4.5"]) {
    assert.equal(restrictedForwardTargetClass(address), null, address);
  }
  assert.equal(inetAtonIpv4("10.1"), "10.0.0.1");
  assert.equal(inetAtonIpv4("192.168.257"), "192.168.1.1");
  assert.equal(inetAtonIpv4("1.2.3.256"), null);
  assert.equal(inetAtonIpv4("example"), null);
});

test("规则的目标清单：线路组看落地，不看入口 Agent 的拨号地址", () => {
  assert.deepEqual(
    ruleTargetAddresses({
      targetIp: "203.0.113.1",
      failoverEnabled: true,
      failoverTargets: JSON.stringify([{ targetIp: "10.0.0.9", targetPort: 80 }]),
    }),
    ["203.0.113.1", "10.0.0.9"],
  );
  assert.deepEqual(
    ruleTargetAddresses({ targetIp: "203.0.113.1", failoverEnabled: false, failoverTargets: JSON.stringify([{ targetIp: "10.0.0.9", targetPort: 80 }]) }),
    ["203.0.113.1"],
  );
  assert.deepEqual(
    ruleTargetAddresses({
      targetIp: "203.0.113.1",
      targetPort: 80,
      failoverEnabled: true,
      // 线路组时 failoverTargets 里是中转机的入口（面板自己算的），不当成用户填的目标
      failoverTargets: JSON.stringify([{ targetIp: "10.9.9.9", targetPort: 30000 }]),
      routePaths: JSON.stringify([
        { key: "aa", hops: [], dest: null, weight: 50 },
        { key: "bb", hops: [7], dest: { ip: "169.254.169.254", port: 80 }, weight: 50 },
      ]),
    }),
    ["203.0.113.1", "169.254.169.254"],
  );
});

test("非管理员的受限目标：只有拨目标的机器全是自己的才放行；编辑隧道规则同样拦", () => {
  runInDatabase(String.raw`
    const policy = await import(url("server/ruleTargetPolicy.ts"));
    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => exec(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const now = Math.floor(Date.now() / 1000);
    await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled"], [1, "admin", "x", "admin", 1, 1, 1]);
    await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled"], [2, "member", "x", "user", 1, 1, 1]);
    for (const [id, ownerId] of [[1, 1], [2, 1], [3, 2], [4, 2]]) {
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [id, "h" + id, "198.18.0." + id, "198.18.0." + id, ownerId, 1, now, 10000, 30000]);
    }
    await insert("user_host_permissions", ["userId", "hostId"], [2, 1]);
    await insert("user_host_permissions", ["userId", "hostId"], [2, 2]);
    // 40：出口是管理员的机器；41：入口是管理员的机器、出口是他自己的
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [40, "via-admin-exit", 1, 2, "tls", 24040, 2, 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [41, "via-own-exit", 1, 3, "tls", 24041, 2, 1]);
    const cols = ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
    await insert("forward_rules", cols, [140, 1, "admin-exit-rule", "gost", "tcp", 40, 25040, 11040, "203.0.113.40", 80, 2, 0, 0]);
    await insert("forward_rules", cols, [141, 1, "own-exit-rule", "gost", "tcp", 41, 25041, 11041, "203.0.113.41", 80, 2, 0, 0]);

    const member = { id: 2, role: "user" };
    await assert.rejects(
      () => policy.assertRuleTargetsAllowedForActor(member, { targetIp: "127.0.0.1" }, { hostId: 1 }),
      /环回地址/,
    );
    await policy.assertRuleTargetsAllowedForActor(member, { targetIp: "127.0.0.1" }, { hostId: 3 });
    await policy.assertRuleTargetsAllowedForActor({ id: 1, role: "admin" }, { targetIp: "127.0.0.1" }, { hostId: 1 });
    await policy.assertRuleTargetsAllowedForActor(member, { targetIp: "203.0.113.5" }, { hostId: 1 });
    await assert.rejects(
      () => policy.assertRuleTargetsAllowedForActor(member, {
        targetIp: "203.0.113.5",
        failoverEnabled: true,
        failoverTargets: JSON.stringify([{ targetIp: "169.254.169.254", targetPort: 80 }]),
      }, { hostId: 3 , tunnel: { id: 40, exitHostId: 2 } }),
      /链路本地地址/,
      "备用线路也要查，隧道看的是出口机",
    );
    await policy.assertRuleTargetsAllowedForActor(member, { targetIp: "10.0.0.8" }, { hostId: 1, tunnel: { id: 41, exitHostId: 3 } });
    await assert.rejects(
      () => policy.assertRuleTargetsAllowedForActor(member, {
        targetIp: "203.0.113.5",
        failoverEnabled: true,
        routePaths: JSON.stringify([{ key: "aa", hops: [2], dest: { ip: "10.1.1.1", port: 22 }, weight: 50 }]),
      }, { hostId: 3 }),
      /内网地址/,
      "线路组的中转机也会拨落地",
    );

    const memberRules = rulesRouter.createCaller(context({ id: 2, username: "member", role: "user", accountEnabled: true, allowedForwardTypes: null }));
    await assert.rejects(() => memberRules.update({ id: 140, targetIp: "127.0.0.1" }), /环回地址/);
    await assert.rejects(() => memberRules.update({ id: 140, targetIp: "2130706433" }), /环回地址/);
    const [unchanged] = await query('SELECT "targetIp" FROM "forward_rules" WHERE "id" = 140');
    assert.equal(unchanged.targetIp, "203.0.113.40");
    await memberRules.update({ id: 141, targetIp: "127.0.0.1" });
    const [changed] = await query('SELECT "targetIp" FROM "forward_rules" WHERE "id" = 141');
    assert.equal(changed.targetIp, "127.0.0.1", "出口是自己的机器时可以转到本机服务");

    // 下发时的那一道：域名解析到内网，只在别人的出口机上拦
    const onAdminExit = policy.createResolvedTargetGate({ id: 2, userId: 1 });
    const tunnelRule = { id: 140, userId: 2, hostId: 1, tunnelId: 40 };
    assert.equal(await onAdminExit(tunnelRule, "internal.example.com", "10.0.0.3"), true);
    assert.equal(await onAdminExit(tunnelRule, "public.example.com", "203.0.113.9"), false);
    assert.equal(await onAdminExit({ ...tunnelRule, userId: 1 }, "internal.example.com", "10.0.0.3"), false, "管理员自己的规则不拦");
    const onEntry = policy.createResolvedTargetGate({ id: 1, userId: 1 });
    assert.equal(await onEntry(tunnelRule, "internal.example.com", "10.0.0.3"), false, "隧道入口不拨目标");
    const onOwnExit = policy.createResolvedTargetGate({ id: 3, userId: 2 });
    assert.equal(await onOwnExit({ id: 141, userId: 2, hostId: 1, tunnelId: 41 }, "nas.lan", "192.168.1.10"), false);
  `, { name: "rule-target-policy" });
});
