import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * V2 隧道「内核直通」的下发（server/agentHeartbeatRoute.ts 的 tunnelKernelPassthroughPlan）。
 *
 * 开关开着、两头都报告内核 WireGuard 时：
 *   · 入口上普通规则变成一条 iptables 规则，目标是出口的 WireGuard 地址 + 同一个端口；
 *   · 入口、出口的 WireGuard 配置都带直通表（入口只记端口，出口带 DNAT 目标）；
 *   · 带限速的规则、没开开关的隧道照旧走 FXP；
 *   · 有一头报回用户态数据面，规则立刻退回 FXP，直通表清空。
 *
 * 起一个真的 sqlite 和真的心跳路由跑一遍。
 */

type Beat = {
  rules: Record<string, { forwardType: string; targetIp: string; targetPort: number; hasFxp: boolean; dnat: boolean }>;
  passthrough: Record<string, any[]>;
  peers: Record<string, Record<string, string>>;
};
type Outcome = {
  entryBefore: Beat;
  entryAfter: Beat;
  exitAfter: Beat;
  entryNetstack: Beat;
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-passthrough-"));
  const databasePath = path.join(directory, "pt.db");
  const logDirectory = path.join(directory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const script = String.raw`
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, name, ip, token] of [[1, "出口", "203.0.113.1", "tok1"], [2, "入口", "203.0.113.2", "tok2"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "fxpVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, "2.2.220", "2.2.132", now],
      );
    }
    const tunnel = (id, name, listenPort, extra = {}) => {
      const columns = ["id", "name", '"entryHostId"', '"exitHostId"', "mode", '"forwardxVersion"', '"listenPort"', '"userId"', '"isEnabled"', ...Object.keys(extra).map((key) => '"' + key + '"')];
      const values = [id, name, 2, 1, "forwardx", "v2", listenPort, 1, 1, ...Object.values(extra)];
      return exec("INSERT INTO tunnels (" + columns.join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")", values);
    };
    await tunnel(1, "直通", 23001, { kernelPassthrough: 1 });
    await tunnel(2, "普通", 23002);
    await tunnel(3, "直通但限速", 23003, { kernelPassthrough: 1, rateLimitMbps: 100 });
    const rule = (id, tunnelId, protocol, sourcePort, extra = {}) => {
      const columns = ["id", '"hostId"', "name", '"forwardType"', "protocol", '"sourcePort"', '"targetIp"', '"targetPort"', '"userId"', '"isEnabled"', '"isRunning"', '"tunnelId"', '"tunnelExitPort"', ...Object.keys(extra).map((key) => '"' + key + '"')];
      const values = [id, 2, "rule-" + id, "gost", protocol, sourcePort, "198.51.100.7", 443, 1, 1, 0, tunnelId, 23000 + tunnelId, ...Object.values(extra)];
      return exec("INSERT INTO forward_rules (" + columns.join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")", values);
    };
    await rule(1, 1, "tcp", 24001);
    await rule(2, 3, "tcp", 24002);
    await rule(3, 1, "both", 24003);
    await rule(4, 2, "tcp", 24004);

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
    const beat = async (token, planes) => {
      const localState = planes ? { rules: [], tunnels: [], services: [], wireGuardPlanes: planes } : undefined;
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({
          agentVersion: "2.2.220", fxpVersion: "2.2.132", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true,
          ...(localState ? { localState, localStateSignature: "sig-" + token + "-" + JSON.stringify(planes) } : {}),
        }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      const rules = {};
      const passthrough = {};
      const peers = {};
      for (const action of (body.desiredState && body.desiredState.actions) || []) {
        if (!action || action.op !== "apply") continue;
        if (action.statusType === "rule" && Number(action.ruleId) > 0) {
          const commands = (action.commands || []).join("\n");
          rules[String(action.ruleId)] = {
            forwardType: String(action.forwardType), targetIp: String(action.targetIp), targetPort: Number(action.targetPort),
            hasFxp: !!action.fxp, dnat: commands.includes("-j DNAT --to-destination " + action.targetIp + ":" + action.targetPort),
          };
        }
        if (action.forwardType === "forwardx-wireguard" && action.wireGuard) {
          passthrough[String(action.tunnelId)] = action.wireGuard.passthrough || [];
          peers[String(action.tunnelId)] = Object.fromEntries((action.wireGuard.peers || []).map((peer) => [String(peer.id), String(peer.address)]));
        }
      }
      return { rules, passthrough, peers };
    };

    const entryBefore = await beat("tok2", [{ tunnelId: 1, plane: "kernel" }, { tunnelId: 2, plane: "kernel" }, { tunnelId: 3, plane: "kernel" }]);
    await beat("tok1", [{ tunnelId: 1, plane: "kernel" }, { tunnelId: 2, plane: "kernel" }, { tunnelId: 3, plane: "kernel" }]);
    const entryAfter = await beat("tok2");
    const exitAfter = await beat("tok1");
    await beat("tok1", [{ tunnelId: 1, plane: "netstack" }, { tunnelId: 2, plane: "kernel" }, { tunnelId: 3, plane: "kernel" }]);
    const entryNetstack = await beat("tok2");
    server.close();
    console.log(JSON.stringify({ entryBefore, entryAfter, exitAfter, entryNetstack }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory },
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error("脚本失败: status=" + result.status + "\n" + result.stdout + "\n" + result.stderr);
  }
  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Outcome;
}

const outcome = run();

test("出口还没报告数据面之前，规则照旧走 FXP，WireGuard 配置不带直通表", () => {
  assert.equal(outcome.entryBefore.rules["1"].forwardType, "forwardx");
  assert.equal(outcome.entryBefore.rules["1"].hasFxp, true);
  assert.deepEqual(outcome.entryBefore.passthrough["1"], []);
});

test("两头都是内核 WireGuard 时，入口上的普通规则变成到出口 WireGuard 地址的 iptables 规则", () => {
  const exitAddress = outcome.entryAfter.peers["1"]["1"];
  assert.match(exitAddress, /^\d+\.\d+\.\d+\.\d+$/, "入口的对端表里有出口的 WireGuard 地址");
  assert.deepEqual(outcome.entryAfter.rules["1"], { forwardType: "iptables", targetIp: exitAddress, targetPort: 24001, hasFxp: false, dnat: true });
  assert.deepEqual(outcome.entryAfter.rules["3"], { forwardType: "iptables", targetIp: exitAddress, targetPort: 24003, hasFxp: false, dnat: true });
  assert.equal(outcome.entryAfter.rules["2"].forwardType, "forwardx", "带限速的规则还是 FXP");
  assert.equal(outcome.entryAfter.rules["2"].hasFxp, true);
  assert.equal(outcome.entryAfter.rules["4"].forwardType, "forwardx", "没开直通的隧道还是 FXP");
  assert.deepEqual(outcome.entryAfter.passthrough["1"], [
    { ruleId: 1, role: "entry", peerId: "1", port: 24001, protocol: "tcp" },
    { ruleId: 3, role: "entry", peerId: "1", port: 24003, protocol: "both" },
  ]);
  assert.deepEqual(outcome.entryAfter.passthrough["2"], []);
  assert.deepEqual(outcome.entryAfter.passthrough["3"], [], "带限速的隧道没有直通表");
});

test("出口的 WireGuard 配置带着每条直通规则的 DNAT 目标", () => {
  assert.deepEqual(outcome.exitAfter.passthrough["1"], [
    { ruleId: 1, role: "exit", peerId: "2", port: 24001, protocol: "tcp", targetIp: "198.51.100.7", targetPort: 443 },
    { ruleId: 3, role: "exit", peerId: "2", port: 24003, protocol: "both", targetIp: "198.51.100.7", targetPort: 443 },
  ]);
  assert.deepEqual(outcome.exitAfter.passthrough["2"], []);
});

test("出口退回用户态数据面后，规则立刻回到 FXP，直通表清空", () => {
  assert.equal(outcome.entryNetstack.rules["1"].forwardType, "forwardx");
  assert.equal(outcome.entryNetstack.rules["1"].hasFxp, true);
  assert.deepEqual(outcome.entryNetstack.passthrough["1"], []);
});
