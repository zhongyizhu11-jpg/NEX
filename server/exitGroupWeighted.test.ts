import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT_GROUP_STRATEGIES, EXIT_GROUP_STRATEGY_LABELS, exitGroupCapacities, exitGroupWeights, normalizeExitGroupStrategy } from "../shared/exitStrategy";
import { forwardXExitStrategy, gostExitSelector } from "./tunnelExitStrategy";

/**
 * 出口组「按权重」：按出口主机的线路带宽分新连接（500M / 300M → 5:3）。
 *
 *   · NEX 隧道：exits 里每个出口带 weight，FXP 按平滑加权轮询分；
 *   · GOST 隧道：份数写进节点 metadata.weight，gost 按它加权随机，每个出口只列一次；
 *   · nginx：server 行写 weight=N。
 *
 * 起一个真的 sqlite 和真的心跳路由跑一遍。
 */

test("按权重：名字、规整、份数", () => {
  assert.ok((EXIT_GROUP_STRATEGIES as readonly string[]).includes("weighted"));
  assert.match(EXIT_GROUP_STRATEGY_LABELS.weighted, /^按权重/);
  assert.equal(normalizeExitGroupStrategy("WEIGHTED"), "weighted");
  assert.equal(forwardXExitStrategy("weighted"), "weighted");
  assert.equal(gostExitSelector("weighted").strategy, "random");
  assert.deepEqual(exitGroupWeights("weighted", [500, 300]), [5, 3]);
  // 不知道带宽、或者带宽一样，就是轮流。
  assert.equal(exitGroupWeights("weighted", [500, 0]), null);
  assert.equal(exitGroupWeights("weighted", [300, 300]), null);
  assert.equal(exitGroupWeights("round_robin", [500, 300]), null);
});

test("按负载：名字、老的 least_conn 归过来、GOST/nginx 也有份数、FXP 拿线路带宽", () => {
  assert.match(EXIT_GROUP_STRATEGY_LABELS.least_load, /^按负载/);
  assert.equal(normalizeExitGroupStrategy("least_load"), "least_load");
  assert.equal(normalizeExitGroupStrategy("least_conn"), "least_load");
  assert.equal(forwardXExitStrategy("least_load"), "least_load");
  assert.equal(gostExitSelector("least_load").strategy, "random");
  assert.deepEqual(exitGroupWeights("least_load", [500, 300]), [5, 3]);
  assert.deepEqual(exitGroupCapacities("least_load", [500, 300]), [500, 300]);
  assert.deepEqual(exitGroupCapacities("ip_hash", [500, 300]), [500, 300]);
  assert.equal(exitGroupCapacities("least_load", [500, 0]), null);
  assert.equal(exitGroupCapacities("weighted", [500, 300]), null);
});

type Outcome = {
  fxpExits: Array<{ host: string; port: number; weight?: number; capacityMbps?: number }>;
  fxpStrategy: string;
  gostNodes: string[];
  gostSelector: string;
  gostRetries: number;
  nginx: string;
};

function run(strategy: string): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-exit-weighted-"));
  const databasePath = path.join(directory, "weighted.db");
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
    await exec('INSERT INTO system_settings (key, value) VALUES (?, ?)', ["forwardProtocols", JSON.stringify({ nginx_stream: true })]);
    for (const [id, name, ip, token, line] of [
      [1, "出口 A", "203.0.113.1", "tok1", 500],
      [2, "入口", "203.0.113.2", "tok2", 0],
      [4, "出口 B", "203.0.113.4", "tok4", 300],
    ]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat", "lineBandwidthMbps") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
        [id, name, ip, ip, "slave", token, "2.2.232", now, line],
      );
    }
    const tunnel = (id, mode, listenPort) => exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "loadBalanceEnabled", "loadBalanceStrategy") VALUES (?, ?, 2, 1, ?, ?, 1, 1, 1, ?)',
      [id, "t" + id, mode, listenPort, process.env.EXIT_STRATEGY],
    );
    await tunnel(1, "forwardx", 23001);
    await tunnel(2, "tls", 23002);
    await tunnel(3, "nginx_stream", 23003);
    for (const id of [1, 2, 3]) {
      await exec('INSERT INTO tunnel_exit_nodes (id, "tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (?, ?, 1, 4, ?, 1)', [100 + id, id, 23100 + id]);
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort") VALUES (?, 2, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)',
        [id, "rule-" + id, "gost", "tcp", 24000 + id, "198.51.100.7", 443, id, 23000 + id],
      );
      await exec(
        'INSERT INTO forward_rule_tunnel_exits ("ruleId", "tunnelId", "exitNodeId", "exitSeq", "exitHostId", "tunnelExitPort") VALUES (?, ?, ?, 1, 4, ?)',
        [id, id, 100 + id, 23100 + id],
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
        body: JSON.stringify({ agentVersion: "2.2.232", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      return body;
    };
    await beat("tok1");
    await beat("tok4");
    const body = await beat("tok2");
    server.close();

    const outcome = { fxpExits: [], fxpStrategy: "", gostNodes: [], gostSelector: "", gostRetries: 0, nginx: "" };
    for (const action of (body.desiredState && body.desiredState.actions) || []) {
      if (action && action.fxp && action.op === "apply" && action.fxp.role === "entry" && Number(action.ruleId) === 1) {
        outcome.fxpExits = action.fxp.exits || [];
        outcome.fxpStrategy = action.fxp.exitStrategy;
      }
      for (const config of (action && action.managedConfigs) || []) {
        const content = Buffer.from(String(config.contentBase64 || ""), "base64").toString("utf8");
        if (content.includes("fwx_tentry_3_tcp")) outcome.nginx = content;
        if (!String(config.path || "").endsWith(".json")) continue;
        let parsed = null;
        try { parsed = JSON.parse(content); } catch { continue; }
        for (const service of (parsed && parsed.services) || []) {
          if (service.name === "fwx-2-tcp") outcome.gostRetries = Number(service.handler && service.handler.retries || 0);
        }
        for (const chain of (parsed && parsed.chains) || []) {
          if (chain.name !== "chain-tunnel-2") continue;
          const hop = (chain.hops || [])[chain.hops.length - 1] || {};
          outcome.gostNodes = (hop.nodes || []).map((node) => node.name + "@" + node.addr + "#" + String(node.metadata && node.metadata.weight || ""));
          outcome.gostSelector = String(hop.selector && hop.selector.strategy || "");
        }
      }
    }
    console.log("OUTCOME " + JSON.stringify(outcome));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory, EXIT_STRATEGY: strategy },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = run("weighted");
const loadOutcome = run("least_load");

test("NEX 隧道：每个出口带上权重，策略原样交给 FXP", () => {
  assert.equal(outcome.fxpStrategy, "weighted");
  assert.deepEqual(outcome.fxpExits.map((exit) => exit.weight), [5, 3], JSON.stringify(outcome.fxpExits));
});

test("GOST 隧道：每个出口只列一次，份数写在 metadata.weight，按它加权随机；重试够把每个出口都试一遍", () => {
  assert.equal(outcome.gostSelector, "random");
  assert.equal(outcome.gostNodes.length, 2, outcome.gostNodes.join("\n"));
  assert.match(outcome.gostNodes[0], /@203\.0\.113\.1:\d+#5$/);
  assert.match(outcome.gostNodes[1], /@203\.0\.113\.4:\d+#3$/);
  assert.equal(outcome.gostRetries, 1);
});

test("nginx：server 行写 weight", () => {
  assert.match(outcome.nginx, /server 203\.0\.113\.1:\d+ weight=5 /);
  assert.match(outcome.nginx, /server 203\.0\.113\.4:\d+ weight=3 /);
});

test("按负载 · NEX 隧道：策略原样交给 FXP，每个出口带线路带宽", () => {
  assert.equal(loadOutcome.fxpStrategy, "least_load");
  assert.deepEqual(loadOutcome.fxpExits.map((exit) => exit.capacityMbps), [500, 300], JSON.stringify(loadOutcome.fxpExits));
});

test("按负载 · GOST 隧道：看不到实时负载，按带宽加权随机", () => {
  assert.equal(loadOutcome.gostSelector, "random");
  assert.deepEqual(loadOutcome.gostNodes.map((node) => node.split("#")[1]), ["5", "3"]);
});

test("按负载 · nginx：least_conn + weight", () => {
  assert.match(loadOutcome.nginx, /least_conn;/);
  assert.match(loadOutcome.nginx, /server 203\.0\.113\.1:\d+ weight=5 /);
});
