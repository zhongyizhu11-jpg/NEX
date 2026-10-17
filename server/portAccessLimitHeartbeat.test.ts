import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 普通端口转发的单 IP / 连接数限制走真的心跳路由（sqlite + express）：
 *   · Agent 2.2.229 的入口机拿到一条 port-access-limit-sync 运行时动作，快照只含面对客户端的
 *     TCP 入口端口，按用户聚合；
 *   · Agent 2.2.228 拿不到这条动作（老 Agent 照旧工作，普通规则仍不受限）；
 *   · 规则本身的下发不因此变化。
 */
type Beat = { limitActions: any[]; ruleIds: number[] };

function run(): { modern: Beat; legacy: Beat } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-port-limit-heartbeat-"));
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
    await exec('INSERT INTO users (id, username, password, role, "canAddRules", "maxIPs", "maxConnections") VALUES (1, ?, ?, ?, 1, 0, 0)', ["admin", "x", "admin"]);
    await exec('INSERT INTO users (id, username, password, role, "canAddRules", "maxIPs", "maxConnections") VALUES (2, ?, ?, ?, 1, 3, 0)', ["ip-limited", "x", "user"]);
    await exec('INSERT INTO users (id, username, password, role, "canAddRules", "maxIPs", "maxConnections") VALUES (3, ?, ?, ?, 1, 0, 40)', ["conn-limited", "x", "user"]);
    for (const [id, token, version] of [[1, "tok-new", "2.2.229"], [2, "tok-old", "2.2.228"]]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, "host-" + id, "203.0.113." + id, "203.0.113." + id, "slave", token, version, now]);
    }
    await exec('INSERT INTO user_host_permissions ("userId", "hostId") VALUES (2, 1), (3, 1), (2, 2)').catch(() => {});
    const rule = (id, hostId, userId, forwardType, protocol, sourcePort, extra = {}) => {
      const row = { id, hostId, name: "rule-" + id, forwardType, protocol, sourcePort, targetIp: "198.51.100.7", targetPort: 443, userId, isEnabled: 1, isRunning: 0, ...extra };
      const columns = Object.keys(row).map((key) => '"' + key + '"');
      const values = Object.values(row);
      return exec("INSERT INTO forward_rules (" + columns.join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")", values);
    };
    await rule(1, 1, 2, "realm", "tcp", 25001);
    await rule(2, 1, 2, "iptables", "both", 25002);
    await rule(3, 1, 2, "iptables", "udp", 25003);                       // UDP only: no TCP limit
    await rule(4, 1, 2, "gost", "tcp", 25004, { isEnabled: 0 });         // disabled
    await rule(5, 1, 2, "gost", "tcp", 25005, { routeParentRuleId: 1 }); // relay hop: sources are hosts, not clients
    await rule(6, 1, 3, "gost", "both", 25006);
    await rule(7, 1, 1, "realm", "tcp", 25007);                          // unlimited admin
    await rule(8, 2, 2, "realm", "tcp", 25008);                          // old Agent host

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
    const beat = async (token, agentVersion) => {
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ agentVersion, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("heartbeat failed: " + response.status + " " + JSON.stringify(body));
      const actions = [...((body.desiredState && body.desiredState.actions) || []), ...(body.actions || [])];
      return {
        limitActions: actions.filter((action) => action && action.forwardType === "port-access-limit-sync"),
        ruleIds: [...new Set(actions.filter((action) => action && action.op === "apply" && Number(action.ruleId) > 0).map((action) => Number(action.ruleId)))].sort((a, b) => a - b),
      };
    };
    const modern = await beat("tok-new", "2.2.229");
    const legacy = await beat("tok-old", "2.2.228");
    server.close();
    await runtime.closeDatabase();
    console.log(JSON.stringify({ modern, legacy }));
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "hb.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    if (result.status !== 0) throw new Error("script failed: status=" + result.status + "\n" + result.stdout + "\n" + result.stderr);
    const lines = result.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const outcome = run();

test("Agent 2.2.229 entry hosts receive one per-user TCP limit snapshot for client-facing ordinary rules", () => {
  assert.equal(outcome.modern.limitActions.length, 1);
  const action = outcome.modern.limitActions[0];
  assert.equal(action.statusType, "runtime");
  assert.equal(action.knownRunning, true);
  assert.deepEqual(action.portAccessLimits, [
    { userId: 2, maxIPs: 3, maxConnections: 0, ports: [25001, 25002] },
    { userId: 3, maxIPs: 0, maxConnections: 40, ports: [25006] },
  ]);
});

test("old Agents keep working: no limit action, ordinary rule dispatch unchanged", () => {
  assert.deepEqual(outcome.legacy.limitActions, []);
  assert.ok(outcome.legacy.ruleIds.includes(8));
  assert.ok(outcome.modern.ruleIds.includes(1) && outcome.modern.ruleIds.includes(6));
});
