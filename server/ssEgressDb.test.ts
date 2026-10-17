import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Shadowsocks 出口落到库里、接口、心跳上的那几条规矩：
 *   - 保存规则时：来源（落地入站 / 外部链接）、方法、自环、落地在线、规则形态、UDP 一致性；
 *     外部链接加密保存；出口规则不自动绑订阅；
 *   - 落地入站：被当作出口时不能删（报错列出规则）、不能改成别的协议 / 不支持的方法；
 *   - 心跳：Agent ≥ 2.2.226 时 gost.json 里有出口链、服务挂着它；更旧的 Agent 上这条规则不下发。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ss-egress-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import http from "node:http";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const db = await import(url("server/db.ts"));
      const egress = await import(url("server/ssEgress.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);
      const now = Math.floor(Date.now() / 1000);

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'bob', 'hash', 'user')");
      const addHost = (id, name, ip, version, token, owner = 1) => exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [id, name, ip, ip, "slave", token, owner, now, version],
      );
      await addHost(10, "香港入口", "203.0.113.10", "2.2.226", "tok10");
      await addHost(20, "东京落地", "203.0.113.20", "2.2.226", "tok20");
      await addHost(30, "老入口", "203.0.113.30", "2.2.225", "tok30");

      const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
      const makeInbound = async (overrides = {}) => {
        const row = { userId: 1, hostId: 20, name: "落地出口 SS", protocol: "shadowsocks", port: 28388, transport: "tcp", security: "none", method: "aes-256-gcm", password: "landing-pass", isEnabled: true, landingEgress: true, ...overrides };
        const id = Number(await inbounds.createProxyInbound(row));
        await inbounds.syncProxyNodeFromInbound(id);
        return id;
      };

      const ctxFor = (user) => ({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { accountEnabled: true, ...user },
        authSession: null,
        authFailureReason: null,
      });
      const admin = { id: 1, username: "admin", role: "admin" };
      const { rulesRouter } = await import(url("server/routers/rules.ts"));
      const { proxyInboundsRouter } = await import(url("server/routers/proxyInbounds.ts"));
      const rules = rulesRouter.createCaller(ctxFor(admin));
      const inboundApi = proxyInboundsRouter.createCaller(ctxFor(admin));
      const ruleRow = async (id) => (await query("SELECT * FROM forward_rules WHERE id = ?", [id]))[0];
      let nextPort = 21000;
      const directRule = (overrides = {}) => ({
        hostId: 10, forwardType: "gost", protocol: "tcp", sourcePort: nextPort++, targetIp: "198.51.100.7", targetPort: 443,
        ...overrides,
      });
      const b64url = (text) => Buffer.from(text, "utf8").toString("base64url");

      const heartbeat = async (token, agentVersion) => {
        const express = (await import("express")).default;
        const route = await import(url("server/agentHeartbeatRoute.ts"));
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          const authorization = String(req.headers.authorization || "");
          req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
          next();
        });
        route.registerAgentHeartbeatRoute(app);
        // 每次都要一份完整的计算结果：库是测试直接改的，没有经过会作废缓存的那些路径。
        const gate = await import(url("server/agentHeartbeatGate.ts"));
        for (const id of [10, 20, 30]) gate.agentStableHeartbeatPlanCache.invalidate(id);
        const server = http.createServer(app);
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        try {
          const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + token },
            body: JSON.stringify({ agentVersion, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
          });
          const body = await response.json();
          if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
          let gost = null;
          for (const action of (body.desiredState && body.desiredState.actions) || []) {
            for (const config of (action.managedConfigs || [])) {
              if (String(config.path || "").endsWith("/gost.json")) gost = JSON.parse(Buffer.from(config.contentBase64, "base64").toString("utf8"));
            }
          }
          return { body, gost: gost || { services: [], chains: [], limiters: [] } };
        } finally {
          server.close();
        }
      };

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "egress.db") },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("保存规则：落地主机出口的来源、方法、自环、在线、形态、UDP 一致性", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    const ss2022 = await makeInbound({ name: "2022", port: 28389, method: "2022-blake3-aes-128-gcm", password: Buffer.alloc(16, 3).toString("base64") });
    const vless = await makeInbound({ name: "v", port: 28390, protocol: "vless", method: null, password: null, uuid: "11111111-2222-3333-4444-555555555555" });

    const created = await rules.create(directRule({ egressType: "ss_host", egressInboundId: inboundId }));
    const row = await ruleRow(created.id);
    assert.equal(row.egressType, "ss_host");
    assert.equal(Number(row.egressInboundId), inboundId);
    assert.equal(row.egressConfigJson, null);

    // realm 也能开出口：库里仍是 realm，下发时换成 gost（见下面的心跳断言）。
    const realmRule = await rules.create(directRule({ forwardType: "realm", sourcePort: 22999, egressType: "ss_host", egressInboundId: inboundId }));
    assert.equal((await ruleRow(realmRule.id)).forwardType, "realm");
    const realmBeat = await heartbeat("tok10", "2.2.226");
    const realmService = realmBeat.gost.services.find((item) => item.name === "fwx-" + realmRule.id + "-tcp");
    assert.ok(realmService, "realm 规则开了出口要生成 gost 服务");
    assert.equal(realmService.handler.chain, "chain-egress-" + realmRule.id + "-tcp");
    // 不能同时再起一个 realm 抢同一个端口。
    assert.doesNotMatch(JSON.stringify(realmBeat.body), /forwardx-realm-(tcp-|udp-)?22999\b/);
    await rules.delete({ id: realmRule.id });
    await assert.rejects(rules.create(directRule({ protocol: "both", egressType: "ss_host", egressInboundId: inboundId })), /UDP/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_host", egressInboundId: inboundId, egressUdp: true })), /UDP/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_host", egressInboundId: ss2022 })), /SS2022/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_host", egressInboundId: vless })), /不是 Shadowsocks/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_host" })), /请选择/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_host", egressInboundId: 9999 })), /不存在/);
    // 自环：落地主机就是规则的入口主机。
    await assert.rejects(rules.create(directRule({ hostId: 20, egressType: "ss_host", egressInboundId: inboundId })), /入口主机自己/);
    // 新选落地时它必须在线。
    await exec('UPDATE hosts SET "isOnline" = 0 WHERE id = 20');
    await assert.rejects(rules.create(directRule({ egressType: "ss_host", egressInboundId: inboundId })), /离线/);
    // 已经挂着的规则改个名字，不因为落地临时掉线被卡住。
    await rules.update({ id: created.id, name: "改个名字", egressType: "ss_host", egressInboundId: inboundId });
    await exec('UPDATE hosts SET "isOnline" = 1 WHERE id = 20');
    // 停用的入站不能选。
    await exec('UPDATE proxy_inbounds SET "isEnabled" = 0 WHERE id = ?', [inboundId]);
    await assert.rejects(rules.create(directRule({ egressType: "ss_host", egressInboundId: inboundId })), /已停用/);
    await exec('UPDATE proxy_inbounds SET "isEnabled" = 1 WHERE id = ?', [inboundId]);

    // 带着出口的规则可以改成 realm（下发时仍是 gost）；挂隧道仍要先把出口改回直接连接。
    await rules.update({ id: created.id, forwardType: "realm" });
    assert.equal((await ruleRow(created.id)).forwardType, "realm");
    await rules.update({ id: created.id, forwardType: "gost" });
    // 改回直接连接：几列清掉，之后可以随便改。
    await rules.update({ id: created.id, egressType: "none" });
    const cleared = await ruleRow(created.id);
    assert.equal(cleared.egressType, "none");
    assert.equal(cleared.egressInboundId, null);
    // 再挂回来。
    await rules.update({ id: created.id, egressType: "ss_host", egressInboundId: inboundId });
    assert.equal((await ruleRow(created.id)).egressType, "ss_host");
  `);
});

test("外部 ss:// 链接：解析、校验 gost 支持的方法、加密保存、编辑时不改就保留", () => {
  runInDatabase(String.raw`
    const link = "ss://" + b64url("chacha20-ietf-poly1305:ext-secret") + "@198.51.100.50:8443#ext";
    const created = await rules.create(directRule({ egressType: "ss_link", egressLink: link }));
    const row = await ruleRow(created.id);
    assert.equal(row.egressType, "ss_link");
    assert.match(row.egressConfigJson, /^enc:v1:/);
    assert.equal(row.egressConfigJson.includes("ext-secret"), false);
    assert.deepEqual(egress.decryptSsEgressEndpoint(row.egressConfigJson), { server: "198.51.100.50", port: 8443, method: "chacha20-ietf-poly1305", password: "ext-secret", name: "ext" });

    // 列表里不出密文，只出打码的样子和状态。
    const listed = (await rules.list()).find((item) => item.id === created.id);
    assert.equal("egressConfigJson" in listed, false);
    assert.equal(listed.egress.masked, "ss://chacha20-ietf-poly1305:******@198.51.100.50:8443");
    assert.equal(listed.egress.state, "running");
    assert.equal(JSON.stringify(listed).includes("ext-secret"), false);

    // 编辑时不传链接 / 传回打码的那条：保留原来的密文。
    await rules.update({ id: created.id, name: "x", egressType: "ss_link" });
    assert.equal((await ruleRow(created.id)).egressConfigJson, row.egressConfigJson);
    await rules.update({ id: created.id, egressType: "ss_link", egressLink: listed.egress.masked });
    assert.equal((await ruleRow(created.id)).egressConfigJson, row.egressConfigJson);

    await assert.rejects(rules.create(directRule({ egressType: "ss_link", egressLink: "ss://" + b64url("2022-blake3-aes-256-gcm:" + Buffer.alloc(32, 1).toString("base64")) + "@198.51.100.50:1" })), /SS2022/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_link", egressLink: "ss://" + b64url("aes-256-gcm:k") + "@198.51.100.50:1/?plugin=v2ray-plugin" })), /插件/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_link", egressLink: "ss://" + b64url("aes-256-gcm:k") + "@203.0.113.10:1" })), /入口主机自己/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_link" })), /请粘贴/);
    // 共享 TLS 入站上的规则不能带出口。
    await assert.rejects(rules.create(directRule({ tlsInboundId: 1, sniNames: "a.example.com", egressType: "ss_link", egressLink: link })), /共享 TLS 入站/);
  `);
});

test("出口规则不自动绑订阅，同目标的普通规则照旧自动绑", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound({ landingEgress: false });
    const node = (await query('SELECT id, address, port FROM proxy_nodes WHERE "inboundId" = ?', [inboundId]))[0];
    assert.ok(node, "落地入站该派生出节点");
    // 普通规则：目标正好是落地节点 → 自动绑上（对照组）。
    const plain = await rules.create(directRule({ targetIp: node.address, targetPort: Number(node.port) }));
    assert.equal(Number((await ruleRow(plain.id)).proxyNodeId), Number(node.id));
    // 出口规则：目标同样是这个地址（例如想经别的落地出口访问它），也不绑。
    const viaEgress = await rules.create(directRule({
      targetIp: node.address, targetPort: Number(node.port),
      egressType: "ss_link", egressLink: "ss://" + b64url("aes-256-gcm:k") + "@198.51.100.60:8388",
    }));
    assert.equal((await ruleRow(viaEgress.id)).proxyNodeId, null);
    assert.equal(viaEgress.autoBoundProxyNodeId, null);
  `);
});

test("一键创建的落地出口入站：派生节点默认不进订阅；普通落地节点照旧进", () => {
  runInDatabase(String.raw`
    const created = await inboundApi.createLandingEgress({ hostId: 20 });
    const row = (await query("SELECT * FROM proxy_inbounds WHERE id = ?", [created.id]))[0];
    assert.equal(row.protocol, "shadowsocks");
    assert.equal(row.method, "aes-256-gcm");
    assert.ok(row.password && row.password.length >= 8);
    assert.equal(Number(row.landingEgress), 1);
    assert.ok(Number(row.port) >= 20000 && Number(row.port) <= 30000);
    const derived = (await query('SELECT "includeDirect" FROM proxy_nodes WHERE "inboundId" = ?', [created.id]))[0];
    assert.equal(Number(derived.includeDirect), 0);
    const normal = await makeInbound({ name: "普通", port: 28400, landingEgress: false });
    assert.equal(Number((await query('SELECT "includeDirect" FROM proxy_nodes WHERE "inboundId" = ?', [normal]))[0].includeDirect), 1);
    // 编辑器的清单里能看到它，入口主机自己不会被当成落地（由界面过滤，服务端保存时再拦）。
    const options = await inboundApi.egressLandingOptions();
    const tokyo = options.find((host) => host.hostId === 20);
    assert.ok(tokyo.inbounds.some((inbound) => inbound.id === created.id && inbound.methodError === null));
  `);
});

test("落地入站被当作出口时：不能删（列出规则）、不能改协议 / 改成不支持的方法；轮换密码照常", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    const created = await rules.create(directRule({ name: "经东京出口", egressType: "ss_host", egressInboundId: inboundId }));
    await assert.rejects(inboundApi.delete({ id: inboundId }), /1 条转发规则.*「经东京出口」/);
    await assert.rejects(inboundApi.update({ id: inboundId, method: "2022-blake3-aes-128-gcm" }), /不能改成 2022-blake3-aes-128-gcm/);
    await assert.rejects(inboundApi.update({ id: inboundId, protocol: "vless" }), /不能改成别的协议/);
    // 改名、改成另一个支持的方法都行。
    await inboundApi.update({ id: inboundId, name: "东京 SS" });
    await inboundApi.update({ id: inboundId, method: "aes-128-gcm" });
    // 轮换：规则不用改，下一次下发就是新密码。
    const before = (await query("SELECT password FROM proxy_inbounds WHERE id = ?", [inboundId]))[0].password;
    await inboundApi.rotate({ id: inboundId });
    const after = (await query("SELECT password FROM proxy_inbounds WHERE id = ?", [inboundId]))[0].password;
    assert.notEqual(after, before);
    const { gost } = await heartbeat("tok10", "2.2.226");
    const chain = gost.chains.find((item) => item.name === "chain-egress-" + created.id + "-tcp");
    assert.equal(chain.hops[0].nodes[0].connector.auth.password, after);
    assert.equal(chain.hops[0].nodes[0].connector.auth.username, "aes-128-gcm");
    // 规则改回直接连接之后可以删。
    await rules.update({ id: created.id, egressType: "none" });
    await inboundApi.delete({ id: inboundId });
  `);
});

test("心跳：≥ 2.2.226 的 Agent 拿到出口链；更旧的 Agent 上出口规则不下发；落地入站没了按停用", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    const viaHost = await rules.create(directRule({ egressType: "ss_host", egressInboundId: inboundId }));
    const viaLink = await rules.create(directRule({ egressType: "ss_link", egressLink: "ss://" + b64url("aes-128-gcm:ext") + "@198.51.100.50:8443" }));
    const plain = await rules.create(directRule({ protocol: "both" }));

    const { gost } = await heartbeat("tok10", "2.2.226");
    const service = (name) => gost.services.find((item) => item.name === name);
    const hostService = service("fwx-" + viaHost.id + "-tcp");
    assert.ok(hostService, "出口规则要生成 gost 服务");
    assert.equal(hostService.handler.chain, "chain-egress-" + viaHost.id + "-tcp");
    // forwarder 仍是最终目标：落地替我们连它。
    assert.equal(hostService.forwarder.nodes[0].addr, "198.51.100.7:443");
    assert.equal(service("fwx-" + viaHost.id + "-udp"), undefined, "UDP 不走出口，也不能直连漏出去");
    const chain = gost.chains.find((item) => item.name === hostService.handler.chain);
    assert.deepEqual(chain.hops[0].nodes[0], {
      name: "egress-" + viaHost.id + "-tcp",
      addr: "203.0.113.20:28388",
      connector: { type: "ss", auth: { username: "aes-256-gcm", password: "landing-pass" }, metadata: { nodelay: true } },
      dialer: { type: "tcp" },
    });
    const linkChain = gost.chains.find((item) => item.name === "chain-egress-" + viaLink.id + "-tcp");
    assert.equal(linkChain.hops[0].nodes[0].addr, "198.51.100.50:8443");
    assert.equal(linkChain.hops[0].nodes[0].connector.auth.username, "aes-128-gcm");
    // 普通规则不挂链。
    assert.equal(service("fwx-" + plain.id + "-tcp").handler.chain, undefined);
    assert.equal(service("fwx-" + plain.id + "-udp").handler.chain, undefined);

    // 旧 Agent（2.2.225）上的出口规则：不下发（不是退回直连），同机的普通规则照旧。保存时就会拦，这里直接写库模拟
    //「规则建好之后主机被重装成了旧 Agent」。
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "egressType", "egressInboundId") VALUES (900, 30, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
      ["老机出口", "gost", "tcp", 22900, "198.51.100.7", 443, "ss_host", inboundId],
    );
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled") VALUES (901, 30, ?, ?, ?, ?, ?, ?, 1, 1)',
      ["老机普通", "gost", "tcp", 22901, "198.51.100.7", 443],
    );
    const old = await heartbeat("tok30", "2.2.225");
    assert.equal(old.gost.services.some((item) => item.name.startsWith("fwx-900-")), false);
    assert.equal(old.gost.chains.some((item) => item.name.startsWith("chain-egress-")), false);
    assert.ok(old.gost.services.some((item) => item.name === "fwx-901-tcp"), "同机的普通规则照旧下发");
    // 规则卡片上的状态。
    const listedOld = (await rules.list()).find((item) => item.id === 900);
    assert.equal(listedOld.egress.state, "agent_upgrade");
    assert.equal(listedOld.egress.landingHostName, "东京落地");
    // 保存时就拦：旧 Agent 的主机上不能新挂出口。
    await assert.rejects(rules.create(directRule({ hostId: 30, egressType: "ss_host", egressInboundId: inboundId })), /需要升级到 2\.2\.226/);

    // 落地离线：卡片标「落地离线」（照样下发 —— 运行视图那一层见 ssEgress.test.ts）。
    // 同一台主机第二次心跳会先要 Agent 的本地状态、不给完整配置，所以这里不再拿心跳比对。
    await exec('UPDATE hosts SET "isOnline" = 0 WHERE id = 20');
    assert.equal((await rules.list()).find((item) => item.id === viaHost.id).egress.state, "landing_offline");
    await exec('UPDATE hosts SET "isOnline" = 1 WHERE id = 20');
    assert.equal((await rules.list()).find((item) => item.id === viaHost.id).egress.state, "running");

    // 入站被（绕过保护）删掉：卡片标「落地入站已删除」，下发按停用（同见 ssEgress.test.ts）。
    await exec("DELETE FROM proxy_inbounds WHERE id = ?", [inboundId]);
    assert.equal((await rules.list()).find((item) => item.id === viaHost.id).egress.state, "inbound_missing");
  `);
});

test("端口转发资源（gost）上的规则：出口照抄到每台入口的子规则，心跳给子规则挂链；realm 资源的子规则换成 gost 跑", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    const { forwardGroupsRouter } = await import(url("server/routers/forwardGroups.ts"));
    const groups = forwardGroupsRouter.createCaller(ctxFor(admin));
    const gostGroup = await groups.create({ name: "香港 gost", groupMode: "port", groupType: "host", forwardType: "gost", protocol: "tcp", members: [{ memberType: "host", hostId: 10 }] });
    const realmGroup = await groups.create({ name: "香港 realm", groupMode: "port", groupType: "host", forwardType: "realm", protocol: "tcp", members: [{ memberType: "host", hostId: 10 }] });
    const template = await rules.create({ forwardGroupId: gostGroup.id, forwardType: "gost", protocol: "tcp", sourcePort: 23001, targetIp: "198.51.100.7", targetPort: 443, egressType: "ss_host", egressInboundId: inboundId });
    const children = await query('SELECT id, "hostId", "egressType", "egressInboundId" FROM forward_rules WHERE "forwardGroupRuleId" = ?', [template.id]);
    assert.equal(children.length, 1);
    assert.equal(children[0].egressType, "ss_host");
    assert.equal(Number(children[0].egressInboundId), inboundId);
    // realm 资源上的规则也能开出口，子规则下发时换成 gost。
    const realmTemplate = await rules.create({ forwardGroupId: realmGroup.id, forwardType: "realm", protocol: "tcp", sourcePort: 23002, targetIp: "198.51.100.7", targetPort: 443, egressType: "ss_host", egressInboundId: inboundId });
    const realmChildren = await query('SELECT id, "forwardType" FROM forward_rules WHERE "forwardGroupRuleId" = ?', [realmTemplate.id]);
    assert.equal(realmChildren.length, 1);
    assert.equal(realmChildren[0].forwardType, "realm");
    // 落地主机是资源里的入口：自环。
    const tokyoGroup = await groups.create({ name: "东京 gost", groupMode: "port", groupType: "host", forwardType: "gost", protocol: "tcp", members: [{ memberType: "host", hostId: 20 }] });
    await assert.rejects(rules.create({ forwardGroupId: tokyoGroup.id, forwardType: "gost", protocol: "tcp", sourcePort: 23003, targetIp: "198.51.100.7", targetPort: 443, egressType: "ss_host", egressInboundId: inboundId }), /入口主机自己/);

    const { gost } = await heartbeat("tok10", "2.2.226");
    const childId = Number(children[0].id);
    const childService = gost.services.find((item) => item.name === "fwx-" + childId + "-tcp");
    assert.ok(childService, "子规则要生成 gost 服务");
    assert.equal(childService.handler.chain, "chain-egress-" + childId + "-tcp");
    assert.ok(gost.chains.some((item) => item.name === "chain-egress-" + childId + "-tcp"));
    const realmChildId = Number(realmChildren[0].id);
    assert.ok(gost.services.some((item) => item.name === "fwx-" + realmChildId + "-tcp" && item.handler.chain === "chain-egress-" + realmChildId + "-tcp"), "realm 资源的子规则要换成 gost 服务挂出口链");

    // 模板改回直接连接：子规则跟着清掉。
    await rules.update({ id: template.id, egressType: "none" });
    const after = await query('SELECT "egressType" FROM forward_rules WHERE "forwardGroupRuleId" = ? AND "pendingDelete" = 0', [template.id]);
    assert.ok(after.length >= 1);
    assert.ok(after.every((row) => row.egressType === "none"));
    // 列表上模板的状态（入口是资源里的主机）。
    await rules.update({ id: template.id, egressType: "ss_host", egressInboundId: inboundId });
    const listed = (await rules.list({ scope: "all" })).find((item) => item.id === template.id);
    assert.equal(listed.egress.state, "running");
  `);
});

test("删落地主机：别的主机上的规则还拿它的入站当出口就不让删；解锁记录跟着主机删", () => {
  runInDatabase(String.raw`
    const hostRepo = await import(url("server/repositories/hostRepository.ts"));
    const inboundId = await makeInbound();
    const created = await rules.create(directRule({ name: "经东京出口", egressType: "ss_host", egressInboundId: inboundId }));
    // 东京落地（20）上的入站被香港入口（10）的规则当出口：删 20 要先解除
    const labels = await hostRepo.getHostDeleteReferenceLabels(20);
    assert.ok(labels.some((label) => /Shadowsocks 出口/.test(label) && /「经东京出口」/.test(label)), JSON.stringify(labels));
    // 入口机自己的规则跟着主机一起删，不算引用
    assert.deepEqual((await hostRepo.getHostDeleteReferenceLabels(10)).filter((label) => /Shadowsocks/.test(label)), []);
    await rules.update({ id: created.id, egressType: "none" });
    assert.deepEqual((await hostRepo.getHostDeleteReferenceLabels(20)).filter((label) => /Shadowsocks/.test(label)), []);

    // 解锁检测记录：删主机时一起删（表没外键）
    await exec("INSERT INTO host_unlock_checks (\"hostId\", family, \"runId\", \"resultsJson\") VALUES (30, 'auto', 'run-delete-me', '[]')");
    await exec("INSERT INTO host_unlock_checks (\"hostId\", family, \"runId\", \"resultsJson\") VALUES (10, 'auto', 'run-keep-me', '[]')");
    await hostRepo.deleteHost(30);
    assert.equal(Number((await query("SELECT COUNT(*) AS c FROM host_unlock_checks WHERE \"hostId\" = 30"))[0].c), 0);
    assert.equal(Number((await query("SELECT COUNT(*) AS c FROM host_unlock_checks WHERE \"hostId\" = 10"))[0].c), 1);
  `);
});

test("UDP / SS2022 出口：只有报了能力的入口机能保存、能拿到 ssu 链；失去能力后按停用下发，卡片写明要升级", () => {
  runInDatabase(String.raw`
    const caps = JSON.stringify(["ssEgress2022", "ssEgressUdp"]);
    const setCaps = (id, version, value, runtimeVersion) => exec('UPDATE hosts SET "agentVersion" = ?, "agentCapabilities" = ?, "runtimeVersion" = ? WHERE id = ?', [version, value, runtimeVersion, id]);
    const inboundId = await makeInbound();
    const key = Buffer.alloc(16, 6).toString("base64");
    const ss2022 = await makeInbound({ name: "2022", port: 28389, method: "2022-blake3-aes-128-gcm", password: key });

    // 入口机 2.2.226、没报能力：UDP 出口、SS2022 出口都存不进去，经典 AEAD 的 TCP 照旧能存。
    await assert.rejects(rules.create(directRule({ protocol: "both", egressType: "ss_host", egressInboundId: inboundId, egressUdp: true })), /香港入口.*UDP.*2\.2\.227.*3\.2\.6-nex3/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_host", egressInboundId: ss2022 })), /SS2022/);
    await assert.rejects(rules.create(directRule({ egressType: "ss_link", egressLink: "ss://" + b64url("2022-blake3-aes-128-gcm:" + key) + "@198.51.100.50:8443" })), /SS2022/);
    await rules.create(directRule({ egressType: "ss_host", egressInboundId: inboundId }));
    // 新 Agent 但运行时还是 nex2：一样不行。
    await setCaps(10, "2.2.227", "[]", "3.2.6-nex2");
    await assert.rejects(rules.create(directRule({ protocol: "udp", egressType: "ss_host", egressInboundId: inboundId, egressUdp: true })), /运行时 3\.2\.6-nex2/);

    // 报了能力：都能存；心跳给 TCP 一条 ss 链、UDP 一条 ssu 链。
    await setCaps(10, "2.2.227", caps, "3.2.6-nex3");
    const udpRule = await rules.create(directRule({ protocol: "both", egressType: "ss_host", egressInboundId: inboundId, egressUdp: true }));
    const viaSs2022 = await rules.create(directRule({ protocol: "both", egressType: "ss_host", egressInboundId: ss2022, egressUdp: true }));
    const { gost } = await heartbeat("tok10", "2.2.227");
    const chainOf = (id, proto) => gost.chains.find((item) => item.name === "chain-egress-" + id + "-" + proto);
    assert.equal(gost.services.find((item) => item.name === "fwx-" + udpRule.id + "-udp").handler.chain, "chain-egress-" + udpRule.id + "-udp");
    assert.deepEqual(chainOf(udpRule.id, "udp").hops[0].nodes[0].connector, { type: "ssu", auth: { username: "aes-256-gcm", password: "landing-pass" }, metadata: { udpBufferSize: 65535 } });
    assert.deepEqual(chainOf(udpRule.id, "udp").hops[0].nodes[0].dialer, { type: "udp" });
    assert.equal(chainOf(viaSs2022.id, "tcp").hops[0].nodes[0].connector.auth.username, "2022-blake3-aes-128-gcm");
    assert.equal(chainOf(viaSs2022.id, "udp").hops[0].nodes[0].connector.auth.password, key);
    const listed = (await rules.list()).find((item) => item.id === udpRule.id);
    assert.equal(listed.egress.state, "running");
    assert.equal(listed.egress.udp, true);

    // 编辑器问能力。
    const capability = await inboundApi.egressEntryCapabilities({ hostIds: [10, 30] });
    assert.deepEqual(capability.map((row) => [row.hostId, row.udp, row.ss2022]), [[10, true, true], [30, false, false]]);
    assert.match(capability[1].udpMessage, /老入口.*2\.2\.227/);

    // 普通用户问自己看不到、也不在自己能用的端口转发资源里的主机：当成不存在来回答（和不存在的主机 99 一样），
    // 不能借此探出主机在不在、Agent 新不新。授权以后、或者主机在他能用的资源里，才回真实能力。
    const bob = { id: 2, username: "bob", role: "user" };
    const bobApi = proxyInboundsRouter.createCaller(ctxFor(bob));
    const shape = (rows) => rows.map((row) => [row.hostId, row.udp, row.ss2022, row.name, row.agentVersion, row.udpMessage]);
    const foreign = await bobApi.egressEntryCapabilities({ hostIds: [10, 99] });
    assert.deepEqual(shape(foreign)[0].slice(1), shape(foreign)[1].slice(1));
    assert.equal(foreign[0].udp, false);
    const { forwardGroupsRouter } = await import(url("server/routers/forwardGroups.ts"));
    const group = await forwardGroupsRouter.createCaller(ctxFor(admin)).create({ name: "香港 gost 资源", groupMode: "port", groupType: "host", forwardType: "gost", protocol: "tcp", members: [{ memberType: "host", hostId: 10 }] });
    await exec('INSERT INTO user_forward_group_permissions ("userId", "forwardGroupId") VALUES (?, ?)', [2, group.id]);
    const viaGroup = await bobApi.egressEntryCapabilities({ hostIds: [10] });
    assert.deepEqual([viaGroup[0].udp, viaGroup[0].ss2022, viaGroup[0].name, viaGroup[0].agentVersion], [true, true, null, null]);
    await exec('DELETE FROM user_forward_group_permissions WHERE "userId" = ?', [2]);
    await exec('INSERT INTO user_host_permissions ("userId", "hostId") VALUES (?, ?)', [2, 10]);
    const granted = await bobApi.egressEntryCapabilities({ hostIds: [10] });
    assert.deepEqual([granted[0].udp, granted[0].name], [true, "香港入口"]);

    // 被当作 SS2022 出口的入站：入口机有能力时可以改成 SS2022，没有就拒绝。
    await setCaps(10, "2.2.226", caps, "3.2.6-nex3");
    await assert.rejects(inboundApi.update({ id: inboundId, method: "2022-blake3-aes-256-gcm" }), /不能改成 2022-blake3-aes-256-gcm.*SS2022/);

    // 失去能力（运行时回滚，Agent 这次心跳报了空能力）：心跳当场按新能力重算，UDP / SS2022 规则不下发，
    // 只走 TCP 的经典规则照旧；卡片写明要升级，不再显示「含 UDP」。
    await setCaps(10, "2.2.227", caps, "3.2.6-nex3");
    const gate = await import(url("server/agentHeartbeatGate.ts"));
    gate.agentStableHeartbeatPlanCache.invalidate(10);
    const express = (await import("express")).default;
    const route = await import(url("server/agentHeartbeatRoute.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.agentToken = "tok10"; next(); });
    route.registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentVersion: "2.2.227", runtimeVersion: "3.2.6-nex2", agentCapabilities: [], forceReconcile: true, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
    });
    server.close();
    assert.equal(response.status, 200, await response.text());
    const stored = (await query('SELECT "agentCapabilities", "runtimeVersion" FROM hosts WHERE id = 10'))[0];
    assert.equal(stored.agentCapabilities, "[]");
    assert.equal(stored.runtimeVersion, "3.2.6-nex2");
    const afterRollback = await rules.list();
    const lost = afterRollback.find((item) => item.id === udpRule.id);
    assert.equal(lost.egress.state, "udp_runtime_upgrade");
    assert.equal(lost.egress.udp, false);
    assert.match(lost.egress.message, /运行时 3\.2\.6-nex2/);
    assert.equal(afterRollback.find((item) => item.id === viaSs2022.id).egress.state, "ss2022_runtime_upgrade");
    // 下发：同一台机器第三次心跳只要本地状态、不给完整配置，换「老入口」（30，新 Agent、能力为空）看一份完整的 gost.json。
    await setCaps(30, "2.2.227", "[]", "3.2.6-nex2");
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "egressType", "egressInboundId", "egressUdp") VALUES (910, 30, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1)',
      ["回滚后的 UDP 出口", "gost", "both", 22910, "198.51.100.7", 443, "ss_host", inboundId],
    );
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "egressType", "egressInboundId", "egressUdp") VALUES (911, 30, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 0)',
      ["经典 TCP 出口", "gost", "tcp", 22911, "198.51.100.7", 443, "ss_host", inboundId],
    );
    const { gost: degraded } = await heartbeat("tok30", "2.2.227");
    assert.equal(degraded.services.some((item) => item.name.startsWith("fwx-910-")), false, "UDP 出口规则整条不下发，UDP 不会直连");
    assert.equal(degraded.chains.some((item) => item.hops[0].nodes[0].connector.type === "ssu"), false);
    assert.ok(degraded.services.some((item) => item.name === "fwx-911-tcp"), "经典 AEAD 的 TCP 出口照旧");
    assert.ok(degraded.chains.some((item) => item.name === "chain-egress-911-tcp"));
  `);
});
