import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 入口机的运行状态被清掉之后（resetAgentRuntimeStateForHost：主机地址变了、短暂掉线……），
 * 隧道和隧道入口规则怎么回到「在运行」。
 *
 * 2026-11 真机联调：入口机出口 IP 每几分钟轮换一次，每次都把它当入口的隧道（tunnels.isRunning）和
 * 上面的入口规则一起清掉。规则要等隧道在跑才按本机监听恢复（agentHeartbeatTunnelRuleRecovery.test.ts），
 * 可隧道这边没人再报：FXP 隧道的出口动作只看「出口报过的运行状态」（内存里，只清地址变了的那台），
 * 不重下发、出口不再报；入口的 Agent 配置没变也不再报。只能碰运气等入口的隧道测速把隧道写回来，
 * 而那时入口机已经走上稳定快路径，完整对账（含恢复）要 5 分钟后才再跑 —— 下一次清除来得更早，
 * 规则 8 一轮轮一直是「没在运行」，流量其实是通的。
 *
 * 这里用真 sqlite + 真心跳路由，先把库摆成「刚被清过」的样子，再按真实顺序发心跳：
 *   1. 出口报过在跑（内存里有）的单跳隧道：第一次完整心跳就按出口的报告恢复隧道，规则跟着恢复；
 *   2. 出口没报过 / 报的是没在跑：隧道和规则都保持没在运行（不糊过去）；
 *   3. 规则在等的隧道从别的路回来（这里模拟入口的隧道测速写库）：入口机下一次心跳不能再走稳定快路径，
 *      规则当场恢复。
 *
 * 去掉修复验证过会失败：去掉「按出口报告恢复隧道」那一段，第 1 组断言失败（隧道 1、4 和规则 1、4 仍是 0）；
 * 去掉 updateTunnelRunningStatus 里的 noteTunnelRunningRestored，第 3 组断言失败（第三次心跳走了快路径，规则 2 仍是 0）。
 */

type Outcome = {
  first: { tunnels: Record<string, number>; rules: Record<string, number> };
  stableBeforeRestore: boolean;
  afterRestore: { stable: boolean; rules: Record<string, number> };
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-tunnel-recovery-after-reset-"));
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
    // 全部是「刚被清过」：隧道和规则都写成没在运行。入口 2，出口 1。
    const tunnel = (id, listenPort, version) => exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "forwardxVersion", "listenPort", "userId", "isEnabled", "isRunning") VALUES (?, ?, 2, 1, ?, ?, ?, 1, 1, 0)',
      [id, "t" + id, "forwardx", version, listenPort],
    );
    await tunnel(1, 23001, "v3"); // 出口报过在跑
    await tunnel(2, 23002, "v1"); // 出口还没报过（面板刚重启 / 出口也被清过）
    await tunnel(3, 23003, "v1"); // 出口报的是没在跑
    await tunnel(4, 23004, "v2"); // 出口报过在跑；上面是 UDP 规则
    const rule = (id, port, tunnelId, protocol) => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort") VALUES (?, 2, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)',
      [id, "rule-" + id, "gost", protocol, port, "198.51.100.7", 443, tunnelId, 23000 + tunnelId],
    );
    await rule(1, 24001, 1, "tcp");
    await rule(2, 24002, 2, "tcp");
    await rule(3, 24003, 3, "tcp");
    await rule(4, 24004, 4, "udp");

    // 出口那台以前报过的运行状态（agentStatusRoutes 记在内存里；入口的清除不动它）。
    const status = await import(url("server/tunnelRuntimeStatus.ts"));
    status.recordTunnelRuntimeHostStatus(1, 1, true);
    status.recordTunnelRuntimeHostStatus(3, 1, false);
    status.recordTunnelRuntimeHostStatus(4, 1, true);

    const express = (await import("express")).default;
    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const gate = await import(url("server/agentHeartbeatGate.ts"));
    const repo = await import(url("server/repositories/tunnelRepository.ts"));
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
    const local = (ruleId, port, tunnelId, transportVersion, protocol) => ({ port, ruleId, tunnelId, forwardType: "forwardx", transportVersion, targetIp: "198.51.100.7", targetPort: 443, protocol, ready: true });
    const localState = {
      rules: [
        local(1, 24001, 1, "v3", "tcp"),
        local(2, 24002, 2, "v1", "tcp"),
        local(3, 24003, 3, "v1", "tcp"),
        local(4, 24004, 4, "v2", "udp"),
      ],
      tunnels: [],
      services: [],
      wireGuardPlanes: [{ tunnelId: 4, plane: "netstack" }],
    };
    // 像真的 Agent 一样：收到期望状态就当执行完，下一次心跳报回版本和摘要；本机状态只在第一次整份上传，之后只带签名。
    let applied = { revision: 0, hash: "" };
    let stateSignatures = {};
    const send = async (withLocalState) => {
      // 测试里心跳一个接一个：跳过「刚对过账就合并」的 5 秒闸门（不能用 forceReconcile，它会顺带关掉稳定快路径）。
      gate.agentHeartbeatGate["completedAt"].clear();
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok2" },
        body: JSON.stringify({
          agentVersion: "2.2.257", fxpVersion: "2.2.141", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1,
          agentBootId: "boot-1", agentProcessId: 4242, agentProcessStartedAt: now - 600,
          localStateSignature: "a1b2c3d4e5f60718",
          ...(withLocalState ? { localState } : {}),
          stateSignatures,
          agentLastReceivedRevision: applied.revision, agentLastAppliedRevision: applied.revision,
          agentLastReceivedHash: applied.hash, agentLastAppliedHash: applied.hash,
        }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      if (body.desiredState) applied = { revision: Number(body.desiredState.configRevision) || 0, hash: String(body.desiredState.configHash || "") };
      if (body.stateSignatures) stateSignatures = body.stateSignatures;
      // 稳定快路径的回复里没有 stateSignatures（见 agentHeartbeatRoute 的 stablePlan 分支）。
      return { stable: !body.stateSignatures };
    };
    const snapshot = async () => ({
      tunnels: Object.fromEntries((await runtime.queryRaw('SELECT id, "isRunning" FROM tunnels ORDER BY id')).map((row) => [String(row.id), Number(row.isRunning)])),
      rules: Object.fromEntries((await runtime.queryRaw('SELECT id, "isRunning" FROM forward_rules ORDER BY id')).map((row) => [String(row.id), Number(row.isRunning)])),
    });

    await send(true);
    const first = await snapshot();
    // 再发几次，直到入口机走上稳定快路径（真机上就是这样：规则 2 在等隧道，计划却已经「稳定」了）。
    let stableBeforeRestore = false;
    for (let attempt = 0; attempt < 6 && !stableBeforeRestore; attempt += 1) {
      stableBeforeRestore = (await send(false)).stable;
    }
    // 隧道 2 从别的路回来：入口的隧道测速成功写库（agentReportRoutes），这条路不去敲入口机。
    await repo.updateTunnelRunningStatus(2, true);
    const next = await send(false);
    const afterRestore = { stable: next.stable, rules: (await snapshot()).rules };
    server.close();
    console.log("OUTCOME " + JSON.stringify({ first, stableBeforeRestore, afterRestore }));
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

test("清除后的第一次完整心跳：出口报过在跑的单跳隧道按出口报告恢复，上面的规则跟着恢复（含 V2 UDP）", () => {
  assert.equal(outcome.first.tunnels["1"], 1, "V3 隧道，出口报过在跑");
  assert.equal(outcome.first.rules["1"], 1, "V3 隧道上的规则");
  assert.equal(outcome.first.tunnels["4"], 1, "V2 隧道，出口报过在跑");
  assert.equal(outcome.first.rules["4"], 1, "V2 隧道上的 UDP 规则");
});

test("出口没报过、或报的是没在跑：隧道和规则都照旧没在运行", () => {
  assert.equal(outcome.first.tunnels["2"], 0, "出口没报过");
  assert.equal(outcome.first.rules["2"], 0);
  assert.equal(outcome.first.tunnels["3"], 0, "出口报的是没在跑");
  assert.equal(outcome.first.rules["3"], 0);
  assert.equal(outcome.afterRestore.rules["3"], 0, "隧道 3 一直没回来，规则 3 也一直不恢复");
});

test("规则在等的隧道从别的路回来：入口机下一次心跳不走稳定快路径，规则当场恢复", () => {
  assert.equal(outcome.stableBeforeRestore, true, "前提：入口机已经走上稳定快路径（否则这一组测不到东西）");
  assert.equal(outcome.afterRestore.stable, false, "隧道回来后这一次心跳要走完整对账");
  assert.equal(outcome.afterRestore.rules["2"], 1, "规则 2 按本机监听恢复");
});

test("在等的隧道表：每次心跳整份替换，不再等的主机隧道回来时不受影响", async () => {
  const gate = await import("./agentHeartbeatGate");
  const plan = (hostId: number) => gate.agentStableHeartbeatPlanCache.remember(hostId, {
    plannedAt: Date.now(),
    configRevision: 1,
    desiredStateHash: "aa",
    localStateSignature: "bb",
    stateSignatures: { runningRules: "cc" },
    agentVersion: "2.2.257",
    agentBootId: "",
    agentProcessStartedAt: 0,
    defaultNetworkInterface: "",
    pluginInventorySignature: "",
    mimicEnvironmentSignature: "",
    idleNextInterval: 60,
    panelUrl: "",
  });
  const planned = (hostId: number) => gate.agentStableHeartbeatPlanCache.match(hostId, {
    localStateSignature: "bb",
    stateSignatures: { runningRules: "cc" },
    agentVersion: "2.2.257",
    agentBootId: "",
    agentProcessStartedAt: 0,
    defaultNetworkInterface: "",
    pluginInventorySignature: "",
    mimicEnvironmentSignature: "",
    agentLastReceivedRevision: 1,
    agentLastAppliedRevision: 1,
    agentLastReceivedHash: "aa",
    agentLastAppliedHash: "aa",
  }) !== null;
  gate.rememberHostWaitingForTunnels(901, [71, 72]);
  gate.rememberHostWaitingForTunnels(902, [71]);
  gate.rememberHostWaitingForTunnels(901, [72]); // 主机 901 不再等 71
  plan(901);
  plan(902);
  assert.deepEqual(gate.noteTunnelRunningRestored(71), [902]);
  assert.equal(planned(901), true, "901 已经不等 71，稳定快路径保留");
  assert.equal(planned(902), false, "902 在等 71，稳定快路径作废");
  assert.deepEqual(gate.noteTunnelRunningRestored(71), [], "通知过一次就清掉");
  assert.deepEqual(gate.noteTunnelRunningRestored(72), [901]);
  gate.rememberHostWaitingForTunnels(901, []);
  assert.deepEqual(gate.noteTunnelRunningRestored(72), []);
});
