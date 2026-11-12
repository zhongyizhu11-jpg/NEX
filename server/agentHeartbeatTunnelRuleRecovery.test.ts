import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 运行状态被清掉之后（主机地址变了、短暂掉线、面板重启都会走 resetAgentRuntimeStateForHost），
 * 下一次心跳按 Agent 报的本机监听把规则恢复成「在运行」。
 *
 * 以前只恢复不走隧道的规则：隧道入口规则要等 Agent 再报一次，可 Agent 那边配置没变、不会重下发，
 * 于是流量照通、面板一直写「没在运行」（真机上动态 IP 的机器隔几分钟就清一次，2026-11 联调发现）。
 * 现在隧道规则也恢复，但要本机监听对得上（FXP 隧道是 forwardx、传输版本要对）且隧道已经在跑。
 */

type Outcome = Record<string, number>;

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-tunnel-rule-recovery-"));
  const databasePath = path.join(directory, "recovery.db");
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
        [id, name, ip, ip, "slave", token, "2.2.257", "2.2.141", now],
      );
    }
    const tunnel = (id, listenPort, version, running) => exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "forwardxVersion", "listenPort", "userId", "isEnabled", "isRunning") VALUES (?, ?, 2, 1, ?, ?, ?, 1, 1, ?)',
      [id, "t" + id, "forwardx", version, listenPort, running ? 1 : 0],
    );
    await tunnel(1, 23001, "v3", true);   // V3，在跑
    await tunnel(2, 23002, "v1", true);   // V1，在跑
    await tunnel(3, 23003, "v1", false);  // V1，隧道自己还没报在跑
    const rule = (id, port, tunnelId, forwardType) => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort") VALUES (?, 2, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)',
      [id, "rule-" + id, forwardType, "tcp", port, "198.51.100.7", 443, tunnelId, tunnelId ? 23000 + tunnelId : null],
    );
    await rule(1, 24001, 1, "gost");      // 经 V3 隧道，本机监听对得上 → 恢复
    await rule(2, 24002, 2, "gost");      // 经 V1 隧道，本机监听对得上 → 恢复
    await rule(3, 24003, 3, "gost");      // 隧道没在跑 → 不恢复
    await rule(4, 24004, null, "nftables"); // 普通规则 → 照旧恢复
    await rule(5, 24005, 1, "gost");      // 经 V3 隧道，本机报的却是 V1 的进程（旧的） → 不恢复

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
    const local = (ruleId, port, tunnelId, forwardType, transportVersion) => ({ port, ruleId, tunnelId, forwardType, transportVersion, targetIp: "198.51.100.7", targetPort: 443, protocol: "tcp", ready: true });
    const response = await fetch(base + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok2" },
      body: JSON.stringify({
        agentVersion: "2.2.257", fxpVersion: "2.2.141", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1,
        localState: {
          rules: [
            local(1, 24001, 1, "forwardx", "v3"),
            local(2, 24002, 2, "forwardx", "v1"),
            local(3, 24003, 3, "forwardx", "v1"),
            local(4, 24004, undefined, "nftables", undefined),
            local(5, 24005, 1, "forwardx", "v1"),
          ],
          tunnels: [],
          services: [],
        },
      }),
    });
    if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + await response.text());
    server.close();
    const rows = await runtime.queryRaw('SELECT id, "isRunning" FROM forward_rules ORDER BY id');
    console.log("OUTCOME " + JSON.stringify(Object.fromEntries(rows.map((row) => [String(row.id), Number(row.isRunning)]))));
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory },
    timeout: 180_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = run();

test("运行状态被清掉后：隧道入口规则按本机监听恢复，和普通规则一样", () => {
  assert.equal(outcome["1"], 1, "经 V3 隧道、本机监听对得上");
  assert.equal(outcome["2"], 1, "经 V1 隧道、本机监听对得上");
  assert.equal(outcome["4"], 1, "普通规则照旧恢复");
});

test("隧道还没报在跑、或本机进程的传输版本对不上：不恢复，等 Agent 报", () => {
  assert.equal(outcome["3"], 0, "隧道没在跑");
  assert.equal(outcome["5"], 0, "V3 隧道上跑着的是 V1 的旧进程");
});
