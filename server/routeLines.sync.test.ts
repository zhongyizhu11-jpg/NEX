import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路（2.3.496）落到机器上：
 *   · 隧道段：中继规则建在隧道入口那台（这里是入口机自己），走这条隧道、在隧道端口区间里监听，
 *     出口机自己不建中继；入口调度器拨 127.0.0.1（云厂商 NAT 不让机器连自己的公网地址）。
 *   · 节点池：池里加一台机器，用到它的线路重新展开，多出一条路径和一条中继。
 *   · 心跳下发：整链的下游延迟、暂停 / 维护提示都带上；tier 只在聚合 / 复制时带（整链最优要在所有线路里比）。
 * 起一个真的 sqlite 跑一遍。
 */

type Outcome = {
  relays: Array<{ hostId: number; sourcePort: number; targetIp: string; targetPort: number; routePathKey: string; routeHopIndex: number; tunnelId: number | null; tunnelExitPort: number | null }>;
  paths: Array<{ key: string; dial: { ip: string; port: number } | null; issue: string | null; tier?: number; lineKey?: string; hopVia?: Array<number | null> }>;
  expanded: { pathCount: number; keys: string[] };
  afterPool: { pathCount: number; relayHosts: number[] };
  spec: any;
  aggregateSpec: any;
  pausedSpec: any;
  maintenanceSpec: any;
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-route-lines-"));
  const databasePath = path.join(directory, "lines.db");
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
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    // 1 入口；2、4 中转；3 隧道出口
    for (const [id, name, ip, token] of [[1, "入口机", "203.0.113.1", "tok1"], [2, "jinx", "203.0.113.2", "tok2"], [3, "Jinx出口", "203.0.113.3", "tok3"], [4, "HK2", "203.0.113.4", "tok4"]]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)', [id, name, ip, ip, "slave", token, Math.floor(Date.now() / 1000), "2.2.243"]);
    }
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", secret, "userId", "isEnabled", "portRangeStart", "portRangeEnd") VALUES (10, ?, 1, 3, ?, 30000, ?, 1, 1, 31000, 31999)', ["华南-香港", "tcp", "s3cret"]);
    const pools = await import(url("server/nodePools.ts"));
    const poolId = await pools.createNodePool({ userId: 1, name: "香港中转池", role: "relay", hostIds: [2] });
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "failoverEnabled", "failoverStrategy", "failoverTargets", "routeMode", "routePaths", "routeSwitchMode")'
        + ' VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?)',
      ["广港hkt", "gost", "tcp", 44760, "198.51.100.7", 24895, "fallback", "[]", "smart", "[]", "smooth"],
    );
    const lines = [
      { key: "main", name: "主线路", layers: [{ kind: "tunnel", tunnelIds: [10], pick: "order" }], dests: [] },
      { key: "bk", name: "备用", layers: [{ kind: "pool", poolId, pick: "best" }], dests: [] },
    ];
    const expansion = await import(url("server/routeLineExpansion.ts"));
    const input = await expansion.expandRouteGroupInputLines({ routeGroup: { lines, mode: "smart", paths: [] } }, { id: 1, role: "admin" }, 1, null);
    const routeGroupShared = await import(url("shared/routeGroup.ts"));
    const routeLinesShared = await import(url("shared/routeLines.ts"));
    const expandedPaths = input.routeGroup.paths;
    await exec('UPDATE forward_rules SET "routePaths" = ?, "routeLines" = ? WHERE id = 1', [JSON.stringify(expandedPaths), routeLinesShared.serializeRouteLines(routeLinesShared.parseRouteLines(lines))]);
    const routeGroups = await import(url("server/routeGroups.ts"));
    await routeGroups.syncRouteRelayRulesForRule(1, { reason: "test" });
    const readRelays = () => query('SELECT "hostId", "sourcePort", "targetIp", "targetPort", "routePathKey", "routeHopIndex", "tunnelId", "tunnelExitPort" FROM forward_rules WHERE "routeParentRuleId" = 1 AND "pendingDelete" = 0 ORDER BY "routePathKey", "routeHopIndex"');
    const relays = await readRelays();
    const storedPaths = JSON.parse((await query('SELECT "routePaths" FROM forward_rules WHERE id = 1'))[0].routePaths);

    // 池里加一台：重新展开，备用多出一条路径。
    await pools.updateNodePool(poolId, { hostIds: [2, 4] });
    await expansion.reexpandRouteLinesForRules(await pools.ruleIdsUsingPool(poolId), "test-pool");
    const afterPaths = JSON.parse((await query('SELECT "routePaths" FROM forward_rules WHERE id = 1'))[0].routePaths);
    const afterRelays = await readRelays();

    // 心跳：入口机拿到的调度规格。
    const express = (await import("express")).default;
    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { const a = String(req.headers.authorization || ""); req.agentToken = a.startsWith("Bearer ") ? a.slice(7) : ""; next(); });
    heartbeat.registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const beat = async () => {
      const response = await fetch(base + "/api/agent/heartbeat", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok1" }, body: JSON.stringify({ agentVersion: "2.2.243", uptime: 10, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }) });
      const json = await response.json();
      const actions = (json.desiredState && json.desiredState.actions) || [];
      const found = actions.find((action) => action && action.failover && action.failover.enabled);
      return found ? found.failover : null;
    };
    const stats = await import(url("server/routeGroupStats.ts"));
    // 备用那条第一跳之后（中转 → 落地）测到 7ms：下发的 extraLatencyMs 要带上。
    const bkPath = afterPaths.find((p) => p.lineKey === "bk" && p.hops[0] === 2);
    stats.recordRouteHopProbe({ parentRuleId: 1, pathKey: bkPath.key, hopIndex: 0, hostId: 2, hostName: "jinx", nextLabel: "落地", ok: true, latencyMs: 7 });
    const spec = await beat();
    // 聚合：主线路那组一起分担、备用只兜底 —— 这时才分层
    await exec('UPDATE forward_rules SET "routeDelivery" = ? WHERE id = 1', ["aggregate"]);
    const aggregateSpec = await beat();
    await exec('UPDATE forward_rules SET "routeDelivery" = ? WHERE id = 1', ["cold"]);
    // 暂停备用那条线路
    const paused = afterPaths.map((p) => (p.lineKey === "bk" ? { ...p, paused: true } : p));
    await exec('UPDATE forward_rules SET "routePaths" = ? WHERE id = 1', [JSON.stringify(paused)]);
    const pausedSpec = await beat();
    await exec('UPDATE forward_rules SET "routePaths" = ? WHERE id = 1', [JSON.stringify(afterPaths)]);
    // 维护 HK2
    const health = await import(url("server/routeNodeHealth.ts"));
    await exec('UPDATE hosts SET "maintenanceMode" = 1 WHERE id = 4');
    health.invalidateRouteNodeHealth();
    const maintenanceSpec = await beat();
    server.close();
    console.log("LINES " + JSON.stringify({
      relays, paths: storedPaths,
      expanded: { pathCount: expandedPaths.length, keys: expandedPaths.map((p) => p.key) },
      afterPool: { pathCount: afterPaths.length, relayHosts: afterRelays.map((r) => Number(r.hostId)) },
      spec, aggregateSpec, pausedSpec, maintenanceSpec,
    }));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory },
    timeout: 180000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("LINES "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("LINES ".length)) as Outcome;
}

const outcome = run();

test("隧道段：中继建在入口机上、走这条隧道、在隧道端口区间里；入口调度器拨 127.0.0.1", () => {
  const tunnelRelay = outcome.relays.find((relay) => relay.tunnelId === 10);
  assert.ok(tunnelRelay, `应该有一条走隧道的中继：${JSON.stringify(outcome.relays)}`);
  assert.equal(tunnelRelay!.hostId, 1);
  assert.equal(tunnelRelay!.routeHopIndex, 99);
  assert.ok(tunnelRelay!.sourcePort >= 31000 && tunnelRelay!.sourcePort <= 31999, `端口 ${tunnelRelay!.sourcePort} 不在隧道区间`);
  assert.equal(tunnelRelay!.targetIp, "198.51.100.7");
  assert.equal(tunnelRelay!.targetPort, 24895);
  assert.ok(Number(tunnelRelay!.tunnelExitPort) > 0, "隧道出口要有收这条中继的端口");
  // 出口机（3）自己不建中继
  assert.ok(!outcome.relays.some((relay) => relay.hostId === 3), "隧道出口机不该有中继");
  const main = outcome.paths.find((path) => path.lineKey === "main")!;
  assert.deepEqual(main.dial, { ip: "127.0.0.1", port: tunnelRelay!.sourcePort });
  assert.deepEqual(main.hopVia, [10]);
  assert.equal(main.tier, 0);
});

test("节点池：池里的机器当候选；池里加一台，线路重新展开、多出一条路径和中继", () => {
  assert.equal(outcome.expanded.pathCount, 2);
  assert.equal(outcome.afterPool.pathCount, 3);
  assert.ok(outcome.afterPool.relayHosts.includes(4), `HK2 上应该有新中继：${JSON.stringify(outcome.afterPool.relayHosts)}`);
  assert.ok(outcome.afterPool.relayHosts.includes(2));
});

test("心跳：整链最优不分层（所有线路一起比），聚合才带 tier；备用带下游延迟；暂停 / 维护的路径标成用不了", () => {
  const targets = outcome.spec.targets as any[];
  assert.equal(targets.length, 3);
  assert.equal(outcome.spec.preferFastest, true);
  assert.deepEqual(targets.map((target) => target.tier), [undefined, undefined, undefined], "整链最优带着分层，Agent 只在主线路里挑，备用再快也切不过去");
  assert.deepEqual((outcome.aggregateSpec.targets as any[]).map((target) => target.tier), [0, 1, 1], "聚合：主线路那组一起分担，备用组兜底");
  assert.ok(targets.some((target) => target.extraLatencyMs === 7), `下游延迟没下发：${JSON.stringify(targets)}`);
  assert.ok(targets.every((target) => !target.down));
  const paused = outcome.pausedSpec.targets as any[];
  assert.deepEqual(paused.map((target) => !!target.down), [false, true, true]);
  assert.ok(paused.slice(1).every((target) => target.downReason === "paused"));
  const maintenance = outcome.maintenanceSpec.targets as any[];
  assert.equal(maintenance.filter((target) => target.down && String(target.downReason).startsWith("maintenance:")).length, 1);
});
