import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDefaultLandingConfig,
  describeLandingConfig,
  landingMemberPort,
  landingPoolDnsValues,
  landingPoolPrimary,
  parseLandingConfig,
  validateLandingConfig,
  type LandingMemberHealth,
} from "../shared/landingPool";
import { fillLandingCredentials } from "./landingPools";
import { mergeLandingInput, normalizeDirectDomain } from "./landingPoolSave";

/*
  落地池（2.3.500）：一份配置开在每台成员上，订阅里整个池一条。
*/

test("第一版只放没有证书的协议：VLESS 能上 REALITY，别的不加 TLS；凭据补齐后能过校验", () => {
  const reality = fillLandingCredentials(createDefaultLandingConfig());
  assert.equal(validateLandingConfig(reality), "");
  assert.ok(reality.realityPrivateKey && reality.realityPublicKey && reality.serverName);
  assert.equal(reality.users.length, 1, "多用户协议一个用户都没有时补一个默认的");
  assert.ok(reality.users[0].uuid);
  assert.equal(describeLandingConfig(reality), "VLESS · REALITY · 443");

  const vmess = parseLandingConfig({ ...createDefaultLandingConfig(), protocol: "vmess", security: "reality", transport: "ws" })!;
  assert.equal(vmess.security, "none", "VMess 不能上 REALITY：读进来就收成不加 TLS");
  assert.equal(validateLandingConfig(fillLandingCredentials(vmess)), "");

  const ss = fillLandingCredentials({ ...createDefaultLandingConfig(), protocol: "shadowsocks", security: "none", method: "2022-blake3-aes-256-gcm", users: [] });
  assert.equal(validateLandingConfig(ss), "");
  assert.equal(Buffer.from(ss.password, "base64").length, 32, "SS2022 的密钥按方法定长");
  assert.equal(ss.users.length, 0);

  assert.equal(parseLandingConfig({ protocol: "trojan", port: 443 }), null, "要证书的协议认不出来");
  assert.match(validateLandingConfig({ ...reality, port: 0 }), /端口/);
});

test("每台用哪个端口：池端口能用就用；被占了换一个；开了域名直连不换（那台不开）；已经换过的接着用", () => {
  assert.deepEqual(landingMemberPort({ desiredPort: 443, desiredFree: true, currentPort: 0, currentFree: false, requireSamePort: false, fallbackPort: 0 }), { port: 443, fallback: false, error: null });
  assert.deepEqual(landingMemberPort({ desiredPort: 443, desiredFree: false, currentPort: 0, currentFree: false, requireSamePort: false, fallbackPort: 20001 }), { port: 20001, fallback: true, error: null });
  const strict = landingMemberPort({ desiredPort: 443, desiredFree: false, currentPort: 0, currentFree: false, requireSamePort: true, fallbackPort: 20001 });
  assert.equal(strict.port, 0);
  assert.match(String(strict.error), /同一个端口/);
  assert.deepEqual(landingMemberPort({ desiredPort: 443, desiredFree: false, currentPort: 20005, currentFree: true, requireSamePort: false, fallbackPort: 20001 }), { port: 20005, fallback: true, error: null }, "不来回换端口");
  assert.deepEqual(landingMemberPort({ desiredPort: 443, desiredFree: true, currentPort: 20005, currentFree: true, requireSamePort: false, fallbackPort: 0 }), { port: 443, fallback: false, error: null }, "池端口空出来了换回去");
});

test("首选：排在前面、开着、在线的那台；DNS 只写开着、在线、同端口、有 IPv4 的", () => {
  const members: LandingMemberHealth[] = [
    { hostId: 1, ready: true, healthy: false, address: "a.example.com", ipv4: "203.0.113.1", port: 443 },
    { hostId: 2, ready: true, healthy: true, address: "203.0.113.2", ipv4: "203.0.113.2", port: 443 },
    { hostId: 3, ready: true, healthy: true, address: "203.0.113.3", ipv4: "203.0.113.3", port: 20001 },
    { hostId: 4, ready: false, healthy: true, address: "203.0.113.4", ipv4: "203.0.113.4", port: 0 },
  ];
  assert.equal(landingPoolPrimary(members)?.hostId, 2);
  assert.equal(landingPoolPrimary(members.map((member) => ({ ...member, healthy: false })))?.hostId, 1, "都不在线时排最前、开着的那台");
  assert.deepEqual(landingPoolDnsValues(members, 443), ["203.0.113.2"]);
});

test("表单进来：改名不换凭据；换协议整份换新；新用户补凭据，分享发的那几份照留", () => {
  const first = mergeLandingInput(null, { protocol: "vless", port: 443, users: [{ id: 0, name: "我" }] });
  assert.equal(first.credentialsReset, false);
  const uuid = first.config.users[0].uuid;
  const withShare = { ...first.config, users: [...first.config.users, { id: 9, name: "小王", uuid: "u-share", password: "", sharedUserId: 42 }], nextUserId: 10 };
  const renamed = mergeLandingInput(withShare, { protocol: "vless", port: 8443, users: [{ id: first.config.users[0].id, name: "我自己" }, { id: 0, name: "备用" }] });
  assert.equal(renamed.credentialsReset, false);
  assert.equal(renamed.config.port, 8443);
  assert.equal(renamed.config.users[0].uuid, uuid, "没动的用户凭据留着");
  assert.equal(renamed.config.users[0].name, "我自己");
  assert.ok(renamed.config.users[1].uuid && renamed.config.users[1].uuid !== uuid, "新用户有自己的凭据");
  assert.ok(renamed.config.users.some((user) => user.sharedUserId === 42 && user.uuid === "u-share"), "分享发的那份不在表单里也留着");
  const switched = mergeLandingInput(renamed.config, { protocol: "shadowsocks", port: 8443, method: "2022-blake3-aes-128-gcm" });
  assert.equal(switched.credentialsReset, true);
  assert.equal(switched.config.users.length, 0);
  assert.ok(switched.config.password);
  assert.throws(() => normalizeDirectDomain("1.2.3.4"), /域名/);
  assert.equal(normalizeDirectDomain(" HK.Example.com. "), "hk.example.com");
  assert.equal(normalizeDirectDomain(""), null);
});

/**
 * 真的 sqlite 跑一遍：三台成员（一台 443 被占）、凭据一模一样、池节点一条、域名直连要同端口、
 * 去掉一台收掉它的入站、目标是池的转发做成线路组、分享每人一份凭据。
 */
test("落地池同步：每台一样的入站、被占换端口、池节点一条、转发做成线路组、分享每人一份", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-landing-pool-"));
  try {
    const script = String.raw`
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role, \"allowProxySubscription\") VALUES (1, 'admin', 'hash', 'admin', 1), (2, 'tenant', 'hash', 'user', 1)");
      const now = Math.floor(Date.now() / 1000);
      for (const id of [1, 2, 3, 4]) {
        await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)', [id, "H" + id, "203.0.113." + id, "203.0.113." + id, "slave", "tok" + id, now, "2.2.244"]);
      }
      // H3 的 443 已经被别的落地入站占了
      await exec('INSERT INTO proxy_inbounds (id, "userId", "hostId", name, protocol, port, transport, security, "isEnabled") VALUES (90, 1, 3, ?, ?, 443, ?, ?, 1)', ["别的", "vless", "tcp", "none"]);
      const db = await import(url("server/db.ts"));
      const pools = await import(url("server/nodePools.ts"));
      const landing = await import(url("server/landingPools.ts"));
      const save = await import(url("server/landingPoolSave.ts"));
      const out = {};

      const { config } = save.mergeLandingInput(null, { protocol: "vless", port: 443, users: [{ id: 0, name: "默认" }] });
      const poolId = Number(await pools.createNodePool({ userId: 1, name: "HK 落地池", role: "landing", hostIds: [1, 2, 3], landingJson: JSON.stringify(config) }));
      const first = await landing.syncLandingPool(poolId, { reason: "test" });
      out.first = first.members.map((m) => [m.hostId, m.port, m.portFallback, m.error]);
      const members = await query('SELECT id, "hostId", port, "realityPrivateKey", "realityPublicKey" FROM proxy_inbounds WHERE "nodePoolId" = ? ORDER BY "hostId"', [poolId]);
      out.memberHosts = members.map((row) => Number(row.hostId));
      out.sameKeys = new Set(members.map((row) => row.realityPrivateKey + "|" + row.realityPublicKey)).size === 1;
      const userRows = await query('SELECT "inboundId", uuid FROM proxy_inbound_users WHERE "inboundId" IN (' + members.map(() => "?").join(",") + ')', members.map((row) => row.id));
      out.sameUuid = new Set(userRows.map((row) => row.uuid)).size === 1 && userRows.length === 3;
      out.derivedPerMember = Number((await query('SELECT COUNT(*) AS n FROM proxy_nodes WHERE "inboundId" IN (' + members.map(() => "?").join(",") + ')', members.map((row) => row.id)))[0].n);
      const poolNodes = await landing.getLandingPoolNodes(poolId);
      out.poolNodes = poolNodes.map((node) => [node.address, Number(node.port), !!node.includeDirect]);
      const agentH1 = await db.getEnabledProxyInboundsWithUsersByHost(1);
      out.agentH1 = agentH1.map((item) => [item.port, item.inbound.users.length]);
      // 单独改一台：拒绝
      out.memberEdit = await (async () => {
        const { proxyInboundsRouter } = await import(url("server/routers/proxyInbounds.ts"));
        const caller = proxyInboundsRouter.createCaller({ user: { id: 1, role: "admin", username: "admin", accountEnabled: true }, req: { headers: {}, socket: {} }, res: { setHeader: () => {} }, authSession: null, authFailureReason: null });
        return caller.update({ id: Number(members[0].id), name: "改一台" }).then(() => "ok", (error) => String(error.message));
      })();

      // 设直连域名：H3 只能换端口，不开了
      await pools.updateNodePool(poolId, { directDomain: "hk.example.com" });
      const withDomain = await landing.syncLandingPool(poolId, { reason: "test", domainChanged: true });
      out.withDomain = withDomain.members.map((m) => [m.hostId, m.port, m.error ? "error" : null]);
      out.dnsError = withDomain.dnsError ? "has" : null;
      out.domainNode = (await landing.getLandingPoolNodes(poolId)).map((node) => [node.address, !!node.includeDirect]);
      await pools.updateNodePool(poolId, { directDomain: null });
      await landing.syncLandingPool(poolId, { reason: "test", domainChanged: true });

      // 普通转发的目标选池节点：管理员的 gost 转发，池里两台以上 → 做成线路组
      const poolNodeId = Number((await landing.getLandingPoolNodes(poolId))[0].id);
      await exec('INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "proxyNodeId") VALUES (7, 4, ?, ?, ?, 30443, ?, 443, 1, 1, ?)', ["到落地池", "gost", "tcp", "203.0.113.1", poolNodeId]);
      const target = await import(url("server/landingRouteTarget.ts"));
      out.converted = await target.ensureLandingRouteGroupForRule(7, "test");
      const rule = (await query('SELECT "failoverEnabled", "routeMode", "routePaths" FROM forward_rules WHERE id = 7'))[0];
      out.ruleGroup = [!!Number(rule.failoverEnabled), rule.routeMode, JSON.parse(rule.routePaths).map((p) => [p.destNodeId === poolNodeId, p.destHostId, p.dest ? p.dest.port : null])];
      out.using = (await landing.rulesUsingLandingPool(poolId)).map((row) => Number(row.id));
      // 目标从池换成不绑：自动做的线路组退回普通转发
      const ruleRow = (await query('SELECT * FROM forward_rules WHERE id = 7'))[0];
      const leaveInput = { proxyNodeId: null, failoverEnabled: true, routeGroup: { mode: "weighted", lines: [{ key: "main", layers: [], dests: [] }] } };
      await target.applyLandingPoolTargetToRuleInput(leaveInput, { id: 1, role: "admin" }, { rule: ruleRow, hostId: 4, tunnelId: null, forwardGroupId: null });
      out.leave = [leaveInput.failoverEnabled, leaveInput.routeGroup];
      out.deleteGuard = await landing.assertLandingPoolUnused(poolId).then(() => "ok", (error) => String(error.message));

      // 去掉 H2：它的入站收掉，线路少一条
      await pools.updateNodePool(poolId, { hostIds: [1, 3] });
      await landing.syncLandingPool(poolId, { reason: "test" });
      out.afterRemove = (await query('SELECT "hostId" FROM proxy_inbounds WHERE "nodePoolId" = ? ORDER BY "hostId"', [poolId])).map((row) => Number(row.hostId));
      out.afterRemovePaths = JSON.parse((await query('SELECT "routePaths" FROM forward_rules WHERE id = 7'))[0].routePaths).map((p) => p.destHostId);

      // 分享给 tenant：每台都多一份凭据，tenant 有自己的池节点；主人自己的订阅里没有它
      const shared = await landing.ensureSharedLandingCredential(poolId, 2, "租户");
      out.shareNode = !!shared && shared.nodeId !== poolNodeId;
      out.perMemberUsers = (await query('SELECT "inboundId", COUNT(*) AS n FROM proxy_inbound_users WHERE "inboundId" IN (SELECT id FROM proxy_inbounds WHERE "nodePoolId" = ?) GROUP BY "inboundId"', [poolId])).map((row) => Number(row.n));
      out.ownerSees = (await db.getProxyNodesForSubscription(1)).filter((node) => Number(node.nodePoolId) === poolId).length;
      out.released = await landing.releaseSharedLandingCredential(poolId, 2);
      out.afterRelease = (await landing.getLandingPoolNodes(poolId)).length;

      // 换密钥：每台一起换
      const before = (await query('SELECT "realityPublicKey" FROM proxy_inbounds WHERE "nodePoolId" = ?', [poolId]))[0].realityPublicKey;
      await landing.rotateLandingPoolCredentials(poolId);
      const after = await query('SELECT "realityPublicKey" FROM proxy_inbounds WHERE "nodePoolId" = ?', [poolId]);
      out.rotated = after.every((row) => row.realityPublicKey && row.realityPublicKey !== before) && new Set(after.map((row) => row.realityPublicKey)).size === 1;

      // 改回中转：入站和池节点都收掉
      await exec('UPDATE forward_rules SET "proxyNodeId" = NULL, "routePaths" = NULL, "failoverEnabled" = 0 WHERE id = 7');
      await pools.updateNodePool(poolId, { role: "relay", landingJson: null });
      await landing.syncLandingPool(poolId, { reason: "test" });
      out.retired = [Number((await query('SELECT COUNT(*) AS n FROM proxy_inbounds WHERE "nodePoolId" = ?', [poolId]))[0].n), (await landing.getLandingPoolNodes(poolId)).length];
      console.log("RESULT " + JSON.stringify(out));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "landing.db"), FORWARDX_LOG_DIR: directory },
      timeout: 180000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split("\n").find((row) => row.startsWith("RESULT "));
    assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
    const out = JSON.parse(line.slice("RESULT ".length));
    assert.deepEqual(out.first.map((row: any[]) => [row[0], row[1] === 443, row[2], row[3]]), [[1, true, false, null], [2, true, false, null], [3, false, true, null]], "H3 的 443 被占，换了端口");
    assert.deepEqual(out.memberHosts, [1, 2, 3]);
    assert.equal(out.sameKeys, true, "每台的 REALITY 密钥一样");
    assert.equal(out.sameUuid, true, "每台的用户凭据一样");
    assert.equal(out.derivedPerMember, 0, "成员入站不各派生节点");
    assert.deepEqual(out.poolNodes, [["203.0.113.1", 443, false]], "订阅里一条池节点；没设域名不出直连");
    assert.deepEqual(out.agentH1, [[443, 1]]);
    assert.match(out.memberEdit, /落地池/);
    assert.deepEqual(out.withDomain, [[1, 443, null], [2, 443, null], [3, 0, "error"]], "开了域名直连，H3 换不了端口就不开");
    assert.equal(out.dnsError, "has", "DDNS 没配，写不了解析要报出来");
    assert.deepEqual(out.domainNode, [["hk.example.com", true]], "池节点地址是域名，直连进订阅");
    assert.equal(out.converted, true);
    assert.equal(out.ruleGroup[0], true);
    assert.equal(out.ruleGroup[1], "weighted", "目标是落地池：按负载在几台里分");
    assert.deepEqual(out.ruleGroup[2].map((row: any[]) => [row[0], row[1]]), [[true, 1], [true, 2], [true, 3]], "一台一条路径");
    assert.deepEqual(out.using, [7]);
    assert.deepEqual(out.leave, [false, null], "目标不再是池：自动做的线路组退回普通转发");
    assert.match(out.deleteGuard, /还有 1 条转发/);
    assert.deepEqual(out.afterRemove, [1, 3]);
    assert.deepEqual(out.afterRemovePaths.sort(), [1, 3], "去掉一台，线路跟着少一条");
    assert.equal(out.shareNode, true);
    assert.deepEqual(out.perMemberUsers, [2, 2], "每台都多一份分享的凭据");
    assert.equal(out.ownerSees, 1, "分享发的那份不进主人自己的订阅");
    assert.equal(out.released, true);
    assert.equal(out.afterRelease, 1);
    assert.equal(out.rotated, true, "换密钥每台一起换");
    assert.deepEqual(out.retired, [0, 0]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
