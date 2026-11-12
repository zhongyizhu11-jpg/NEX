import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * NEX V3 的规格从面板一路下发到 Agent（真 sqlite + 真心跳路由跑一遍）：
 *
 *   · V3 隧道的入口、出口 FXP 规格都是 transportVersion=v3，带着外层选项，多路复用显式写；
 *   · 库里残留的抗丢包传输 / 多路并发（直接改库、旧数据）不下发给 V3：FXP 会拒掉整份配置；
 *   · V1 隧道的规格里一个 V3 字段都没有（FXP 配置和以前一模一样，不会因此重启）；
 *   · 建库时三列 V3 选项按 dbSchema 补上了。
 */

type Spec = Record<string, unknown>;
type Outcome = { entry: Record<string, Spec>; exit: Record<string, Spec>; columns: string[] };

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-v3-heartbeat-"));
  const databasePath = path.join(directory, "v3.db");
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
    const columns = (await runtime.queryRaw('PRAGMA table_info("tunnels")')).map((row) => row.name).filter((name) => String(name).startsWith("v3"));

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, name, ip, token] of [[1, "出口", "203.0.113.1", "tok1"], [2, "入口", "203.0.113.2", "tok2"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "fxpVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, "2.2.257", "2.2.141", now],
      );
    }
    const tunnel = (id, name, listenPort, extra = {}) => {
      const keys = ["id", "name", '"entryHostId"', '"exitHostId"', "mode", '"listenPort"', '"userId"', '"isEnabled"', ...Object.keys(extra).map((key) => '"' + key + '"')];
      const values = [id, name, 2, 1, "forwardx", listenPort, 1, 1, ...Object.values(extra)];
      return exec("INSERT INTO tunnels (" + keys.join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")", values);
    };
    // 1 号：V3 WebSocket 外层，开了多路复用；库里残留着抗丢包传输和 4 路并发（面板保存时会拒，这里模拟旧数据）。
    await tunnel(1, "NEX V3", 23001, { forwardxVersion: "v3", v3Transport: "ws", v3Path: "/live", v3Host: "cdn.example", v3Multiplex: 1, lossTolerant: 1, parallelStreams: 4 });
    // 2 号：V3 TLS 外层，老行没存过多路复用（按默认关）。
    await tunnel(2, "NEX V3 TLS", 23002, { forwardxVersion: "v3", v3Transport: "tls", v3ServerName: "www.example.com" });
    // 3 号：V1，库里残留着 V3 选项（不该下发）。
    await tunnel(3, "NEX V1", 23003, { forwardxVersion: "v1", v3Transport: "ws", v3Path: "/stale" });
    for (const id of [1, 2, 3]) {
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort") VALUES (?, 2, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)',
        [id, "rule-" + id, "gost", "tcp", 24000 + id, "198.51.100.7", 443, id, 23000 + id],
      );
    }

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
        body: JSON.stringify({ agentVersion: "2.2.257", fxpVersion: "2.2.141", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      const specs = {};
      // 新 Agent 的回复把动作放在 desiredState 里，老 Agent 放在 actions 里，规格是同一份。
      for (const action of [...(body.actions || []), ...((body.desiredState && body.desiredState.actions) || [])]) {
        if (action && action.fxp && action.op === "apply") specs[String(action.fxp.role) + ":" + String(action.fxp.tunnelId)] = action.fxp;
      }
      return specs;
    };
    const entry = await beat("tok2");
    const exit = await beat("tok1");
    server.close();
    console.log("OUTCOME " + JSON.stringify({ entry, exit, columns }));
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
const pick = (spec: Spec | undefined, keys: string[]) => Object.fromEntries(keys.filter((key) => spec && key in spec).map((key) => [key, spec?.[key]]));
const V3_KEYS = ["transportVersion", "v3Transport", "v3Host", "v3Path", "v3UserAgent", "v3ServerName", "v3Multiplex"];

test("建库时补上 V3 的几列", () => {
  assert.deepEqual([...outcome.columns].sort(), ["v3Host", "v3Multiplex", "v3Path", "v3ServerName", "v3Transport", "v3UserAgent"]);
});

test("V3 隧道：入口、出口的 FXP 规格都是 v3，带着同一份外层选项", () => {
  for (const side of [outcome.entry, outcome.exit]) {
    const role = side === outcome.entry ? "entry" : "exit";
    assert.deepEqual(pick(side[`${role}:1`], V3_KEYS), {
      transportVersion: "v3", v3Transport: "ws", v3Host: "cdn.example", v3Path: "/live", v3Multiplex: true,
    }, `${role} 的 1 号隧道`);
    assert.deepEqual(pick(side[`${role}:2`], V3_KEYS), {
      transportVersion: "v3", v3Transport: "tls", v3ServerName: "www.example.com", v3Multiplex: false,
    }, `${role} 的 2 号隧道（没存过多路复用按默认关）`);
  }
});

test("V3 隧道不下发库里残留的抗丢包传输和多路并发", () => {
  for (const spec of [outcome.entry["entry:1"], outcome.exit["exit:1"]]) {
    assert.ok(spec, "规格要在");
    assert.equal(spec.lossTolerant, undefined);
    assert.equal(spec.multipathEnabled, undefined);
    assert.equal(spec.multipathLegs, undefined);
  }
});

test("V1 隧道的规格里没有 V3 字段", () => {
  for (const spec of [outcome.entry["entry:3"], outcome.exit["exit:3"]]) {
    assert.ok(spec, "规格要在");
    assert.deepEqual(pick(spec, V3_KEYS), { transportVersion: "v1" });
  }
});
