import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 隧道入口让出口拨的端口按出口自己分到的来（server/tunnelExitPorts.ts）。
 *
 * 调度器和出口桥守卫的端口每台机器按自己的规则集分（allocateProtocolGuardPorts），被占了就往后
 * 顺延。这里在出口机上放两条普通规则，正好占掉 1 号、3 号规则想要的端口，出口就会顺延，入口不会：
 *
 *   · 1 号走 NEX 隧道、2 号走 GOST 隧道：入口让出口拨的调度器端口要跟出口走；
 *   · 3 号走打开了「出口发送到目标」的 GOST 隧道，流量先进出口桥的守卫：守卫端口也要跟出口走；
 *   · 4 号走负载均衡的 GOST 隧道，两个出口分到的调度器端口不一样：一个目标满足不了两个出口，
 *     退回路径 A —— 修之前入口让 1 号出口拨的端口正好是 3 号规则的调度器，流量会跑进别人的线路；
 *   · 出口一次都没报过（面板刚升级）时入口先按自己算的，和升级前一样；出口报上来以后推入口重算，
 *     出口没变化时不推；
 *   · 出口报过、但还没有这条规则（规则刚建）时，调度器先拨路径 A，出口报上来再换过去；
 *   · 报上来的端口存进库里：面板重启后入口直接按出口的填，不用先变一次再变回来。
 *
 * 起一个真的 sqlite 和真的心跳路由跑一遍。
 */

type Beat = {
  fxpEntry: Record<string, { targetIp: string; targetPort: number }>;
  gostEntry: Record<string, string>;
  schedulers: Record<string, number>;
  guards: Record<string, { listenPort: number; target: string }>;
};
type Outcome = {
  entryFirst: Beat;
  exit: Beat;
  node: Beat;
  entryAfter: Beat;
  entryPlan: { afterEntryBeat: boolean; afterExitReport: boolean; afterSameExitReport: boolean };
  newRuleEntry: Beat;
  newRuleExit: Beat;
  newRuleEntryAfter: Beat;
  entryAfterRestart: Beat;
  persistedHosts: number[];
  settingsLeak: string[];
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-exit-ports-"));
  const databasePath = path.join(directory, "ports.db");
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
    for (const [id, name, ip, token] of [
      [1, "出口", "203.0.113.1", "tok1"],
      [2, "入口", "203.0.113.2", "tok2"],
      [4, "出口节点", "203.0.113.4", "tok4"],
    ]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, "2.2.199", now],
      );
    }
    const tunnel = (id, name, mode, listenPort, extra = {}) => {
      const columns = ["id", "name", '"entryHostId"', '"exitHostId"', "mode", '"listenPort"', '"userId"', '"isEnabled"', ...Object.keys(extra).map((key) => '"' + key + '"')];
      const values = [id, name, 2, 1, mode, listenPort, 1, 1, ...Object.values(extra)];
      return exec("INSERT INTO tunnels (" + columns.join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")", values);
    };
    await tunnel(1, "NEX", "forwardx", 23001);
    await tunnel(2, "GOST", "tls", 23002);
    await tunnel(3, "GOST 出口发 PROXY 头", "tls", 23003, { proxyProtocolExitSend: 1 });
    await tunnel(4, "GOST 负载均衡", "tls", 23004, { loadBalanceEnabled: 1, loadBalanceStrategy: "round_robin" });
    await exec('INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (4, 1, 4, 23104, 1)');

    const direct = (key, dest) => ({ key, name: key, hops: [], dest, weight: 50, probe: null, dial: null });
    const paths = JSON.stringify([direct("main", null), direct("backup", { ip: "198.51.100.9", port: 443 })]);
    for (const id of [1, 2, 3, 4]) {
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort",'
          + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback", "routeMode", "routePaths", "routeSwitchMode", "telegramErrorNotifyEnabled")'
          + ' VALUES (?, 2, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, 1, ?, ?, 10, 60, 1, ?, ?, ?, 0)',
        [id, "route-" + id, "gost", "tcp", 24000 + id, "198.51.100.7", 443, id, 23000 + id, "fallback", "[]", "failover", paths, "smooth"],
      );
    }
    // 出口机上的两条普通规则：正好占掉 1 号规则想要的调度器端口（41001）和 3 号规则想要的守卫端口（39003）。
    for (const [id, sourcePort] of [[50, 41001], [51, 39003]]) {
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1)',
        [id, "busy-" + id, "gost", "tcp", sourcePort, "198.51.100.8", 80],
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
        body: JSON.stringify({ agentVersion: "2.2.199", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      const fxpEntry = {};
      const gostEntry = {};
      for (const action of (body.desiredState && body.desiredState.actions) || []) {
        if (action && action.fxp && action.op === "apply" && action.fxp.role === "entry") {
          fxpEntry[String(action.ruleId)] = { targetIp: String(action.fxp.targetIp), targetPort: Number(action.fxp.targetPort) };
        }
        for (const config of (action && action.managedConfigs) || []) {
          if (!String(config.path || "").endsWith(".json")) continue;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.from(String(config.contentBase64 || ""), "base64").toString("utf8")); } catch { continue; }
          for (const service of (parsed && parsed.services) || []) {
            for (const node of (service.forwarder && service.forwarder.nodes) || []) {
              const match = /^target-(\d+)$/.exec(String(node.name || ""));
              if (match && !String(service.name || "").startsWith("fwx-tunnel-exit")) gostEntry[match[1]] = String(node.addr);
            }
          }
        }
      }
      const schedulers = {};
      for (const rule of body.runningRules || []) {
        if (rule && rule.failover && rule.failover.enabled && Number(rule.tunnelId || 0) > 0) schedulers[String(rule.ruleId)] = Number(rule.failover.listenPort);
      }
      const guards = {};
      for (const guard of body.guardRules || []) {
        if (Number(guard.tunnelId || 0) > 0) guards[String(guard.ruleId)] = { listenPort: Number(guard.listenPort), target: guard.targetIp + ":" + guard.targetPort };
      }
      return { fxpEntry, gostEntry, schedulers, guards };
    };

    // 入口「稳定计划」：放一份假的，看出口报端口以后它有没有被清掉（清掉 = 入口马上重算）。
    const gate = await import(url("server/agentHeartbeatGate.ts"));
    const hash = (c) => c.repeat(64);
    const plan = {
      plannedAt: Date.now(), configRevision: 1, desiredStateHash: hash("a"), localStateSignature: hash("b"),
      stateSignatures: { rules: hash("c") }, agentVersion: "2.2.199", agentBootId: "boot", agentProcessStartedAt: 1,
      defaultNetworkInterface: "eth0", pluginInventorySignature: "", mimicEnvironmentSignature: "", idleNextInterval: 30, panelUrl: "",
    };
    const planMatch = {
      forceReconcile: false, hasBlockingWork: false, recoveryTriggered: false, addressChanged: false, hasDnsChanges: false,
      hasLocalStateUpload: false, hasEndpointEvents: false, localStateSignature: hash("b"), stateSignatures: { rules: hash("c") },
      agentVersion: "2.2.199", agentBootId: "boot", agentProcessStartedAt: 1, defaultNetworkInterface: "eth0",
      pluginInventorySignature: "", mimicEnvironmentSignature: "", agentLastReceivedRevision: 1, agentLastAppliedRevision: 1,
      agentLastReceivedHash: hash("a"), agentLastAppliedHash: hash("a"),
    };
    const planKept = () => !!gate.agentStableHeartbeatPlanCache.match(2, planMatch);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

    const entryFirst = await beat("tok2");
    gate.agentStableHeartbeatPlanCache.remember(2, plan);
    const afterEntryBeat = planKept();
    const exit = await beat("tok1");
    await settle();
    const afterExitReport = planKept();
    const node = await beat("tok4");
    gate.agentStableHeartbeatPlanCache.remember(2, plan);
    await beat("tok1");
    await beat("tok4");
    await settle();
    const afterSameExitReport = planKept();
    const entryAfter = await beat("tok2");

    // 规则刚建：出口报过，但报的里面还没有它。
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback", "routeMode", "routePaths", "routeSwitchMode", "telegramErrorNotifyEnabled")'
        + ' VALUES (5, 2, ?, ?, ?, ?, ?, ?, 1, 1, 1, 2, ?, 1, ?, ?, 10, 60, 1, ?, ?, ?, 0)',
      ["route-5", "gost", "tcp", 24005, "198.51.100.7", 443, 23012, "fallback", "[]", "failover", paths, "smooth"],
    );
    const newRuleEntry = await beat("tok2");
    const newRuleExit = await beat("tok1");
    await settle();
    const newRuleEntryAfter = await beat("tok2");

    // 面板重启：内存清空（包括「上次发给这台 Agent 的配置」），端口从库里读回来。入口在出口来心跳之前就按出口的填。
    const ports = await import(url("server/tunnelExitPorts.ts"));
    await ports.resetTunnelExitPortsForTest({ reload: true });
    for (const hostId of [1, 2, 4]) heartbeat.invalidateAgentDesiredStateCache(hostId);
    const entryAfterRestart = await beat("tok2");
    server.close();

    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const persisted = await settings.getSettingsByPrefix(ports.TUNNEL_EXIT_PORTS_SETTING_PREFIX);
    const persistedHosts = Object.keys(persisted).map((key) => Number(key.slice(ports.TUNNEL_EXIT_PORTS_SETTING_PREFIX.length))).sort((a, b) => a - b);
    settings.invalidateAllSettingsCache();
    const settingsLeak = Object.keys(await settings.getAllSettings()).filter((key) => key.startsWith("runtimeCache:"));
    console.log("OUTCOME " + JSON.stringify({
      entryFirst, exit, node, entryAfter, entryPlan: { afterEntryBeat, afterExitReport, afterSameExitReport },
      newRuleEntry, newRuleExit, newRuleEntryAfter, entryAfterRestart, persistedHosts, settingsLeak,
    }));
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

const pathA = "198.51.100.7:443";

test("前提：出口机的端口被占，顺延了；入口没有", () => {
  assert.deepEqual(outcome.exit.schedulers, { 1: 41002, 2: 41003, 3: 41004, 4: 41005 });
  assert.deepEqual(outcome.exit.guards["3"], { listenPort: 39004, target: "127.0.0.1:41004" }, "出口桥的守卫在出口本机转给调度器");
  assert.deepEqual(outcome.node.schedulers, { 4: 41004 }, "负载均衡的另一个出口没被占");
});

test("出口一次都没报过（刚升级）：入口先按自己算的，和升级前一样", () => {
  assert.deepEqual(outcome.entryFirst.fxpEntry["1"], { targetIp: "127.0.0.1", targetPort: 41001 });
  assert.equal(outcome.entryFirst.gostEntry["2"], "127.0.0.1:41002");
  assert.equal(outcome.entryFirst.gostEntry["3"], "127.0.0.1:39003");
  assert.equal(outcome.entryFirst.gostEntry["4"], "127.0.0.1:41004", "修之前一直是这样：1 号出口上 41004 是 3 号规则的调度器");
});

test("出口报上来以后，入口按出口分到的端口填", () => {
  assert.deepEqual(outcome.entryAfter.fxpEntry["1"], { targetIp: "127.0.0.1", targetPort: 41002 }, "NEX 隧道：握手里的目标");
  assert.equal(outcome.entryAfter.gostEntry["2"], "127.0.0.1:41003", "GOST 隧道：relay 请求里的目标");
  assert.equal(outcome.entryAfter.gostEntry["3"], "127.0.0.1:39004", "出口桥：守卫的端口");
});

test("负载均衡的两个出口分到的调度器端口不一样：一个目标满足不了两个出口，退回路径 A", () => {
  assert.equal(outcome.entryAfter.gostEntry["4"], pathA);
});

test("出口报的端口变了才推入口重算，没变不推", () => {
  assert.equal(outcome.entryPlan.afterEntryBeat, true, "前提：入口的稳定计划放进去了");
  assert.equal(outcome.entryPlan.afterExitReport, false, "出口第一次报上来，入口得重算");
  assert.equal(outcome.entryPlan.afterSameExitReport, true, "出口报的和上次一样，不打扰入口");
});

test("规则刚建、出口还没报它：调度器先拨路径 A，出口报上来再换过去", () => {
  assert.equal(outcome.newRuleEntry.gostEntry["5"], pathA);
  assert.equal(outcome.newRuleExit.schedulers["5"], 41006, "出口上 41005 已经给了 4 号规则");
  assert.equal(outcome.newRuleEntryAfter.gostEntry["5"], "127.0.0.1:41006");
});

test("面板重启后从库里读回出口的端口，入口不用先变一次再变回来", () => {
  assert.deepEqual(outcome.entryAfterRestart.fxpEntry["1"], { targetIp: "127.0.0.1", targetPort: 41002 });
  assert.equal(outcome.entryAfterRestart.gostEntry["2"], "127.0.0.1:41003");
  assert.equal(outcome.entryAfterRestart.gostEntry["3"], "127.0.0.1:39004");
  assert.equal(outcome.entryAfterRestart.gostEntry["4"], pathA);
  assert.equal(outcome.entryAfterRestart.gostEntry["5"], "127.0.0.1:41006");
  assert.deepEqual(outcome.persistedHosts, [1, 4], "只存有出口端口的机器");
  assert.deepEqual(outcome.settingsLeak, [], "运行时缓存不混进系统设置");
});
