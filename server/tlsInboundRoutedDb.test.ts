import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/**
 * 转送规则落到库里的那几条规矩：转发资源的每台入口机挂自己同端口的入站（没有 / 名字被占 / 不在白名单
 * 时挂锚点 = 那台不下发）、名字记在子规则名下且不重复记、回环端口在每台入口机上都空着、
 * 老 Agent 挂不上转送规则、挂了入口组的隧道不支持。
 */
const setup = String.raw`
    const db = await import(url("server/db.ts"));
    const service = await import(url("server/tlsInbounds.ts"));
    const children = await import(url("server/sniGroupChildren.ts"));

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'bob', 'hash', 'user')");
    for (const [id, name] of [[10, 'hk'], [11, 'sg'], [12, 'jp']]) {
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId, agentVersion) VALUES (?, ?, ?, ?, ?, 1, '2.2.253')", [id, name, '1.2.3.' + id, '1.2.3.' + id, 'tok' + id]);
    }
    const makeInbound = async (hostId, overrides = {}) => {
      const value = service.normalizeTlsInboundInput({ name: "共享", port: 443, ...overrides });
      await service.validateTlsInboundChange({ hostId, settings: value });
      return Number(await db.createTlsInbound(hostId, value));
    };
    const insertRule = async (row) => {
      const full = { userId: 2, isEnabled: 1, forwardGroupId: null, forwardGroupRuleId: null, isForwardGroupTemplate: 0, tlsInboundId: null, names: [], ...row };
      await exec(
        "INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, pendingDelete, isForwardGroupTemplate, forwardGroupId, forwardGroupRuleId, tlsInboundId, sniNames) VALUES (?, ?, ?, ?, 'realm', 'tcp', ?, '8.8.8.8', 443, ?, 0, ?, ?, ?, ?, ?)",
        [full.id, full.userId, "r" + full.id, full.hostId, full.sourcePort, full.isEnabled, full.isForwardGroupTemplate, full.forwardGroupId, full.forwardGroupRuleId, full.tlsInboundId, JSON.stringify(full.names)],
      );
      return full.id;
    };
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "tls-inbound-routed", setup });
}

test("转发资源的子规则：每台入口机挂自己同端口的入站，用不了时挂锚点并说清原因", () => {
  runInDatabase(String.raw`
    const anchorId = await makeInbound(10);
    const memberId = await makeInbound(11, { allowedSni: "example.com" });
    // 主机 11 上一条直连 SNI 规则占着 taken.example.com。
    await insertRule({ id: 50, hostId: 11, sourcePort: 45050, tlsInboundId: memberId, names: ["taken.example.com"] });
    await db.replaceRuleSniNames(50, memberId, ["taken.example.com"]);
    const template = { id: 299, tlsInboundId: anchorId, sniNames: JSON.stringify(["shop.example.com"]) };

    const onAnchor = await children.planSniChild(template, 10, []);
    assert.equal(onAnchor.columns.tlsInboundId, anchorId);
    assert.equal(onAnchor.registerOn, null, "锚点那台的名字记在模板名下");
    assert.equal(onAnchor.blockedReason, null);

    const onMember = await children.planSniChild(template, 11, []);
    assert.equal(onMember.columns.tlsInboundId, memberId);
    assert.equal(onMember.registerOn.id, memberId);
    assert.equal(onMember.columns.protocol, "tcp");

    const missing = await children.planSniChild(template, 12, []);
    assert.equal(missing.columns.tlsInboundId, anchorId, "没有同端口入站：挂锚点，心跳按停用下发");
    assert.match(missing.blockedReason, /没有端口 443/);

    const taken = await children.planSniChild({ ...template, sniNames: JSON.stringify(["taken.example.com"]) }, 11, []);
    assert.equal(taken.columns.tlsInboundId, anchorId);
    assert.match(taken.blockedReason, /已被其他规则占用/);
    // 占着名字的就是这台上自己的子规则：不算冲突。
    const own = await children.planSniChild({ ...template, sniNames: JSON.stringify(["taken.example.com"]) }, 11, [50]);
    assert.equal(own.columns.tlsInboundId, memberId);

    const outside = await children.planSniChild({ ...template, sniNames: JSON.stringify(["shop.other.net"]) }, 11, []);
    assert.match(outside.blockedReason, /白名单不包含/);

    assert.equal(await children.planSniChild({ id: 1, tlsInboundId: null }, 10, []), null, "不是 SNI 模板：子规则照旧");
  `);
});

test("子规则的名字：记在子规则名下、重复同步不动、锚点那台不重复记", () => {
  runInDatabase(String.raw`
    const anchorId = await makeInbound(10);
    const memberId = await makeInbound(11);
    const names = ["shop.example.com"];
    await insertRule({ id: 299, hostId: 10, sourcePort: 45003, isForwardGroupTemplate: 1, forwardGroupId: 5, tlsInboundId: anchorId, names });
    await db.replaceRuleSniNames(299, anchorId, names);
    await insertRule({ id: 300, hostId: 10, sourcePort: 45003, forwardGroupId: 5, forwardGroupRuleId: 299, tlsInboundId: anchorId, names });
    await insertRule({ id: 301, hostId: 11, sourcePort: 45003, forwardGroupId: 5, forwardGroupRuleId: 299, tlsInboundId: memberId, names });
    const template = await db.getForwardRuleById(299);
    await children.syncSniChildNames(300, template, { groupId: 5 });
    await children.syncSniChildNames(301, template, { groupId: 5 });
    assert.deepEqual(await db.findSniNameOwners(anchorId, names), [{ name: "shop.example.com", ruleId: 299 }]);
    assert.deepEqual(await db.findSniNameOwners(memberId, names), [{ name: "shop.example.com", ruleId: 301 }]);
    await children.syncSniChildNames(301, template, { groupId: 5 });
    assert.deepEqual(await db.findSniNameOwners(memberId, names), [{ name: "shop.example.com", ruleId: 301 }]);
    // 别人在主机 11 的入站上就拿不到这个名字了。
    const member = await db.getTlsInboundById(memberId);
    await assert.rejects(service.validateSniRuleNames({ inbound: member, names: "shop.example.com" }), /已被其他规则占用/);
    // 子规则改挂锚点（这台不再可用）：名字放掉。
    await exec("UPDATE forward_rules SET tlsInboundId = ? WHERE id = 301", [anchorId]);
    await children.syncSniChildNames(301, template, { groupId: 5 });
    assert.deepEqual(await db.findSniNameOwners(memberId, names), []);
  `);
});

test("建 / 改转发资源上的 SNI 规则前：每台入口机的入站都要容得下这些名字，缺入站的只提示", () => {
  runInDatabase(String.raw`
    const anchorId = await makeInbound(10);
    const memberId = await makeInbound(11, { allowedSni: "example.com" });
    await insertRule({ id: 50, hostId: 11, sourcePort: 45050, tlsInboundId: memberId, names: ["taken.example.com"] });
    await db.replaceRuleSniNames(50, memberId, ["taken.example.com"]);
    const anchor = await db.getTlsInboundById(anchorId);
    const ok = await service.validateSniNamesOnGroupHosts({ anchor, names: ["shop.example.com"], hostIds: [10, 11, 12] });
    assert.deepEqual(ok.missingHostIds, [12]);
    await assert.rejects(service.validateSniNamesOnGroupHosts({ anchor, names: ["taken.example.com"], hostIds: [10, 11] }), /入口主机「sg」上/);
    await assert.rejects(service.validateSniNamesOnGroupHosts({ anchor, names: ["shop.other.net"], hostIds: [10, 11] }), /白名单不包含/);
    // 改规则时，它自己的子规则占着的名字不算冲突。
    await service.validateSniNamesOnGroupHosts({ anchor, names: ["taken.example.com"], hostIds: [10, 11], excludeRuleIds: [50] });
  `);
});

test("回环端口在每台入口机上都空着；老 Agent 挂不上转送规则", () => {
  runInDatabase(String.raw`
    // 主机 11 上 45000 已经被占了，主机 10 上没有：挑出来的端口两台都得空着。
    await insertRule({ id: 60, hostId: 11, sourcePort: 45000 });
    const reservation = await service.reserveSniBackendPortOnHosts([10, 11]);
    assert.ok(reservation.port >= 45000 && reservation.port <= 59999);
    assert.notEqual(reservation.port, 45000);
    reservation.release();

    const inboundId = await makeInbound(10);
    const inbound = await db.getTlsInboundById(inboundId);
    await exec("UPDATE hosts SET agentVersion = '2.2.252' WHERE id = 10");
    await service.requireTlsInboundRunnable(inbound);
    await assert.rejects(service.requireTlsInboundRunnable(inbound, { routeKind: "tunnel" }), /2\.2\.253/);
    await assert.rejects(service.requireTlsInboundRunnable(inbound, { routeKind: "group" }), /需要升级 Agent/);
  `);
});

test("经隧道：入站要在隧道入口机上，挂了入口组的隧道不支持；隧道型转发组不支持", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound(10);
    const inbound = await db.getTlsInboundById(inboundId);
    service.assertSniTunnelUsable({ id: 7, isEnabled: true, entryHostId: 10, entryGroupId: null }, inbound);
    assert.throws(() => service.assertSniTunnelUsable({ id: 7, isEnabled: true, entryHostId: 11 }, inbound), /隧道的入口主机上/);
    assert.throws(() => service.assertSniTunnelUsable({ id: 7, isEnabled: true, entryHostId: 10, entryGroupId: 3 }, inbound), /入口组/);
    assert.throws(() => service.assertSniTunnelUsable({ id: 7, isEnabled: false, entryHostId: 10 }, inbound), /已停用/);
    assert.equal(service.sniGroupUnsupportedReason({ groupMode: "chain", groupType: "host", members: [] }), null);
    assert.equal(service.sniGroupUnsupportedReason({ groupMode: "port", groupType: "host", members: [] }), null);
    assert.equal(service.sniGroupUnsupportedReason({ groupMode: "failover", groupType: "host", members: [{ memberType: "host" }] }), null);
    assert.match(service.sniGroupUnsupportedReason({ groupMode: "failover", groupType: "tunnel", members: [] }), /隧道型/);
    assert.match(service.sniGroupUnsupportedReason({ groupMode: "entry" }), /入口组/);
  `);
});
