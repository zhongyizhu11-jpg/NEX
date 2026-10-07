import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 一条 NEX（NEX）隧道规则从隧道 A 换到隧道 B（两条隧道共用同一台出口机）。
 *
 * 换过去之后三台机器拿到的配置必须对得上：
 *   · 旧入口（隧道 A 的入口）撤掉这个端口；
 *   · 新入口（隧道 B 的入口）按隧道 B 起入口：拨隧道 B 的出口端口、用隧道 B 的密钥，
 *     hello 里写的目标（域名原样）要在出口的目标表里；
 *   · 出口机上隧道 B 的出口目标表加上这条规则，隧道 A 的去掉；
 *   · 订阅里的节点地址跟着换到新入口；
 *   · 规则上跟着隧道走的开关按新隧道来，和直接建在隧道 B 上的一样（入口的 TCP Fast Open）。
 *
 * 起一个真的 sqlite、真的规则编辑接口和真的心跳路由跑一遍。
 */

type FxpSpec = Record<string, any>;
type Beat = {
  entries: Record<string, FxpSpec>;
  exits: Record<string, FxpSpec>;
  removed: Array<{ ruleId: number; tunnelId: number; sourcePort: number }>;
};
type Outcome = {
  update: any;
  rule: Record<string, any>;
  before: Record<string, Beat>;
  after: Record<string, Beat>;
  subscriptionBefore: string;
  subscriptionAfter: string;
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-tunnel-switch-"));
  const databasePath = path.join(directory, "switch.db");
  const logDirectory = path.join(directory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const script = String.raw`
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);
    const target = "landing.forwardx.invalid";

    await exec("INSERT INTO users (id, username, password, role, canAddRules, manualCanAddRules, accountEnabled, allowProxySubscription, manualAllowProxySubscription) VALUES (1, 'admin', 'hash', 'admin', 1, 1, 1, 1, 1)");
    for (const [id, name, ip, token] of [[1, "Po0", "203.0.113.1", "tok1"], [2, "Po01", "203.0.113.2", "tok2"], [3, "Jinx", "203.0.113.3", "tok3"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, "2.2.204", now],
      );
    }
    // 隧道 A：Po0 → Jinx；隧道 B：Po01 → Jinx，开着 TCP Fast Open。
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", secret) VALUES (1, ?, 1, 3, ?, ?, 1, 1, ?)', ["华南-香港", "forwardx", 46795, "secret-a"]);
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", secret, "tcpFastOpen") VALUES (2, ?, 2, 3, ?, ?, 1, 1, ?, 1)', ["华南-香港2", "forwardx", 46796, "secret-b"]);
    const insertRule = (id, hostId, tunnelId, sourcePort, targetIp, targetPort, extra = {}) => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tcpFastOpen", "proxyNodeId", "proxyNodeVisible") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, 1)',
      [id, hostId, "rule-" + id, "gost", "both", sourcePort, targetIp, targetPort, tunnelId, extra.tcpFastOpen ? 1 : 0, extra.proxyNodeId ?? null],
    );
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, isEnabled) VALUES (1, 1, 'Land', 'vless', ?, 19001, 'node-uuid', 'tcp', 0, 1)", [target]);
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, rulePreset, isEnabled) VALUES (1, 1, 'phone', 'sub-token', 'base64', 'minimal', 1)");
    // 要换的规则：TCP+UDP，目标是域名，绑了订阅节点。隧道 B 上原来还有一条规则在跑。
    await insertRule(10, 1, 1, 40981, target, 19001, { proxyNodeId: 1 });
    await insertRule(11, 2, 2, 40990, "198.51.100.50", 443, { tcpFastOpen: true });
    await exec('UPDATE tunnels SET "isRunning" = 1');
    // 这里验的是「旧入口直接撤掉」：关掉换隧道后的旧入口桥接（开着的情形见 ruleEntryBridgeSwitch.test.ts）。
    await exec("UPDATE system_settings SET value = '0' WHERE key = 'ruleSwitchBridgeHours'");

    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const subscriptions = await import(url("server/proxySubscriptionRoute.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    heartbeat.registerAgentHeartbeatRoute(app);
    app.use(subscriptions.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = "http://127.0.0.1:" + server.address().port;

    // 每台机器上报它此刻真正在跑的东西（和 Agent 一样带 localState），面板据此决定撤谁、起谁。
    const running = {
      tok1: { rules: [{ port: 40981, ruleId: 10, tunnelId: 1, forwardType: "forwardx", protocol: "both", transportVersion: "v1" }], tunnels: [], services: [] },
      tok2: { rules: [{ port: 40990, ruleId: 11, tunnelId: 2, forwardType: "forwardx", protocol: "both", transportVersion: "v1" }], tunnels: [], services: [] },
      tok3: { rules: [], tunnels: [
        { port: 46795, tunnelId: 1, forwardType: "forwardx-tunnel", transportVersion: "v1" },
        { port: 46796, tunnelId: 2, forwardType: "forwardx-tunnel", transportVersion: "v1" },
      ], services: [] },
    };
    const beat = async (token) => {
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ agentVersion: "2.2.204", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true, localState: running[token] }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      const out = { entries: {}, exits: {}, removed: [] };
      for (const action of (body.desiredState && body.desiredState.actions) || []) {
        if (action.op === "remove" && Number(action.ruleId) > 0) {
          out.removed.push({ ruleId: Number(action.ruleId), tunnelId: Number(action.tunnelId), sourcePort: Number(action.sourcePort) });
        }
        if (action.op !== "apply" || !action.fxp) continue;
        if (action.fxp.role === "entry") out.entries[String(action.ruleId)] = action.fxp;
        if (action.fxp.role === "exit") out.exits[String(action.tunnelId)] = action.fxp;
      }
      return out;
    };
    const beatAll = async () => ({ po0: await beat("tok1"), po01: await beat("tok2"), jinx: await beat("tok3") });
    const subscription = async () => {
      const response = await fetch(base + "/api/sub/sub-token");
      return Buffer.from(await response.text(), "base64").toString("utf8");
    };

    const before = await beatAll();
    const subscriptionBefore = await subscription();

    // 界面上的「编辑规则」：只把隧道从 A 换成 B，其它字段原样带上。
    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
    const update = await rulesRouter.createCaller(context).update({
      id: 10, hostId: 1, name: "rule-10", forwardType: "gost", protocol: "both", gostMode: "direct", gostRelayHost: null, gostRelayPort: null,
      tunnelId: 2, forwardGroupId: null, sourcePort: 40981, isEnabled: true, targetIp: target, targetPort: 19001,
      telegramErrorNotifyEnabled: false, failoverEnabled: false, routeGroup: null,
    });
    const rule = (await query('SELECT "hostId", "tunnelId", "isRunning", "tcpFastOpen", "proxyNodeId" FROM forward_rules WHERE id = 10'))[0];
    const after = await beatAll();
    const subscriptionAfter = await subscription();
    server.close();
    console.log("OUTCOME " + JSON.stringify({ update, rule, before, after, subscriptionBefore, subscriptionAfter }));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = run();
const target = "landing.forwardx.invalid";

test("前提：换之前规则跑在隧道 A 上，出口 A 的目标表里有它", () => {
  assert.equal(outcome.before.po0.entries["10"]?.tunnelId, 1);
  assert.ok((outcome.before.jinx.exits["1"]?.streamTargets || []).some((item: any) => item.ruleId === 10));
  assert.ok(outcome.subscriptionBefore.includes("@203.0.113.1:40981"), outcome.subscriptionBefore);
});

test("保存后规则挪到隧道 B 的入口，标记为待下发", () => {
  assert.equal(outcome.update.success, true);
  assert.equal(Number(outcome.rule.hostId), 2);
  assert.equal(Number(outcome.rule.tunnelId), 2);
  assert.equal(Number(outcome.rule.isRunning), 0);
});

test("旧入口撤掉这个端口，不再起它", () => {
  assert.deepEqual(outcome.after.po0.removed, [{ ruleId: 10, tunnelId: 1, sourcePort: 40981 }]);
  assert.equal(outcome.after.po0.entries["10"], undefined);
});

test("新入口按隧道 B 起入口，出口 B 的目标表放行它 hello 里的目标", () => {
  const entry = outcome.after.po01.entries["10"];
  const exitB = outcome.after.jinx.exits["2"];
  assert.ok(entry, "新入口没收到这条规则");
  assert.ok(exitB, "出口机没收到隧道 B 的出口配置");
  assert.equal(entry.tunnelId, 2);
  assert.equal(entry.listenPort, 40981);
  assert.equal(entry.protocol, "both");
  assert.equal(entry.exitHost, "203.0.113.3");
  assert.equal(entry.exitPort, exitB.listenPort, "入口拨的端口和出口 B 监听的不一样");
  assert.equal(exitB.listenPort, 46796);
  assert.equal(entry.key, exitB.key, "入口和出口 B 的隧道密钥对不上");
  assert.equal(entry.key, "secret-b");
  assert.equal(entry.targetIp, target, "域名目标原样写进 hello，由出口解析");
  assert.ok(
    exitB.streamTargets.some((item: any) => item.ruleId === 10 && item.targetIp === entry.targetIp && item.targetPort === entry.targetPort),
    "出口 B 的目标表里没有入口 hello 里的目标：" + JSON.stringify(exitB.streamTargets),
  );
  assert.ok(exitB.udpTargets.some((item: any) => item.ruleId === 10 && item.targetPort === 19001), "出口 B 的 UDP 目标表里没有这条规则");
  assert.ok(exitB.streamTargets.some((item: any) => item.ruleId === 11), "隧道 B 上原来的规则不该丢");
});

test("出口 A 的目标表去掉这条规则", () => {
  const exitA = outcome.after.jinx.exits["1"];
  assert.ok(exitA, "出口机没收到隧道 A 的出口配置");
  assert.equal((exitA.streamTargets || []).some((item: any) => item.ruleId === 10), false);
  assert.equal((exitA.udpTargets || []).some((item: any) => item.ruleId === 10), false);
});

test("订阅节点地址跟着换到新入口", () => {
  assert.ok(outcome.subscriptionAfter.includes("@203.0.113.2:40981"), outcome.subscriptionAfter);
  assert.equal(outcome.subscriptionAfter.includes("203.0.113.1"), false, outcome.subscriptionAfter);
});

test("跟着隧道走的开关按新隧道来：和直接建在隧道 B 上的规则一样", () => {
  assert.equal(Number(outcome.rule.tcpFastOpen), 1, "换到开着 TCP Fast Open 的隧道后规则上的开关被清空了");
  assert.equal(outcome.after.po01.entries["10"].tcpFastOpen, true);
  assert.equal(outcome.after.po01.entries["10"].tcpFastOpen, outcome.after.po01.entries["11"]?.tcpFastOpen ?? true);
});
