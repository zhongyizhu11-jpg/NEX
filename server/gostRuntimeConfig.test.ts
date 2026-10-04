import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 下发给落地机的 GOST 运行时配置。
 *
 * 这是**全站最要害的一份生成物**：一台机器上所有走 gost 的转发（直连的和走隧道的）
 * 最后都压成这一个 JSON，Agent 拿它覆盖 `/etc/forwardx/runtime/gost.json` 再重启
 * 服务。它错了不会有人报错 —— GOST 照样起来、端口照样通，只是走错了路。
 *
 * 之前它一行测试都没有。命令基线那一组也盖不到：那组只看每条规则各自的动作，
 * 而这份配置是**跨全机规则聚合**出来的，挂在一条 `gost-runtime-sync` 动作上。
 *
 * 这里钉两层：
 *   - 结构断言：说得出「哪里错了」，而且每一条对应一种真会发生、但界面上看不出来的坏法。
 *   - 内容哈希：说不出哪里错，但**什么都漏不掉**，是重构这片时的安全网。
 *
 * 如果你是故意改了配置生成，哈希那条会红。更新它，并在提交信息里说清改了什么。
 */

type GostConfig = {
  services: Array<any>;
  chains: Array<any>;
  limiters: Array<any>;
};

function loadConfig(): { config: GostConfig; hash: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-gost-cfg-"));
  const databasePath = path.join(directory, "gost.db");
  const script = String.raw`
    import crypto from "node:crypto";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (1, ?, ?, ?, ?, ?, 1, 1)',
      ["入口机", "203.0.113.1", "203.0.113.1", "slave", "tok1"],
    );
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (2, ?, ?, ?, ?, ?, 1, 1)',
      ["落地机", "203.0.113.2", "203.0.113.2", "slave", "tok2"],
    );
    // 限速 100Mbps 的 TLS 隧道，好让 chains 和 limiters 都不是空的。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", secret, "userId", "isEnabled", "rateLimitMbps")'
        + ' VALUES (1, ?, 1, 2, ?, ?, ?, 1, 1, ?)',
      ["测试隧道", "tls", 30001, "s3cret", 100],
    );
    // 一条直连（both 协议）、一条走隧道（tcp）。
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled")'
        + ' VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1, 1)',
      ["direct-both", "gost", "both", 20001, "198.51.100.7", 443],
    );
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "tunnelId")'
        + ' VALUES (2, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1)',
      ["tunnel-tcp", "gost", "tcp", 20002, "198.51.100.9", 8443],
    );

    const express = (await import("express")).default;
    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    heartbeat.registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = "http://127.0.0.1:" + server.address().port;

    const response = await fetch(base + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok1" },
      body: JSON.stringify({ agentVersion: "2.3.362", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
    });
    const body = await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status);

    const actions = (body.desiredState && body.desiredState.actions) || [];
    let found = null;
    for (const action of actions) {
      for (const config of (action.managedConfigs || [])) {
        if (String(config.path || "").endsWith("/gost.json")) found = config;
      }
    }
    if (!found) throw new Error("没找到 gost.json —— 整份运行时配置没下发");
    const text = Buffer.from(found.contentBase64, "base64").toString("utf8");
    console.log("GOSTCFG " + JSON.stringify({
      config: JSON.parse(text),
      hash: crypto.createHash("sha256").update(text).digest("hex").slice(0, 16),
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("GOSTCFG "));
  assert.ok(line, `没拿到配置：\n${result.stdout}`);
  return JSON.parse(line.slice("GOSTCFG ".length));
}

const loaded = loadConfig();
const config = loaded.config;
const serviceByName = new Map(config.services.map((service: any) => [String(service.name), service]));

test("走隧道的规则，handler 上必须挂着链", () => {
  /*
    这一条是这份配置里**最危险的一处**：链掉了，GOST 照样起得来、端口照样通、
    面板上也照样显示「运行中」，只是流量从入口机直奔目标，隧道整条被跳过。
    用户看不出来，只有对端日志里的来源 IP 会变 —— 而那正是买隧道要解决的事。
  */
  const tunnelService = serviceByName.get("fwx-2-tcp");
  assert.ok(tunnelService, "走隧道那条规则没生成服务");
  assert.equal(tunnelService.handler.chain, "chain-tunnel-2", "走隧道的规则没挂链，流量会绕过隧道直连目标");

  const chain = config.chains.find((item: any) => item.name === "chain-tunnel-2");
  assert.ok(chain, "handler 引用了 chain-tunnel-2，但 chains 里没有这一条 —— GOST 会拒绝整份配置");
  const node = chain.hops[0].nodes[0];
  assert.equal(node.addr, "203.0.113.2:30001", "链的下一跳要指向落地机的隧道监听端口");
  assert.equal(node.dialer.type, "tls", "拨号方式要跟隧道模式一致");
  assert.equal(node.connector.type, "relay");
});

test("直连的规则不挂链", () => {
  // 反过来也得成立：给直连规则挂上链，流量会白白绕一趟隧道，而且是按隧道计费的。
  assert.equal(serviceByName.get("fwx-1-tcp").handler.chain, undefined);
  assert.equal(serviceByName.get("fwx-1-udp").handler.chain, undefined);
});

test("both 协议拆成两个服务，同一个端口，名字不能撞", () => {
  const tcp = serviceByName.get("fwx-1-tcp");
  const udp = serviceByName.get("fwx-1-udp");
  assert.ok(tcp && udp, "both 协议要同时产出 TCP 和 UDP 两个服务");
  assert.equal(tcp.addr, ":20001");
  assert.equal(udp.addr, ":20001");
  // 名字撞了的话 GOST 只会保留一个，另一个协议**无声地不转发**。
  assert.notEqual(tcp.name, udp.name);
  assert.equal(tcp.listener.type, "tcp");
  assert.equal(udp.listener.type, "udp");
});

test("UDP 监听要带上缓冲区那几项，TCP 不带", () => {
  /*
    这几项不是装饰：readQueueSize / backlog 决定并发会话上限，ttl 决定会话多久回收。
    漏掉的话 GOST 用自己的默认值，UDP 在稍有并发时开始丢包 —— 面板上看不出来，
    只表现为「有时候连不上」。
  */
  const udp = serviceByName.get("fwx-1-udp");
  assert.deepEqual(udp.listener.metadata, {
    keepalive: true,
    ttl: "30s",
    readBufferSize: "8192",
    readQueueSize: "256",
    backlog: "128",
  });
  assert.equal(serviceByName.get("fwx-1-tcp").listener.metadata, undefined);
});

test("隧道限速要变成 limiter，并且被服务引用", () => {
  const tunnelService = serviceByName.get("fwx-2-tcp");
  const limiterName = tunnelService.limiter;
  assert.ok(limiterName, "隧道配了 100Mbps，服务却没引用任何 limiter —— 这条转发是不限速的");
  const limiter = config.limiters.find((item: any) => item.name === limiterName);
  assert.ok(limiter, `服务引用了 ${limiterName}，但 limiters 里没有`);
  // 100 Mbps = 100 * 1000 * 1000 / 8 = 12500000 字节每秒，收发各一份。
  assert.deepEqual(limiter.limits, ["$ 12500000B 12500000B"]);
  // 不限速的直连规则不该带 limiter。
  assert.equal(serviceByName.get("fwx-1-tcp").limiter, undefined);
});

test("转发目标写在 forwarder 上，不是写在监听地址上", () => {
  const direct = serviceByName.get("fwx-1-tcp");
  assert.equal(direct.forwarder.nodes[0].addr, "198.51.100.7:443");
  // 走隧道的规则，forwarder 仍是最终目标 —— 隧道是在 chain 那一层走的。
  assert.equal(serviceByName.get("fwx-2-tcp").forwarder.nodes[0].addr, "198.51.100.9:8443");
});

test("整份配置的内容基线（重构安全网）", () => {
  assert.deepEqual(
    config.services.map((service: any) => service.name).sort(),
    ["fwx-1-tcp", "fwx-1-udp", "fwx-2-tcp"],
  );
  assert.equal(
    loaded.hash,
    "bc7fd8fbae10f35f",
    "gost.json 的内容变了；结构断言没说话就是变在它们没盯的地方。如果是故意改的，更新这个哈希并在提交信息里说清楚",
  );
});
