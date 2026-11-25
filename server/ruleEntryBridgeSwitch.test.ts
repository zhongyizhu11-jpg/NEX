import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 换隧道后旧入口的临时桥接，从头到尾走一遍真的 sqlite、真的规则编辑接口、真的心跳 / 状态 / 流量路由。
 *
 *   隧道 A：Po0(1) → Jinx(3)；隧道 B：Po01(2) → Jinx；隧道 C：Po02(4) → Jinx。
 *   规则 10 在隧道 A 上，TCP+UDP，端口 40981。
 *
 *   1. A → B：Po0 的老端口留一条 iptables 桥接，转到 Po01 的入口地址:40981，TCP、UDP 都转；
 *      Po01 起规则本身；别的规则不能拿 Po0:40981，报错说清楚是桥接占着。
 *   2. 桥接的运行状态、流量按桥接编号上报：状态记到桥接上，流量一字节都不记账。
 *   3. B → C：Po0 的桥接改指 Po02，Po01 也留一条；两条桥接的到期时间都从这次切换重新算。
 *   4. C → A：规则回到 Po0，Po0 上的桥接让位（删掉），规则照常在 Po0 起。
 *   5. 到期的桥接不再下发，Agent 上那个监听被当成孤儿撤掉；调度器的清理把行删掉。
 *   6. 删规则：它剩下的桥接一起删。
 */

type Action = Record<string, any>;
type Outcome = Record<string, any>;

const BRIDGE_BASE = 2_000_000_000;

function run(): Outcome {
  const result = runInDatabase(String.raw`
    const http = (await import("node:http")).default;
    const express = (await import("express")).default;

    const now = Math.floor(Date.now() / 1000);
    const target = "landing.forwardx.invalid";
    const out = {};

    await exec("INSERT INTO users (id, username, password, role, canAddRules, manualCanAddRules, accountEnabled, allowProxySubscription, manualAllowProxySubscription, trafficUsed) VALUES (1, 'admin', 'hash', 'admin', 1, 1, 1, 1, 1, 0)");
    for (const [id, name, ip, token] of [[1, "Po0", "203.0.113.1", "tok1"], [2, "Po01", "203.0.113.2", "tok2"], [3, "Jinx", "203.0.113.3", "tok3"], [4, "Po02", "203.0.113.4", "tok4"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, "2.2.204", now],
      );
    }
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", secret, "isRunning") VALUES (1, ?, 1, 3, ?, ?, 1, 1, ?, 1)', ["A", "forwardx", 46795, "secret-a"]);
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", secret, "isRunning") VALUES (2, ?, 2, 3, ?, ?, 1, 1, ?, 1)', ["B", "forwardx", 46796, "secret-b"]);
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", secret, "isRunning") VALUES (3, ?, 4, 3, ?, ?, 1, 1, ?, 1)', ["C", "forwardx", 46797, "secret-c"]);
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId") VALUES (10, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)',
      ["rule-10", "gost", "both", 40981, target, 19001],
    );

    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const statusRoutes = await import(url("server/agentStatusRoutes.ts"));
    const reportRoutes = await import(url("server/agentReportRoutes.ts"));
    const db = await import(url("server/db.ts"));
    const bridges = await import(url("server/ruleEntryBridges.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    heartbeat.registerAgentHeartbeatRoute(app);
    statusRoutes.registerAgentStatusRoutes(app);
    reportRoutes.registerAgentReportRoutes(app);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = "http://127.0.0.1:" + server.address().port;

    // 每台机器上报它此刻在跑的东西，面板按它决定撤谁、起谁。
    const running = {
      tok1: { rules: [{ port: 40981, ruleId: 10, tunnelId: 1, forwardType: "forwardx", protocol: "both", transportVersion: "v1" }], tunnels: [], services: [] },
      tok2: { rules: [], tunnels: [], services: [] },
      tok3: { rules: [], tunnels: [], services: [] },
      tok4: { rules: [], tunnels: [], services: [] },
    };
    const post = async (route, token, body) => {
      const response = await fetch(base + route, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: response.status, body: json ?? text };
    };
    const beat = async (token) => {
      const response = await post("/api/agent/heartbeat", token, {
        agentVersion: "2.2.204", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true, localState: running[token],
      });
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(response.body));
      const actions = (response.body.desiredState && response.body.desiredState.actions) || [];
      return actions
        .filter((action) => Number(action.ruleId) > 0)
        .map((action) => ({
          op: action.op,
          ruleId: Number(action.ruleId),
          tunnelId: Number(action.tunnelId || 0),
          forwardType: action.forwardType,
          sourcePort: Number(action.sourcePort),
          targetIp: action.targetIp,
          targetPort: Number(action.targetPort),
          protocol: action.protocol,
          fxpRole: action.fxp ? action.fxp.role : null,
          // 只留 DNAT 那几行：整份命令很长，结果要从子进程的 stdout 里原样读回来。
          dnat: (action.commands || []).filter((line) => line.includes("DNAT --to-destination")).join("\n"),
          // 桥接接管 / 规则收回端口时清 conntrack 老流的那几行。
          conntrackFlush: [...(action.preCommands || []), ...(action.commands || [])].filter((line) => line.includes("conntrack -D")).join("\n"),
        }));
    };
    const bridgeRows = async () => (await query('SELECT id, "ruleId", "hostId", "sourcePort", protocol, "isRunning", "runtimeTarget", "expiresAt" FROM forward_rule_entry_bridges ORDER BY id'))
      .map((row) => ({ ...row, id: Number(row.id), hostId: Number(row.hostId), sourcePort: Number(row.sourcePort), isRunning: Number(row.isRunning), expiresAt: Number(row.expiresAt) }));

    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
    const caller = rulesRouter.createCaller(context);
    const switchTo = (tunnelId, hostId) => caller.update({
      id: 10, hostId, name: "rule-10", forwardType: "gost", protocol: "both", gostMode: "direct", gostRelayHost: null, gostRelayPort: null,
      tunnelId, forwardGroupId: null, sourcePort: 40981, isEnabled: true, targetIp: target, targetPort: 19001,
      telegramErrorNotifyEnabled: false, failoverEnabled: false, routeGroup: null,
    });

    out.defaultHours = await db.getRuleSwitchBridgeHours();
    out.beforeSwitch = await beat("tok1");

    // ---- 1. A → B ----
    out.switchAB = await switchTo(2, 1);
    out.rowsAfterAB = await bridgeRows();
    out.ruleAfterAB = (await query('SELECT "hostId", "tunnelId" FROM forward_rules WHERE id = 10'))[0];
    out.po0AfterAB = await beat("tok1");
    out.po01AfterAB = await beat("tok2");
    out.bridgeListed = (await caller.getById({ id: 10 }))?.entryBridges || null;
    out.portUsedOnPo0 = await db.isPortUsedOnHost(1, 40981, undefined, "tcp");
    out.portUsedOnPo0ForOwner = await db.isPortUsedOnHost(1, 40981, [10], "tcp");
    out.usedPortsOnPo0 = Array.from(await db.getUsedPortsOnHost(1));
    try {
      await caller.create({ hostId: 1, name: "thief", forwardType: "iptables", protocol: "tcp", sourcePort: 40981, targetIp: "198.51.100.9", targetPort: 80 });
      out.createConflict = "created";
    } catch (error) {
      out.createConflict = String(error && error.message || error);
    }

    // ---- 2. 状态和流量 ----
    const bridgeRuleId = ${BRIDGE_BASE} + out.rowsAfterAB[0].id;
    out.statusReport = await post("/api/agent/rule-status", "tok1", { ruleId: bridgeRuleId, tunnelId: 0, statusType: "rule", sourcePort: 40981, targetPort: 40981, isRunning: true, forwardType: "iptables", protocol: "both", issuedAt: Date.now() });
    out.statusFromWrongHost = await post("/api/agent/rule-status", "tok2", { ruleId: bridgeRuleId, tunnelId: 0, statusType: "rule", sourcePort: 40981, isRunning: false, forwardType: "iptables", protocol: "both", issuedAt: Date.now() + 1 });
    out.rowsAfterStatus = await bridgeRows();
    // Agent 已经按桥接跑起来了：再心跳一次不该再下发一遍。
    running.tok1 = { rules: [{ port: 40981, ruleId: bridgeRuleId, tunnelId: 0, forwardType: "iptables", protocol: "both", targetIp: "203.0.113.2", targetPort: 40981 }], tunnels: [], services: [] };
    out.po0Steady = await beat("tok1");
    out.trafficReport = await post("/api/agent/traffic", "tok1", { reportId: "r-1", reportProducerId: "p-1", stats: [{ ruleId: bridgeRuleId, bytesIn: 1000000, bytesOut: 2000000, connections: 3 }] });
    out.trafficUsed = Number((await query('SELECT "trafficUsed" FROM users WHERE id = 1'))[0].trafficUsed || 0);
    out.trafficStatRows = Number((await query('SELECT COUNT(*) AS count FROM traffic_stats'))[0].count);
    out.ruleCounterRows = Number((await query('SELECT COUNT(*) AS count FROM forward_rule_traffic_counters'))[0].count);

    // ---- 3. B → C：先把 Po0 的桥接做旧，看切换是不是把它的计时一起重置了 ----
    await exec('UPDATE forward_rule_entry_bridges SET "expiresAt" = ?', [now + 120]);
    out.switchBC = await switchTo(3, 2);
    out.rowsAfterBC = await bridgeRows();
    out.po0AfterBC = await beat("tok1");
    out.po01AfterBC = await beat("tok2");
    out.po02AfterBC = await beat("tok4");

    // ---- 4. C → A：回到 Po0 ----
    out.switchCA = await switchTo(1, 4);
    out.rowsAfterCA = await bridgeRows();
    out.po0AfterCA = await beat("tok1");

    // ---- 5. 到期 ----
    const po01Bridge = out.rowsAfterCA.find((row) => row.hostId === 2);
    running.tok2 = { rules: [{ port: 40981, ruleId: ${BRIDGE_BASE} + po01Bridge.id, tunnelId: 0, forwardType: "iptables", protocol: "both", targetIp: "203.0.113.1", targetPort: 40981 }], tunnels: [], services: [] };
    out.po01BeforeExpiry = await beat("tok2");
    await exec('UPDATE forward_rule_entry_bridges SET "expiresAt" = ? WHERE id = ?', [now - 10, po01Bridge.id]);
    out.po01Expired = await beat("tok2");
    out.portUsedAfterExpiry = await db.isPortUsedOnHost(2, 40981, undefined, "tcp");
    out.sweptHosts = await bridges.sweepExpiredRuleEntryBridges();
    out.rowsAfterSweep = await bridgeRows();

    // ---- 6. 删规则 ----
    await caller.delete({ id: 10 });
    out.rowsAfterDelete = await bridgeRows();

    server.close();
    // 等 stdout 写完再退：管道满的时候直接 exit 会把结果截断。
    console.log("OUTCOME " + JSON.stringify(out));
  `, { name: "entry-bridge" });
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = run();
const bridgeApplies = (actions: Action[]) => actions.filter((action) => action.op === "apply" && action.ruleId > BRIDGE_BASE);
const nowSeconds = () => Math.floor(Date.now() / 1000);

test("默认保留 1 小时", () => {
  assert.equal(outcome.defaultHours, 1);
});

test("前提：换之前规则 10 在 Po0 上以隧道入口跑着，没有桥接", () => {
  assert.equal(bridgeApplies(outcome.beforeSwitch).length, 0);
});

test("A → B：规则挪到 Po01，Po0 的老端口留一条桥接", () => {
  assert.equal(outcome.switchAB.success, true);
  assert.equal(Number(outcome.ruleAfterAB.hostId), 2);
  assert.equal(outcome.rowsAfterAB.length, 1);
  const [row] = outcome.rowsAfterAB;
  assert.equal(row.hostId, 1);
  assert.equal(row.sourcePort, 40981);
  assert.equal(row.protocol, "both");
  // 到期 = 现在 + 1 小时（允许测试本身跑几十秒）
  assert.ok(Math.abs(row.expiresAt - (nowSeconds() + 3600)) < 120, String(row.expiresAt));
});

test("Po0 的心跳下发桥接：iptables，TCP 和 UDP 都转到 Po01 的入口地址:端口", () => {
  const applies = bridgeApplies(outcome.po0AfterAB);
  assert.equal(applies.length, 1, JSON.stringify(outcome.po0AfterAB));
  const [bridge] = applies;
  assert.equal(bridge.ruleId, BRIDGE_BASE + outcome.rowsAfterAB[0].id);
  assert.equal(bridge.forwardType, "iptables");
  assert.equal(bridge.sourcePort, 40981);
  assert.equal(bridge.targetIp, "203.0.113.2");
  assert.equal(bridge.targetPort, 40981);
  assert.equal(bridge.protocol, "both");
  assert.match(bridge.dnat, /-p tcp --dport 40981 -j DNAT --to-destination 203\.0\.113\.2:40981/);
  assert.match(bridge.dnat, /-p udp --dport 40981 -j DNAT --to-destination 203\.0\.113\.2:40981/);
  // 规则本身不再在 Po0 上起
  assert.equal(outcome.po0AfterAB.some((action: Action) => action.op === "apply" && action.ruleId === 10), false);
});

test("Po01 起规则本身（隧道 B 的入口）", () => {
  const entry = outcome.po01AfterAB.find((action: Action) => action.op === "apply" && action.ruleId === 10);
  assert.ok(entry, JSON.stringify(outcome.po01AfterAB));
  assert.equal(entry.tunnelId, 2);
  assert.equal(entry.sourcePort, 40981);
  assert.equal(entry.fxpRole, "entry");
  assert.equal(bridgeApplies(outcome.po01AfterAB).length, 0);
});

test("规则详情带上生效中的桥接，给卡片那行小字用", () => {
  assert.ok(Array.isArray(outcome.bridgeListed), JSON.stringify(outcome.bridgeListed));
  assert.equal(outcome.bridgeListed.length, 1);
  assert.equal(outcome.bridgeListed[0].hostName, "Po0");
  assert.equal(outcome.bridgeListed[0].hostId, 1);
});

test("桥接占着的端口别的规则拿不走，报错说清楚是谁、多久后放开；规则自己不受影响", () => {
  assert.equal(outcome.portUsedOnPo0, true);
  assert.equal(outcome.portUsedOnPo0ForOwner, false);
  assert.ok(outcome.usedPortsOnPo0.includes(40981));
  assert.match(outcome.createConflict, /端口 40981 正被规则 #10 换隧道后的临时桥接占用，.*自动释放/);
});

test("桥接的运行状态记在桥接上；别的机器冒报的忽略", () => {
  assert.equal(outcome.statusReport.status, 200, JSON.stringify(outcome.statusReport));
  assert.equal(outcome.statusFromWrongHost.status, 200);
  assert.equal(outcome.rowsAfterStatus[0].isRunning, 1);
  assert.equal(outcome.rowsAfterStatus[0].runtimeTarget, "203.0.113.2:40981");
});

test("桥接已经跑着且 Agent 报的一致：不再重复下发", () => {
  assert.equal(bridgeApplies(outcome.po0Steady).length, 0, JSON.stringify(outcome.po0Steady));
  assert.equal(outcome.po0Steady.some((action: Action) => action.op === "remove" && action.ruleId > BRIDGE_BASE), false);
});

test("桥接的流量不记账：上报正常收下，但一个字节都不算进用量和规则统计", () => {
  assert.equal(outcome.trafficReport.status, 200, JSON.stringify(outcome.trafficReport));
  assert.equal(outcome.trafficUsed, 0);
  assert.equal(outcome.trafficStatRows, 0);
  assert.equal(outcome.ruleCounterRows, 0);
});

test("B → C：Po0 的桥接改指 Po02，Po01 也留一条；两条的计时都从这次切换重新算", () => {
  assert.equal(outcome.switchBC.success, true);
  assert.deepEqual(outcome.rowsAfterBC.map((row: any) => row.hostId).sort(), [1, 2]);
  for (const row of outcome.rowsAfterBC) {
    assert.ok(Math.abs(row.expiresAt - (nowSeconds() + 3600)) < 120, `host=${row.hostId} expiresAt=${row.expiresAt}`);
  }
  const po0 = bridgeApplies(outcome.po0AfterBC);
  assert.equal(po0.length, 1, JSON.stringify(outcome.po0AfterBC));
  assert.equal(po0[0].targetIp, "203.0.113.4");
  assert.equal(po0[0].targetPort, 40981);
  const po01 = bridgeApplies(outcome.po01AfterBC);
  assert.equal(po01.length, 1, JSON.stringify(outcome.po01AfterBC));
  assert.equal(po01[0].targetIp, "203.0.113.4");
  assert.equal(po01[0].sourcePort, 40981);
  assert.ok(outcome.po02AfterBC.some((action: Action) => action.op === "apply" && action.ruleId === 10 && action.tunnelId === 3));
});

test("C → A：规则回到 Po0，Po0 上的桥接让位，规则照常起", () => {
  assert.equal(outcome.switchCA.success, true);
  assert.equal(outcome.rowsAfterCA.some((row: any) => row.hostId === 1), false, JSON.stringify(outcome.rowsAfterCA));
  assert.deepEqual(outcome.rowsAfterCA.map((row: any) => row.hostId).sort(), [2, 4]);
  assert.equal(bridgeApplies(outcome.po0AfterCA).length, 0);
  const entry = outcome.po0AfterCA.find((action: Action) => action.op === "apply" && action.ruleId === 10);
  assert.ok(entry, JSON.stringify(outcome.po0AfterCA));
  assert.equal(entry.tunnelId, 1);
  // Po0 上的 Agent 还报着桥接在监听：规则收回端口时要把被桥接 DNAT 出去的老流从 conntrack 里清掉。
  assert.match(entry.conntrackFlush, /conntrack -D -p tcp --dport 40981/);
  assert.match(entry.conntrackFlush, /conntrack -D -p udp --dport 40981/);
});

test("桥接接管旧入口端口时把换之前就连着的老流从 conntrack 里清掉，并把规则插到链首", () => {
  const [bridge] = bridgeApplies(outcome.po0AfterAB);
  assert.ok(bridge, JSON.stringify(outcome.po0AfterAB));
  assert.match(bridge.conntrackFlush, /conntrack -D -p tcp --dport 40981/);
  assert.match(bridge.conntrackFlush, /conntrack -D -p udp --dport 40981/);
  assert.match(bridge.dnat, /-I PREROUTING -p tcp --dport 40981 -j DNAT --to-destination 203\.0\.113\.2:40981/);
  // 规则本身（不是桥接）在新入口上起，不清 conntrack：那台机器上这个端口本来没有老流。
  const entry = outcome.po01AfterAB.find((action: Action) => action.op === "apply" && action.ruleId === 10);
  assert.ok(entry, JSON.stringify(outcome.po01AfterAB));
  assert.equal(entry.conntrackFlush, "");
});

test("到期的桥接不再下发，Agent 上的监听当孤儿撤掉；清理把行删掉", () => {
  assert.equal(bridgeApplies(outcome.po01BeforeExpiry).length, 1, "到期前应当还在转（目标改成了回到 Po0 的规则）");
  assert.equal(bridgeApplies(outcome.po01BeforeExpiry)[0].targetIp, "203.0.113.1");
  assert.equal(bridgeApplies(outcome.po01Expired).length, 0);
  const removal = outcome.po01Expired.find((action: Action) => action.op === "remove" && action.ruleId > BRIDGE_BASE);
  assert.ok(removal, JSON.stringify(outcome.po01Expired));
  assert.equal(removal.sourcePort, 40981);
  assert.equal(outcome.portUsedAfterExpiry, false);
  assert.ok(outcome.sweptHosts.includes(2));
  assert.equal(outcome.rowsAfterSweep.some((row: any) => row.hostId === 2), false);
});

test("删规则：剩下的桥接一起删", () => {
  assert.deepEqual(outcome.rowsAfterDelete, []);
});
