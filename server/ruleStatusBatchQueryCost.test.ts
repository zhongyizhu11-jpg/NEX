import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * Agent 批量上报规则状态（/api/agent/rule-status-batch）打多少次库。
 *
 * 一批最多 200 条，同一台机器上的规则大多挂在少数几条隧道上。原来每条规则都要：
 * 读规则、读隧道、读入口组（连成员）、读额外落地节点、写状态前再读一遍规则、写状态 ——
 * 同一条隧道的授权信息被查几十遍。现在隧道那几项按请求缓存，规则也不再重读。
 *
 * 这里钉的是**每多一条规则多几条语句**：只剩「读这条规则 + 写它的状态」两条。
 * 同时钉住结果没变：状态照样写进去、无权的机器照样 403、等待删除的规则停下后照样收尾删除。
 */

type Probe = {
  cost: Record<string, number>;
  running: number[];
  forbiddenStatus: number;
  pendingDeleteGone: boolean;
};

function runProbe(): Probe {
  const result = runInDatabase(String.raw`
    const http = (await import("node:http")).default;

    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    for (let h = 1; h <= 4; h++) {
      await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId", "isOnline") VALUES (?, ?, ?, ?, ?, 1, 1)', [h, "h" + h, "10.0.0." + h, "slave", "tok" + h]);
    }
    // 入口组：1、3 号机；隧道 1 号机为主入口、2 号机为出口，另有 4 号机做额外落地
    await exec('INSERT INTO forward_groups (id, name, "groupMode", "targetIp", "userId", "isEnabled") VALUES (9, ?, ?, ?, 1, 1)', ["入口组", "entry", "127.0.0.1"]);
    await exec('INSERT INTO forward_group_members (id, "groupId", "memberType", "hostId", priority) VALUES (91, 9, ?, 1, 10), (92, 9, ?, 3, 20)', ["host", "host"]);
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", "entryGroupId", mode, "listenPort", secret, "userId", "isEnabled") VALUES (5, ?, 1, 2, 9, ?, 30005, ?, 1, 1)', ["隧道", "tls", "s"]);
    await exec('INSERT INTO tunnel_exit_nodes (id, "tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (1, 5, 0, 4, 30006, 1)');
    for (let r = 1; r <= 12; r++) {
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "tunnelId", "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (?, 1, ?, 5, ?, ?, ?, ?, 80, 1, 1, 0)',
        [r, "r" + r, "gost", "tcp", 20000 + r, "127.0.0.1"],
      );
    }
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "tunnelId", "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "pendingDelete") VALUES (50, 1, ?, 5, ?, ?, 20050, ?, 80, 1, 1, 1, 1)',
      ["r50", "gost", "tcp", "127.0.0.1"],
    );

    const express = (await import("express")).default;
    const statusRoutes = await import(url("server/agentStatusRoutes.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    const router = express.Router();
    statusRoutes.registerAgentStatusRoutes(router);
    app.use(router);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = "http://127.0.0.1:" + server.address().port;
    const post = async (token, statuses) => {
      const response = await fetch(base + "/api/agent/rule-status-batch", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ statuses }),
      });
      return { status: response.status, body: await response.json() };
    };
    const statusesFor = (ids, isRunning = true) => ids.map((ruleId) => ({ statusType: "rule", ruleId, tunnelId: 5, isRunning, sourcePort: 20000 + ruleId }));

    const cost = {};
    // 3 号机是入口组成员：授权要走入口组那条路
    for (const [label, ids] of [["rules=2", [1, 2]], ["rules=8", [3, 4, 5, 6, 7, 8, 9, 10]]]) {
      statements = []; recording = true;
      const result = await post("tok3", statusesFor(ids));
      recording = false;
      if (result.status !== 200 || result.body.accepted !== ids.length) throw new Error("batch failed: " + JSON.stringify(result));
      cost[label] = statements.length;
    }
    const running = (await query('SELECT id FROM forward_rules WHERE "isRunning" = 1 AND id <= 12 ORDER BY id')).map((row) => Number(row.id));

    // 出口机 2 号有权；和隧道无关的机器（这里改用一条挂在别的隧道上的规则来构造）应被拒
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", secret, "userId", "isEnabled") VALUES (6, ?, 2, 4, ?, 30010, ?, 1, 1)', ["别的隧道", "tls", "s2"]);
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "tunnelId", "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled") VALUES (60, 2, ?, 6, ?, ?, 20060, ?, 80, 1, 1)',
      ["r60", "gost", "tcp", "127.0.0.1"],
    );
    const forbidden = await post("tok3", [{ statusType: "rule", ruleId: 60, tunnelId: 6, isRunning: true }, ...statusesFor([11])]);
    const forbiddenStatus = Number(forbidden.body.rejected?.[0]?.status || 0);

    await post("tok1", [{ statusType: "rule", ruleId: 50, tunnelId: 5, isRunning: false, sourcePort: 20050 }]);
    const pendingDeleteGone = (await query("SELECT id FROM forward_rules WHERE id = 50")).length === 0;

    server.close();
    console.log("STATUSCOST " + JSON.stringify({ cost, running, forbiddenStatus, pendingDeleteGone }));
  `, { name: "rule-status-cost", env: { NODE_ENV: "test" } });
  const line = result.stdout.split("\n").find((row) => row.startsWith("STATUSCOST "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("STATUSCOST ".length)) as Probe;
}

const probe = runProbe();

test("批量规则状态：每多一条规则只多「读规则 + 写状态」两条语句", () => {
  const perRule = (probe.cost["rules=8"] - probe.cost["rules=2"]) / 6;
  assert.ok(
    perRule <= 2,
    `每条规则 ${perRule} 条语句：${JSON.stringify(probe.cost)}（隧道/入口组/落地节点应按请求只查一次，规则不应重读）`,
  );
});

test("批量规则状态：结果与逐条处理一致", () => {
  assert.deepEqual(probe.running, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(probe.forbiddenStatus, 403);
  assert.ok(probe.pendingDeleteGone, "等待删除的规则报告已停止后应当收尾删除");
});
