import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 评估一个转发组 / 入口组打多少次库（P7）。
 *
 * 以前评估里每个成员各查各的：取主机（发布值一次、存活判定一次，发布前再核对一遍又是每成员一次）、
 * 取子规则、取模板状态、每条子规则先刷写缓冲再查最新探测。成员越多查得越多，20 个成员的组一次评估上百次。
 * 现在组、成员、隧道、主机、子规则、模板状态、最新探测各一次批量读完。
 *
 * 钉两件事：
 *   1. 稳态下（没有成员状态变化）一次评估的条数**不随成员数涨**：5 个成员和 20 个成员一样多；
 *   2. 绝对值在一个小常数以内。
 * 另外探测拓扑（每台主机每次心跳都要取）建好之后按主机取是零次查询。
 */

type Probe = { cost: Record<string, number>; values: Record<string, string> };

function runProbe(): Probe {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-eval-cost-"));
  const databasePath = path.join(directory, "eval.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    for (let i = 1; i <= 60; i++) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [i, "h" + i, "10.9.0." + i, "10.9.0." + i, "slave", "tok" + i, now]);
    }

    // 入口组：5 个成员 / 20 个成员，成员自己报告健康
    const entryGroup = async (gid, firstHost, count) => {
      await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, domain, targetIp, targetPort, userId, isEnabled, recordType) VALUES (?, ?, 'host', 'entry', ?, '0.0.0.0', 1, 1, 1, 'A')", [gid, "入口" + gid, "e" + gid + ".example.test"]);
      for (let i = 0; i < count; i++) {
        await exec('INSERT INTO forward_group_members (id, "groupId", "memberType", "hostId", priority, "isEnabled", "healthStatus", "lastCheckedAt") VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
          [gid * 100 + i, gid, "host", firstHost + i, i, "healthy", now]);
      }
    };
    await entryGroup(1, 1, 5);
    await entryGroup(2, 10, 20);

    // 主备组（有规则在用）：每个成员一条在跑的子规则，各有一条新鲜的探测结果
    const failoverGroup = async (gid, firstHost, count) => {
      await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, domain, targetIp, targetPort, userId, isEnabled, recordType, activeMemberId, failoverSeconds, recoverSeconds) VALUES (?, ?, 'host', 'failover', ?, '0.0.0.0', 1, 1, 1, 'A', ?, 60, 120)",
        [gid, "主备" + gid, "f" + gid + ".example.test", gid * 100]);
      await exec('INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 80, 1, 1, 0)',
        [gid * 1000, firstHost, "模板" + gid, "iptables", "tcp", gid, 20000 + gid, "203.0.113.10"]);
      for (let i = 0; i < count; i++) {
        const memberId = gid * 100 + i;
        const ruleId = gid * 1000 + 1 + i;
        await exec('INSERT INTO forward_group_members (id, "groupId", "memberType", "hostId", priority, "isEnabled") VALUES (?, ?, ?, ?, ?, 1)', [memberId, gid, "host", firstHost + i, i]);
        await exec('INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 80, 1, 1, 1)',
          [ruleId, firstHost + i, "子" + ruleId, "iptables", "tcp", gid, gid * 1000, memberId, 20000 + gid, "203.0.113.10"]);
        await exec('INSERT INTO tcping_stats ("ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "recordedAt") VALUES (?, ?, 20, 0, ?, ?)', [ruleId, firstHost + i, "healthy", now]);
      }
    };
    await failoverGroup(3, 1, 5);
    await failoverGroup(4, 30, 20);

    const groups = await import(url("server/repositories/forwardGroupRepository.ts"));
    const cost = {};
    const values = {};
    for (const [label, gid] of [["入口5", 1], ["入口20", 2], ["主备5", 3], ["主备20", 4]]) {
      // 头两轮把成员从「未知」评成「健康」、把首次发布做掉（那些是状态变化的写入）；第三轮是稳态
      await groups.runForwardGroupFailover(gid, { skipRuleSync: true });
      await groups.runForwardGroupFailover(gid, { skipRuleSync: true });
      statements = []; recording = true;
      await groups.runForwardGroupFailover(gid, { skipRuleSync: true });
      recording = false;
      cost[label] = statements.length;
      const [row] = await runtime.queryRaw('SELECT "lastDdnsValue", "lastStatus" FROM forward_groups WHERE id = ?', [gid]);
      values[label] = row.lastStatus + ":" + String(row.lastDdnsValue || "").split(",").length;
    }
    // 探测拓扑：建好之后每台主机取自己那份不再查库
    await groups.getForwardGroupProbeTopologyForHost(1);
    statements = []; recording = true;
    for (let hostId = 1; hostId <= 60; hostId++) await groups.getForwardGroupProbeTopologyForHost(hostId);
    recording = false;
    cost["拓扑60台"] = statements.length;
    console.log("EVALCOST " + JSON.stringify({ cost, values }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    timeout: 180000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("EVALCOST "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("EVALCOST ".length)) as Probe;
}

const probe = runProbe();

test("评估查询数（记到输出里，方便前后对比）", (t) => {
  t.diagnostic(`forward group evaluation query counts: ${JSON.stringify(probe.cost)}`);
});

test("入口组评估的打库次数不随成员数增长", () => {
  assert.equal(probe.values["入口5"], "healthy:5");
  assert.equal(probe.values["入口20"], "healthy:20");
  assert.equal(probe.cost["入口20"], probe.cost["入口5"], `入口组成员从 5 个涨到 20 个，一次评估从 ${probe.cost["入口5"]} 次查询变成 ${probe.cost["入口20"]} 次`);
  assert.ok(probe.cost["入口20"] <= 10, `评估一个 20 成员的入口组打了 ${probe.cost["入口20"]} 次库，超了预算 10`);
});

test("主备组（有规则在用）评估的打库次数不随成员数增长", () => {
  assert.equal(probe.values["主备5"], "healthy:1");
  assert.equal(probe.values["主备20"], "healthy:1");
  assert.equal(probe.cost["主备20"], probe.cost["主备5"], `主备组成员从 5 个涨到 20 个，一次评估从 ${probe.cost["主备5"]} 次查询变成 ${probe.cost["主备20"]} 次`);
  assert.ok(probe.cost["主备20"] <= 14, `评估一个 20 成员的主备组打了 ${probe.cost["主备20"]} 次库，超了预算 14`);
});

test("探测拓扑建好之后按主机取不再查库", () => {
  assert.equal(probe.cost["拓扑60台"], 0, `60 台主机各取一次自己的探测拓扑打了 ${probe.cost["拓扑60台"]} 次库`);
});
