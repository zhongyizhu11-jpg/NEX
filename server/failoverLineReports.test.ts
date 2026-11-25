import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 「现在走哪条」：Agent 报上来的，面板要收得到、存得对、以快照为准。
 *
 * 上一版有三处让这件事基本没在工作：
 *   · 事件在心跳的「稳定快路径」之后才读。机器上什么都没变时（绝大多数心跳）走快路径
 *     直接返回，Agent 那边这一批事件已经清掉了 —— 切换就这么丢了。
 *   · Agent 报的时刻是毫秒，面板当成秒存：sqlite 里是五万多年以后，MySQL / PostgreSQL
 *     的 32 位 epoch 列直接写不进去。
 *   · 只有事件没有快照：换规格、Agent 重启后代理不报事件就回到主线路，面板一直写着
 *     最后一次报上来的那条。
 *
 * 快路径是真实存在的分支，这里把计划缓存的 match 换掉，让每次心跳都走它 —— 不然这一组
 * 测的只是「慢路径能收」，而慢路径本来就能收。
 */

type Line = { target: string | null; at: number | null };
type Outcome = {
  now: number;
  paths: string[];
  repaired: number[] | null;
  after: Record<string, Record<string, Line>>;
  logs: string[];
  seconds: Record<string, number>;
};

function run(): Outcome {
  const result = runInDatabase(String.raw`
    const http = (await import("node:http")).default;

    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, token] of [[1, "tok1"], [2, "tok2"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, "机" + id, "203.0.113." + id, "203.0.113." + id, "slave", token, now],
      );
    }
    // 1 号规则在 1 号机上，2 号规则在**另一台**机器上。
    const backups = JSON.stringify([{ targetIp: "198.51.100.8", targetPort: 443 }, { targetIp: "198.51.100.9", targetPort: 443 }]);
    for (const [ruleId, hostId, port] of [[1, 1, 20001], [2, 2, 20002]]) {
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "failoverEnabled", "failoverTargets")'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?)',
        [ruleId, hostId, "规则" + ruleId, "gost", "tcp", port, "198.51.100.7", 443, backups],
      );
    }

    // 让每次心跳都走「稳定快路径」。
    const gate = await import(url("server/agentHeartbeatGate.ts"));
    gate.agentStableHeartbeatPlanCache.match = () => ({
      plannedAt: nowMs, configRevision: 0, desiredStateHash: "h", localStateSignature: "l", stateSignatures: { runningRules: "s" },
      agentVersion: "2.2.197", agentBootId: "", agentProcessStartedAt: 0, defaultNetworkInterface: "",
      pluginInventorySignature: "", mimicEnvironmentSignature: "", idleNextInterval: 30, panelUrl: "",
    });
    const reports = await import(url("server/failoverLineReports.ts"));

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

    // 每次心跳走的是哪条路：对账合并（coalesced）、稳定快路径（fast），还是完整对账（full）。
    const paths = [];
    const beat = async (extra) => {
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok1" },
        body: JSON.stringify({ agentVersion: "2.2.197", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, ...extra }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status);
      paths.push(body.reconciliationCoalesced === true
        ? "coalesced"
        : body.desiredState === undefined && Array.isArray(body.actions) && body.actions.length === 0 ? "fast" : "full");
    };
    const lines = async () => {
      const rows = await query('SELECT id, "failoverActiveTarget" AS target, "failoverActiveAt" AS at FROM forward_rules ORDER BY id');
      return Object.fromEntries(rows.map((row) => [row.id, { target: row.target ?? null, at: row.at === null ? null : Number(row.at) }]));
    };
    const after = {};

    // 老 Agent：只有事件，时刻是毫秒。
    await beat({ failoverEvents: [
      { ruleId: 1, sourcePort: 20001, kind: "switch", fromTarget: "198.51.100.7:443", toTarget: "198.51.100.8:443", reason: "health check", occurredAt: nowMs - 30_000 },
    ] });
    after.event = await lines();

    // 新 Agent：快照和事件同时来，以快照为准；别人家的规则一条都不收。
    const snapshot = [
      { ruleId: 1, sourcePort: 20001, target: "198.51.100.7:443", since: nowMs - 5_000 },
      { ruleId: 2, sourcePort: 20002, target: "被冒用的规则:443", since: nowMs - 5_000 },
    ];
    // forceReconcile 绕过对账合并的 5 秒窗口，让它们都走到快路径；最后一次不带，专门测合并那条早退。
    await beat({
      forceReconcile: true,
      failoverEvents: [{ ruleId: 1, sourcePort: 20001, kind: "switch", toTarget: "198.51.100.9:443", occurredAt: nowMs - 60_000 }],
      failoverActive: snapshot,
    });
    after.snapshot = await lines();

    // 同一份快照再来一次：不核对、不写库。库里的值先改掉，看它有没有被碰。
    await exec('UPDATE forward_rules SET "failoverActiveTarget" = ? WHERE id = 1', ["库里被改过:1"]);
    await beat({ forceReconcile: true, failoverActive: snapshot });
    after.sameSnapshot = await lines();

    // 快照变了（换规格之后回到主线路，重新计时）：照写。
    await beat({ forceReconcile: true, failoverActive: [{ ruleId: 1, sourcePort: 20001, target: "198.51.100.7:443", since: nowMs - 1_000 }] });
    after.changedSnapshot = await lines();

    // 面板重启过：记住的快照没了，同一份快照也要重新核一遍。
    await exec('UPDATE forward_rules SET "failoverActiveTarget" = ? WHERE id = 1', ["重启前被改过:1"]);
    reports.resetFailoverLineReportMemory();
    await beat({ forceReconcile: true, failoverActive: [{ ruleId: 1, sourcePort: 20001, target: "198.51.100.7:443", since: nowMs - 1_000 }] });
    after.afterRestart = await lines();

    // 5 秒内的又一次心跳，被对账合并直接打回 —— 带着的切换事件也得收下。
    await beat({ failoverEvents: [
      { ruleId: 1, sourcePort: 20001, kind: "switch", fromTarget: "198.51.100.7:443", toTarget: "198.51.100.9:443", reason: "dial failed", occurredAt: nowMs - 2_000 },
    ] });
    after.coalesced = await lines();
    server.close();

    // 上一版存下来的毫秒当秒：一次性除回来，只做一次。PostgreSQL 的 int4 列放不下毫秒值，这段老数据只在 SQLite 上造得出来。
    let repaired = null;
    if (runtime.getDatabaseKind() === "sqlite") {
      await exec('UPDATE forward_rules SET "failoverActiveTarget" = ?, "failoverActiveAt" = ? WHERE id = 2', ["198.51.100.8:443", nowMs - 90_000]);
      const database = await import(url("server/db.ts"));
      repaired = [await database.repairFailoverActiveTimeUnitOnce()];
      after.repaired = await lines();
      await exec('UPDATE forward_rules SET "failoverActiveAt" = ? WHERE id = 2', [nowMs]);
      repaired.push(await database.repairFailoverActiveTimeUnitOnce());
    }

    const logger = await import(url("server/_core/panelLogger.ts"));
    const entries = await logger.getPanelLogs();
    console.log("OUTCOME " + JSON.stringify({
      now,
      paths,
      repaired,
      after,
      logs: entries.map((entry) => String(entry.message)).filter((message) => message.startsWith("[Failover]")),
      seconds: {
        ms: reports.agentReportedSeconds(nowMs - 30_000, nowMs),
        s: reports.agentReportedSeconds(now - 30, nowMs),
        garbage: reports.agentReportedSeconds("not a time", nowMs),
        future: reports.agentReportedSeconds(nowMs + 3 * 86_400_000, nowMs),
      },
    }));
  `, { name: "failover-lines", timeoutMs: 180000 });
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = run();

test("前提：心跳真的走了那两条早退 —— 稳定快路径和对账合并", () => {
  assert.deepEqual(
    outcome.paths,
    ["fast", "fast", "fast", "fast", "fast", "coalesced"],
    "没走到早退的话，这一组测的就只是完整对账那条路，而那条路本来就收得到",
  );
});

test("快路径上的切换事件照样收：日志里有，当前线路也记上", () => {
  assert.ok(
    outcome.logs.some((message) => message.includes("rule=1 switch 198.51.100.7:443 -> 198.51.100.8:443")),
    `切换事件在快路径上被丢了：\n${outcome.logs.join("\n")}`,
  );
  assert.equal(outcome.after.event[1].target, "198.51.100.8:443");
});

test("Agent 报的毫秒存成秒 —— 不是五万多年以后，也不会撑爆 32 位的列", () => {
  assert.equal(outcome.after.event[1].at, outcome.now - 30);
  assert.ok(outcome.after.event[1].at! < 2_147_483_647, "MySQL / PostgreSQL 的 epoch 列是 32 位整数");
});

test("快照和事件一起来时，以快照为准", () => {
  // 事件说一分钟前切到了备用 2，快照说五秒前起走的是主线路 —— 后者才是现在。
  assert.deepEqual(outcome.after.snapshot[1], { target: "198.51.100.7:443", at: outcome.now - 5 });
});

test("不是这台机器的规则，快照里报了也不收", () => {
  assert.deepEqual(outcome.after.snapshot[2], { target: null, at: null });
});

test("快照没变就不再写库；变了照写；面板重启后重新核一遍", () => {
  assert.equal(outcome.after.sameSnapshot[1].target, "库里被改过:1", "同一份快照每次都核对、都写库，就是白白的写放大");
  assert.deepEqual(outcome.after.changedSnapshot[1], { target: "198.51.100.7:443", at: outcome.now - 1 });
  assert.equal(outcome.after.afterRestart[1].target, "198.51.100.7:443", "面板重启之后第一份快照要重新核");
});

test("对账合并打回的心跳，带着的切换事件也收下", () => {
  assert.ok(
    outcome.logs.some((message) => message.includes("rule=1 switch 198.51.100.7:443 -> 198.51.100.9:443 reason=dial failed")),
    `切换事件在对账合并那条早退上被丢了：\n${outcome.logs.join("\n")}`,
  );
  assert.deepEqual(outcome.after.coalesced[1], { target: "198.51.100.9:443", at: outcome.now - 2 });
});

test("时刻的几种写法：毫秒、秒都认；认不出来的、远在将来的按收到的时刻算", () => {
  assert.equal(outcome.seconds.ms, outcome.now - 30);
  assert.equal(outcome.seconds.s, outcome.now - 30);
  assert.equal(outcome.seconds.garbage, outcome.now);
  assert.equal(outcome.seconds.future, outcome.now);
});

test("上一版存成毫秒的时刻，升级时除回秒；修正只做一次", { skip: outcome.repaired === null ? "PostgreSQL 的 int4 列放不下毫秒值，老数据修正只在 SQLite 上验" : false }, () => {
  const repaired = outcome.repaired!;
  assert.equal(repaired[0], 1, "库里只有 2 号那一行是毫秒");
  // 1 号在这之前已经按秒重新写过（最后那次合并心跳），不能被再除一次。
  assert.equal(outcome.after.repaired[1].at, outcome.after.coalesced[1].at);
  assert.equal(outcome.after.repaired[2].at, outcome.now - 90);
  assert.equal(repaired[1], 0, "修正做过之后不再碰");
});
