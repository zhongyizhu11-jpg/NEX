import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * VLESS Reality 出口落到库里、接口、心跳上的那几条规矩（Shadowsocks 那份见 ssEgressDb.test.ts，同一个测试架子）：
 *   - 保存：落地入站要是 VLESS + RAW/TCP + REALITY + Vision；外部链接严格解析、加密保存；只转 TCP；
 *     入口机 Agent 低于 2.2.253 时不能新挂；
 *   - 心跳：2.2.253 起的 Agent 拿到 gost 的本机 socks5 链 + 单独一份 sing-box 桥接配置，两边的端口和凭据对得上；
 *     旧 Agent 上这种规则按停用下发，也不发桥接；
 *   - 落地入站被当作 VLESS 出口时不能删、不能改成别的传输。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-vless-egress-"));
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
      await addHost(10, "香港入口", "203.0.113.10", "2.2.253", "tok10");
      await addHost(20, "东京落地", "203.0.113.20", "2.2.226", "tok20");
      await addHost(30, "老入口", "203.0.113.30", "2.2.252", "tok30");

      const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
      const PBK = "TiSmUw53M68pgep1_Cc7AXzh1QpUzeBM74jRZbWHj3Q";
      const UUID = "0b9c2f7e-8a36-4a6e-9a51-3c2b1f2d4e5f";
      const makeInbound = async (overrides = {}) => {
        const row = {
          userId: 1, hostId: 20, name: "东京 REALITY", protocol: "vless", port: 443, transport: "tcp", security: "reality",
          flow: "xtls-rprx-vision", serverName: "dl.google.com", realityPrivateKey: "priv", realityPublicKey: PBK, realityShortId: "a1b2",
          isEnabled: true, ...overrides,
        };
        const id = Number(await inbounds.createProxyInbound(row));
        await inbounds.replaceProxyInboundUsers(id, [{ id: 0, name: "默认", uuid: UUID, password: "" }]);
        await inbounds.syncProxyNodeFromInbound(id);
        return id;
      };
      const vlessLink = "vless://" + UUID + "@198.51.100.50:8443?type=tcp&security=reality&flow=xtls-rprx-vision&sni=www.amd.com&fp=chrome&pbk=" + PBK + "&sid=c3d4#外部";

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
        for (const id of [10, 20, 30, 40, 41]) gate.agentStableHeartbeatPlanCache.invalidate(id);
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
          let bridge = null;
          let bridgeAction = null;
          for (const action of (body.desiredState && body.desiredState.actions) || []) {
            if (action.forwardType === "singbox-egress-runtime-sync") bridgeAction = action;
            for (const config of (action.managedConfigs || [])) {
              if (String(config.path || "").endsWith("/gost.json")) gost = JSON.parse(Buffer.from(config.contentBase64, "base64").toString("utf8"));
              if (String(config.path || "") === "/etc/forwardx/singbox/egress.json") bridge = { ...config, json: JSON.parse(Buffer.from(config.contentBase64, "base64").toString("utf8")) };
            }
          }
          return { body, gost: gost || { services: [], chains: [], limiters: [] }, bridge, bridgeAction };
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


test("保存：落地入站 / 外部链接两种来源，形态、Agent 版本、入站形态都在保存时拦", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    const viaHost = await rules.create(directRule({ egressType: "vless_host", egressInboundId: inboundId }));
    let row = await ruleRow(viaHost.id);
    assert.equal(row.egressType, "vless_host");
    assert.equal(Number(row.egressInboundId), inboundId);
    const viaLink = await rules.create(directRule({ egressType: "vless_link", egressLink: vlessLink }));
    row = await ruleRow(viaLink.id);
    assert.equal(row.egressType, "vless_link");
    assert.equal(String(row.egressConfigJson).includes(UUID), false, "UUID 加密保存");
    const listed = (await rules.list()).find((item) => item.id === viaLink.id);
    assert.equal(listed.egress.masked, "vless://******@198.51.100.50:8443?security=reality&sni=www.amd.com");
    assert.equal(listed.egress.state, "running");
    assert.equal("egressConfigJson" in listed, false);
    // 编辑时原样传回打码的那条：保留原来的密文。
    await rules.update({ id: viaLink.id, name: "改个名", egressType: "vless_link", egressLink: listed.egress.masked });
    assert.equal((await ruleRow(viaLink.id)).egressConfigJson, row.egressConfigJson);

    await assert.rejects(rules.create(directRule({ protocol: "both", egressType: "vless_host", egressInboundId: inboundId, egressUdp: true })), /只转发 TCP/);
    await assert.rejects(rules.create(directRule({ egressType: "vless_link", egressLink: vlessLink.replace("type=tcp", "type=ws") })), /RAW\/TCP/);
    await assert.rejects(rules.create(directRule({ hostId: 30, egressType: "vless_host", egressInboundId: inboundId })), /需要升级到 2\.2\.253/);
    const wsInbound = await makeInbound({ name: "东京 ws", port: 8443, transport: "ws" });
    await assert.rejects(rules.create(directRule({ egressType: "vless_host", egressInboundId: wsInbound })), /RAW\/TCP/);
    // 正被当作出口：不能删、不能改成 ws。
    await assert.rejects(inboundApi.delete({ id: inboundId }), /VLESS Reality 出口/);
    await assert.rejects(inboundApi.update({ id: inboundId, transport: "ws" }), /VLESS Reality 出口.*RAW\/TCP/);
    await inboundApi.update({ id: inboundId, name: "东京 REALITY 改名" });
  `);
});

test("心跳：2.2.253 起拿到本机 socks5 链和 sing-box 桥接；旧 Agent 上按停用下发、不发桥接", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    const viaHost = await rules.create(directRule({ egressType: "vless_host", egressInboundId: inboundId }));
    const viaLink = await rules.create(directRule({ egressType: "vless_link", egressLink: vlessLink }));
    const plain = await rules.create(directRule());

    const { gost, bridge, bridgeAction } = await heartbeat("tok10", "2.2.253");
    const service = (name) => gost.services.find((item) => item.name === name);
    const hostService = service("fwx-" + viaHost.id + "-tcp");
    assert.ok(hostService, "出口规则要生成 gost 服务");
    assert.equal(hostService.handler.chain, "chain-egress-" + viaHost.id + "-tcp");
    assert.equal(hostService.forwarder.nodes[0].addr, "198.51.100.7:443", "forwarder 仍是最终目标");
    assert.equal(service("fwx-" + viaHost.id + "-udp"), undefined);
    assert.equal(service("fwx-" + plain.id + "-tcp").handler.chain, undefined);
    const node = gost.chains.find((item) => item.name === hostService.handler.chain).hops[0].nodes[0];
    assert.equal(node.connector.type, "socks5");
    assert.deepEqual(node.connector.metadata, { notls: true });
    assert.match(node.addr, /^127\.0\.0\.1:\d+$/);

    assert.ok(bridgeAction, "要发桥接动作");
    assert.equal(bridge.serviceName, "forwardx-singbox-egress");
    assert.equal(bridge.mode, 0o600);
    const config = bridge.json;
    assert.deepEqual(config.inbounds.map((item) => item.tag), ["bridge-" + viaHost.id, "bridge-" + viaLink.id]);
    const inbound = config.inbounds.find((item) => item.tag === "bridge-" + viaHost.id);
    // gost 拨的端口、带的凭据和桥接听的、认的是同一份。
    assert.equal("127.0.0.1:" + inbound.listen_port, node.addr);
    assert.deepEqual(inbound.users[0], node.connector.auth);
    const outbound = config.outbounds.find((item) => item.tag === "egress-" + viaHost.id);
    assert.equal(outbound.server, "203.0.113.20");
    assert.equal(outbound.uuid, UUID);
    assert.equal(outbound.tls.reality.public_key, PBK);
    const linkOutbound = config.outbounds.find((item) => item.tag === "egress-" + viaLink.id);
    assert.equal(linkOutbound.server, "198.51.100.50");
    assert.equal(linkOutbound.tls.server_name, "www.amd.com");
    assert.equal(config.outbounds.some((item) => item.type === "direct"), false);

    // 旧 Agent（2.2.252）：保存时会拦，这里直接写库模拟「建好后主机被重装成旧 Agent」。
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "egressType", "egressInboundId") VALUES (900, 30, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
      ["老机 VLESS 出口", "gost", "tcp", 22900, "198.51.100.7", 443, "vless_host", inboundId],
    );
    const old = await heartbeat("tok30", "2.2.252");
    assert.equal(old.gost.services.some((item) => item.name.startsWith("fwx-900-")), false, "不下发，更不退回直连");
    assert.equal(old.bridgeAction, null, "旧 Agent 不发桥接动作");
    const listedOld = (await rules.list()).find((item) => item.id === 900);
    assert.equal(listedOld.egress.state, "agent_upgrade");
    assert.match(listedOld.egress.message, /2\.2\.253/);
  `);
});
