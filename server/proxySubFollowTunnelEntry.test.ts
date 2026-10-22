import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 链路换入口机器后，订阅要跟着走。
 *
 * 规则行上的 hostId 是建规则时的入口；之后在隧道里把入口换成别的机器，运行和列表都按隧道
 * 当前入口走，规则行却不改。订阅原来只读规则行，换完链路客户端拿到的还是老机器的地址，
 * 节点全部超时。这里起真 SQLite 跑整条路由：换入口前后各拉一次，地址和名字都得换，
 * 而且第二次拉要立刻拿到新的（响应缓存得在隧道更新时作废）。转发组同理：第一个启用的
 * 成员是入口。
 */
test("隧道换入口机器后订阅节点跟着换，转发组按第一个成员出入口", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-entry-"));
  const databasePath = path.join(directory, "sub-entry.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const route = await import(url("server/proxySubscriptionRoute.ts"));
    const proxyNode = await import(url("shared/proxyNode.ts"));
    const tunnelRepo = await import(url("server/repositories/tunnelRepository.ts"));
    const groupRepo = await import(url("server/repositories/forwardGroupRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'owner', 'hash', 'user', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'Po0(500M)', '1.1.1.1', '1.1.1.1', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (2, 'po0(300M)', '2.2.2.2', '2.2.2.2', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (3, 'Jinx', '3.3.3.3', '3.3.3.3', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (4, '备用入口', '4.4.4.4', '4.4.4.4', 1)");
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, sni, isEnabled) VALUES (1, 1, 'HKT', 'vless', 'hkt.example.com', 443, 'uuid-hk', 'tcp', 1, 'hkt.example.com', 1)");
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, mode, listenPort, userId, isEnabled) VALUES (10, '华南-香港', 1, 3, 'gost', 30000, 1, 1)");
    // 规则行记的入口还是 1 号机器。
    await exec("INSERT INTO forward_rules (id, hostId, tunnelId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (1, 1, 10, '广港hkt', 'gost', 'tcp', 44760, 'hkt.example.com', 443, 1, 1, 1, 0, 1, 1)");
    // 转发组：成员 4 号机优先级最高；规则行记的入口是 1 号机。
    await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, targetPort, userId, isEnabled) VALUES (20, '入口组', 'host', 'failover', 'hkt.example.com', 443, 1, 1)");
    await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (201, 20, 'host', 4, 0, 1)");
    await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (202, 20, 'host', 2, 10, 1)");
    await exec("INSERT INTO forward_rules (id, hostId, forwardGroupId, isForwardGroupTemplate, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (2, 1, 20, 1, '组转HKT', 'realm', 'tcp', 44761, 'hkt.example.com', 443, 1, 1, 1, 0, 1, 1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (1, 1, '手机', 'tok', 'base64', 1)");

    const app = express();
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const get = (pathname) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: pathname }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      }).on("error", reject);
    });
    const links = async () => {
      const response = await get("/api/sub/tok");
      assert.equal(response.status, 200, response.body);
      return proxyNode.decodeBase64Utf8(response.body).split("\n").filter(Boolean).map((line) => decodeURIComponent(line));
    };

    // 换之前：隧道规则走 1 号机，组规则走组里优先级最高的 4 号机（不是规则行记的 1 号机）。
    const before = await links();
    assert.equal(before.length, 2, before.join("\n"));
    assert.ok(before[0].includes("@1.1.1.1:44760"), before[0]);
    assert.ok(before[0].includes("Po0(500M)"), before[0]);
    assert.ok(before[1].includes("@4.4.4.4:44761"), before[1]);
    assert.ok(before[1].includes("备用入口"), before[1]);

    // 隧道入口换成 2 号机：规则行不动，订阅立刻变（不等缓存过期）。
    await tunnelRepo.updateTunnel(10, { entryHostId: 2 });
    const after = await links();
    assert.ok(after[0].includes("@2.2.2.2:44760"), "换入口后节点地址要跟着换：" + after[0]);
    assert.ok(after[0].includes("po0(300M)") && !after[0].includes("Po0(500M)"), "节点名里的入口机器也要换：" + after[0]);

    // 转发组成员重排：2 号机排到最前，组规则跟着换入口。
    await groupRepo.reorderForwardGroupMembers(20, [202, 201]);
    const reordered = await links();
    assert.ok(reordered[1].includes("@2.2.2.2:44761"), "组成员重排后入口要跟着换：" + reordered[1]);

    server.close();
    console.log("OK");
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes("OK"), result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
