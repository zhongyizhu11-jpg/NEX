import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路组走 NEX 隧道。
 *
 * FXP 的出口是整条隧道共用的一个进程，按入口握手里给的目标拨出去（UDP 按面板给出口的
 * udpTargets），调度器只能放在出口机上（server/agentHeartbeatRoute.ts 的 forwardXSchedulerFailover）：
 *
 *   · 入口给 FXP 的目标换成出口本机的调度器（127.0.0.1:端口），入口自己不跑调度器 —— 上一版把
 *     调度器开在入口、又把 127.0.0.1 当目标发给出口，出口拨的是它自己的本机，那里什么都没有；
 *   · 出口机收到一条「只跑调度器」的运行规则（schedulerOnly），出口 FXP 的 UDP 目标表也指向它；
 *   · 开着负载均衡时每个出口各跑一个调度器；
 *   · 调度器在出口，「现在走哪条」和评分是出口机报上来的 —— 只有主出口有权报这条规则；负载均衡的
 *     出口节点不报，不然几个出口的状态互相覆盖；入口不跑调度器，也不能报。
 *
 * 起一个真的 sqlite 和真的心跳路由跑一遍。
 */

type EntryTarget = { targetIp: string; targetPort: number; failover: boolean };
type Scheduler = { sourcePort: number; forwardType: string; failover: any };
type Beat = {
  entry: Record<string, EntryTarget>;
  exitUdpTargets: Record<string, Array<{ ruleId: number; targetIp: string; targetPort: number }>>;
  exitStreamTargets: Record<string, Array<{ ruleId: number; targetIp: string; targetPort: number }>>;
  schedulers: Record<string, Scheduler>;
  runningFailover: Record<string, any>;
};
type Outcome = {
  mainDial: { ip: string; port: number } | null;
  exitBeat: Beat;
  entryBeat: Beat;
  reportable: Record<string, number[]>;
  allowed: boolean;
  schedulerHosts: Record<string, number[]>;
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-route-fxp-"));
  const databasePath = path.join(directory, "routes.db");
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
    const now = Math.floor(Date.now() / 1000);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, name, ip, token, version] of [
      [1, "出口", "203.0.113.1", "tok1", "2.2.251"],
      [2, "入口", "203.0.113.2", "tok2", "2.2.251"],
      [3, "中转", "203.0.113.3", "tok3", "2.2.251"],
      [4, "出口节点", "203.0.113.4", "tok4", "2.2.251"],
    ]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, version, now],
      );
    }
    // 隧道 1：NEX，入口 2、出口 1。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled") VALUES (1, ?, 2, 1, ?, ?, 1, 1)',
      ["NEX 隧道", "forwardx", 23001],
    );
    // 隧道 2：NEX，开着负载均衡，另一个出口是 4 号机。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "loadBalanceEnabled", "loadBalanceStrategy") VALUES (2, ?, 2, 1, ?, ?, 1, 1, 1, ?)',
      ["NEX 负载均衡", "forwardx", 23002, "round_robin"],
    );
    await exec('INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (2, 1, 4, 23102, 1)');
    // 隧道 3：NEX，打开了 PROXY Protocol 的「出口发送到目标」。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "proxyProtocolExitSend") VALUES (3, ?, 2, 1, ?, ?, 1, 1, 1)',
      ["NEX 带 PROXY 头", "forwardx", 23003],
    );

    const direct = (key, dest) => ({ key, name: key, hops: [], dest, weight: 50, probe: null, dial: null });
    const insertRule = (id, tunnelId, protocol, sourcePort, failoverEnabled, paths, mode = "failover", strategy = "fallback") => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "tunnelId",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback", "routeMode", "routePaths", "routeSwitchMode", "telegramErrorNotifyEnabled")'
        + ' VALUES (?, 2, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 10, 60, 1, ?, ?, ?, 0)',
      [id, "fxp-" + id, "gost", protocol, sourcePort, "198.51.100.7", 443, tunnelId, failoverEnabled ? 1 : 0, strategy, "[]", mode, JSON.stringify(paths), "smooth"],
    );
    // 1：TCP+UDP 线路组，主线路经过 3 号中转，备用直连另一个落地。
    await insertRule(1, 1, "both", 24001, true, [
      { key: "main", name: "主线路", hops: [3], dest: null, weight: 50, probe: null, dial: null },
      direct("backup", { ip: "198.51.100.9", port: 443 }),
    ]);
    // 2：同一条隧道上不开线路组的 UDP 规则，什么都不该变。
    await insertRule(2, 1, "udp", 24002, false, []);
    // 3：负载均衡隧道上的 TCP 线路组。
    await insertRule(3, 2, "tcp", 24003, true, [direct("main", null), direct("backup", { ip: "198.51.100.9", port: 443 })]);
    // 4：带 PROXY 头的隧道上按访客固定。
    await insertRule(4, 3, "tcp", 24004, true, [direct("a", null), direct("b", { ip: "198.51.100.9", port: 443 })], "weighted", "ip_hash");

    const routeGroups = await import(url("server/routeGroups.ts"));
    await routeGroups.syncRouteRelayRulesForRule(1, { reason: "test" });
    const ruleRow = (await query('SELECT "routePaths" FROM forward_rules WHERE id = 1'))[0];
    const mainDial = JSON.parse(ruleRow.routePaths).find((item) => item.key === "main").dial || null;

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
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      const actions = (body.desiredState && body.desiredState.actions) || [];
      const entry = {};
      const exitUdpTargets = {};
      const exitStreamTargets = {};
      for (const action of actions) {
        const fxp = action && action.fxp;
        if (!fxp || action.op !== "apply") continue;
        if (fxp.role === "entry") {
          entry[String(action.ruleId)] = { targetIp: String(fxp.targetIp), targetPort: Number(fxp.targetPort), failover: !!action.failover };
        }
        if (fxp.role === "exit") {
          exitUdpTargets[String(action.tunnelId)] = fxp.udpTargets || [];
          exitStreamTargets[String(action.tunnelId)] = fxp.streamTargets || [];
        }
      }
      // runningRules 在心跳回复的顶层（Agent 的 heartbeatResponse），不在 desiredState 里。
      const schedulers = {};
      const runningFailover = {};
      for (const rule of body.runningRules || []) {
        if (rule.schedulerOnly) {
          schedulers[String(rule.ruleId)] = { sourcePort: Number(rule.sourcePort), forwardType: String(rule.forwardType), failover: rule.failover };
        } else if (rule.failover && rule.failover.enabled) {
          runningFailover[String(rule.ruleId)] = rule.failover;
        }
      }
      return { entry, exitUdpTargets, exitStreamTargets, schedulers, runningFailover };
    };
    const exitBeat = await beat("tok1", "2.2.251");
    const entryBeat = await beat("tok2", "2.2.251");
    server.close();

    // 谁有权报这条规则的「现在走哪条」和评分。入口上再放一条不走隧道的线路组规则（101），和一条
    // 隧道已经删掉的（102）：这两条的调度器在入口本机，入口照旧能报。心跳都跑完了才加，不影响上面。
    await insertRule(101, null, "tcp", 24101, true, [direct("a", null), direct("b", { ip: "198.51.100.9", port: 443 })]);
    await insertRule(102, 99, "tcp", 24102, true, [direct("a", null), direct("b", { ip: "198.51.100.9", port: 443 })]);
    const db = await import(url("server/db.ts"));
    const reportable = {};
    for (const hostId of [1, 2, 3, 4]) {
      reportable[hostId] = (await db.getForwardRuleFailoverLinesForAgent(hostId))
        .map((row) => Number(row.id))
        .filter((id) => id <= 4 || id > 100)
        .sort((a, b) => a - b);
    }

    const crud = await import(url("server/routers/rules.crud.ts"));
    let allowed = true;
    try {
      crud.requireMainBackupAllowed({ enabled: true, protocol: "both", forwardType: "gost", tunnelId: 1, tunnelMode: "forwardx", isAdmin: false });
    } catch {
      allowed = false;
    }
    const schedulerHosts = {};
    for (const tunnelId of [1, 2]) {
      schedulerHosts[tunnelId] = crud.routeSchedulerHostIds(2, await db.getTunnelById(tunnelId), await db.getTunnelExitNodes(tunnelId));
    }
    console.log("OUTCOME " + JSON.stringify({ mainDial, exitBeat, entryBeat, reportable, allowed, schedulerHosts }));
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

test("前提：主线路经过中转，解析出了拨号地址", () => {
  assert.ok(outcome.mainDial, "主线路经过中转，应当解析出拨号地址");
  assert.equal(outcome.mainDial!.ip, "203.0.113.3");
});

test("出口机只跑调度器，不占规则端口", () => {
  const scheduler = outcome.exitBeat.schedulers["1"];
  assert.ok(scheduler, "出口机没收到调度器");
  assert.equal(scheduler.forwardType, "route-scheduler");
  assert.equal(scheduler.failover.enabled, true);
  assert.equal(scheduler.sourcePort, scheduler.failover.listenPort, "只跑调度器的运行规则按调度器自己的端口认");
  assert.equal(scheduler.failover.bindAddress, "127.0.0.1");
  assert.equal(scheduler.failover.protocol, "both");
  assert.deepEqual(
    scheduler.failover.targets.map((target: any) => `${target.targetIp}:${target.targetPort}`),
    [`${outcome.mainDial!.ip}:${outcome.mainDial!.port}`, "198.51.100.9:443"],
  );
  assert.equal(scheduler.failover.proxyProtocolReceive, false, "隧道没开「出口发送到目标」时出口不发 PROXY 头");
});

test("入口把 FXP 的目标换成出口本机的调度器，自己不跑调度器", () => {
  const port = outcome.exitBeat.schedulers["1"].failover.listenPort;
  assert.deepEqual(outcome.entryBeat.entry["1"], { targetIp: "127.0.0.1", targetPort: port, failover: false });
  assert.equal(outcome.entryBeat.runningFailover["1"], undefined, "入口不该再起调度器");
  assert.deepEqual(outcome.entryBeat.schedulers, {}, "入口不跑只调度的规则");
});

test("出口 FXP 的 UDP 目标表：线路组规则交给调度器，别的规则照旧", () => {
  const port = outcome.exitBeat.schedulers["1"].failover.listenPort;
  const targets = outcome.exitBeat.exitUdpTargets["1"];
  assert.ok(targets, "出口没收到 FXP 规格");
  assert.deepEqual(targets.find((item) => item.ruleId === 1), { ruleId: 1, targetIp: "127.0.0.1", targetPort: port });
  assert.deepEqual(targets.find((item) => item.ruleId === 2), { ruleId: 2, targetIp: "198.51.100.7", targetPort: 443 });
});

test("出口 FXP 的 TCP 目标表包含入口写进 hello 的目标，出口只拨表里的", () => {
  const tunnelOfRule: Record<string, string> = { "1": "1", "2": "1", "3": "2", "4": "3" };
  const { entryBeat, exitBeat } = outcome;
  assert.ok(Object.keys(entryBeat.entry).length >= 3, "入口的规则太少，这个测试没测到东西");
  for (const [ruleId, target] of Object.entries(entryBeat.entry)) {
    const targets = exitBeat.exitStreamTargets[tunnelOfRule[ruleId]];
    assert.ok(targets, `出口没收到隧道 ${tunnelOfRule[ruleId]} 的 FXP 规格`);
    assert.ok(
      targets.some((item) => item.ruleId === Number(ruleId) && item.targetIp === target.targetIp && item.targetPort === target.targetPort),
      `出口的目标表里没有规则 ${ruleId} 的 ${target.targetIp}:${target.targetPort}：${JSON.stringify(targets)}`,
    );
  }
  assert.ok(
    outcome.exitBeat.exitStreamTargets["1"].every((item) => [1, 2].includes(item.ruleId)),
    "别的隧道的规则不该出现在这条隧道出口的目标表里",
  );
});

test("不开线路组的规则：入口照旧把规则目标给出口，出口没有调度器", () => {
  assert.deepEqual(outcome.entryBeat.entry["2"], { targetIp: "198.51.100.7", targetPort: 443, failover: false });
  assert.equal(outcome.exitBeat.schedulers["2"], undefined);
});

test("负载均衡隧道：每个出口各跑一个调度器，入口让出口拨本机的调度器", () => {
  const scheduler = outcome.exitBeat.schedulers["3"];
  assert.ok(scheduler, "主出口没收到调度器");
  assert.deepEqual(outcome.entryBeat.entry["3"], { targetIp: "127.0.0.1", targetPort: scheduler.failover.listenPort, failover: false });
  assert.deepEqual(outcome.schedulerHosts["2"], [1, 4], "两个出口都跑调度器");
  assert.deepEqual(outcome.schedulerHosts["1"], [1]);
});

test("按访客固定：隧道打开「出口发送到目标」时，调度器从出口发的 PROXY 头里读访客，头原样转给落地", () => {
  const scheduler = outcome.exitBeat.schedulers["4"];
  assert.ok(scheduler, "出口机没收到调度器");
  assert.equal(scheduler.failover.strategy, "ip_hash");
  assert.equal(scheduler.failover.proxyProtocolReceive, true);
  assert.equal(scheduler.failover.proxyProtocolSend, true);
  assert.equal(scheduler.failover.proxyProtocolStrip, undefined, "头是给落地的，不能扔");
  assert.deepEqual(outcome.entryBeat.entry["4"], { targetIp: "127.0.0.1", targetPort: scheduler.failover.listenPort, failover: false });
});

test("只有主出口有权报隧道上的线路组，入口、负载均衡的出口节点和中转机没有", () => {
  assert.deepEqual(outcome.reportable["1"], [1, 2, 3, 4], "主出口");
  assert.deepEqual(outcome.reportable["4"], [], "出口节点也跑调度器，但一条规则只有一份状态，几个出口一起报会互相覆盖");
  assert.deepEqual(outcome.reportable["2"], [101, 102], "入口不跑隧道规则的调度器，不能报；不走隧道的、隧道已经不在的照旧");
  assert.deepEqual(outcome.reportable["3"], [], "中转机只报它自己的中继规则");
});

test("保存时放开 NEX 隧道", () => {
  assert.equal(outcome.allowed, true);
});
