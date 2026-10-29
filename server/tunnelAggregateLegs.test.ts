import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 单连接叠加（中转方式 aggregate）：入口给 FXP 的每一路都带上那台中转的线路带宽，
 * FXP 一开始就按它分份额。拓扑：家里设备（入口）→ 前置 A 500M / 前置 B 300M → 落地。
 * 起一个真的 sqlite 和真的心跳路由跑一遍。
 */
function legsScenario(relayMode: "aggregate" | "hot_standby") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-aggregate-legs-"));
  const databasePath = path.join(directory, "aggregate.db");
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
    for (const [id, name, ip, token, line, entryIp] of [
      [1, "家里", "203.0.113.10", "tok1", 0, "192.168.1.2"],
      [2, "前置 A", "198.51.100.2", "tok2", 500, null],
      [3, "前置 B", "198.51.100.3", "tok3", 300, null],
      [4, "落地", "203.0.113.40", "tok4", 2000, null],
    ]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat", "lineBandwidthMbps", "entryIp") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)',
        [id, name, ip, ip, "slave", token, "2.2.232", now, line, entryIp],
      );
    }
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "relayMode", "listenPort", "userId", "isEnabled") VALUES (1, ?, 1, 4, ?, ?, 23001, 1, 1)',
      ["家里叠加", "forwardx", process.env.FORWARDX_TEST_RELAY_MODE],
    );
    for (const [seq, hostId, port] of [[0, 1, 0], [1, 2, 23101], [2, 3, 23102], [3, 4, 23001]]) {
      await exec('INSERT INTO tunnel_hops ("tunnelId", seq, "hostId", "listenPort") VALUES (1, ?, ?, ?)', [seq, hostId, port]);
    }
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort") VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 23001)',
      ["家里叠加", "gost", "tcp", 24001, "203.0.113.40", 8388],
    );
    // 2：同一条叠加上开线路组（按权重分到两个落地目标）—— 入口照样拆到两台中转，调度器在落地机上。
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback", "routeMode", "routePaths", "routeSwitchMode")'
        + ' VALUES (2, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 23001, 1, ?, ?, 10, 60, 1, ?, ?, ?)',
      ["叠加加线路组", "gost", "tcp", 24002, "203.0.113.40", 8388, "weighted", "[]", "weighted", JSON.stringify([
        { key: "a", name: "落地 A", hops: [], dest: null, weight: 50, probe: null, dial: null },
        { key: "b", name: "落地 B", hops: [], dest: { ip: "203.0.113.41", port: 8388 }, weight: 50, probe: null, dial: null },
      ]), "smooth"],
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
    const beat = async (token) => {
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ agentVersion: "2.2.232", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      return body;
    };
    for (const token of ["tok2", "tok3"]) await beat(token);
    const exitBody = await beat("tok4");
    const body = await beat("tok1");
    server.close();
    let legs = null;
    let routed = null;
    for (const action of (body.desiredState && body.desiredState.actions) || []) {
      if (!action || !action.fxp || action.op !== "apply" || action.fxp.role !== "entry") continue;
      if (Number(action.ruleId) === 1) legs = action.fxp.multipathLegs || [];
      if (Number(action.ruleId) === 2) routed = { legs: (action.fxp.multipathLegs || []).map((leg) => leg.via), targetIp: action.fxp.targetIp, targetPort: Number(action.fxp.targetPort) };
    }
    const scheduler = (exitBody.runningRules || []).find((rule) => rule.schedulerOnly && Number(rule.ruleId) === 2) || null;
    console.log("OUTCOME " + JSON.stringify({ legs, routed, schedulerPort: scheduler ? Number(scheduler.sourcePort) : null }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory, FORWARDX_TEST_RELAY_MODE: relayMode },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length)) as { legs: any[]; routed: any; schedulerPort: number | null };
}

test("单连接叠加：每一路带上中转主机的线路带宽", () => {
  const { legs, routed, schedulerPort } = legsScenario("aggregate");
  assert.ok(Array.isArray(legs) && legs.length === 2, `应该有两路：${JSON.stringify(legs)}`);
  assert.ok(legs.every((leg: any) => !leg.standby), `叠加的腿都不是热备：${JSON.stringify(legs)}`);
  assert.deepEqual(legs.map((leg: any) => [leg.via, leg.capacityMbps]), [["relay#2", 500], ["relay#3", 300]], JSON.stringify(legs));
  // 叠加上开线路组：入口照样拆到两台中转，目标换成落地机上的调度器，由它按权重分给两个落地目标。
  assert.ok(schedulerPort && schedulerPort > 0, `落地机上应该跑着线路组调度器：${JSON.stringify({ routed, schedulerPort })}`);
  assert.deepEqual(routed, { legs: ["relay#2", "relay#3"], targetIp: "127.0.0.1", targetPort: schedulerPort });
});

test("热备：同样两路，第一台中转当主腿，其余标成 standby", () => {
  const { legs, routed, schedulerPort } = legsScenario("hot_standby");
  assert.ok(Array.isArray(legs) && legs.length === 2, `应该有两路：${JSON.stringify(legs)}`);
  assert.deepEqual(legs.map((leg: any) => [leg.via, leg.capacityMbps, !!leg.standby]), [["relay#2", 500, false], ["relay#3", 300, true]], JSON.stringify(legs));
  assert.ok(schedulerPort && schedulerPort > 0, `落地机上应该跑着线路组调度器：${JSON.stringify({ routed, schedulerPort })}`);
  assert.deepEqual(routed, { legs: ["relay#2", "relay#3"], targetIp: "127.0.0.1", targetPort: schedulerPort });
});
