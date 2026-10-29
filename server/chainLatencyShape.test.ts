import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 转发链模板的延迟记录 / 累计计数 / 卡片最新延迟都按子规则算，而且分内核链和用户态链：
 *   · 内核（nftables）链是透传 DNAT：入口子规则的一次 TCP 探测就是端到端，不把各跳相加；
 *   · 用户态（gost）链：每跳本机接下连接，各跳相加才是端到端。
 * 原来模板一律取链各跳的 ICMP 探测汇总（丢包率是 ICMP 的，和业务无关），卡片又把内核链的几跳相加（算了两三遍）。
 */
test("转发链模板：内核链取入口子规则的端到端，用户态链各跳相加；计数同口径", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-chain-latency-shape-"));
  const databasePath = path.join(directory, "chain.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const metrics = await import(moduleUrl("server/repositories/metricsRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const now = Math.floor(Date.now() / 1000);
    const since = new Date((now - 600) * 1000);

    await insert("users", ["id", "username", "password", "role"], [1, "admin", "hash", "admin"]);
    for (const [id, name] of [[1, "入口"], [2, "po0"], [3, "jinx"]]) {
      await insert("hosts", ["id", "name", "ip", "ipv4", "hostType", "agentToken", "userId"], [id, name, "10.0.0." + id, "10.0.0." + id, "slave", "tok" + id, 1]);
    }
    // 内核链 21：成员 入口(1) → po0(2) → jinx(3)，nftables
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [21, "内核链", "host", "chain", "nftables", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [211, 21, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [212, 21, "host", 2, 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [213, 21, "host", 3, 2, 1]);
    // 用户态链 22：同样三台，gost
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [22, "用户态链", "host", "chain", "gost", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [221, 22, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [222, 22, "host", 2, 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [223, 22, "host", 3, 2, 1]);

    const ruleColumns = ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
    await insert("forward_rules", ruleColumns, [200, 1, "内核模板", "nftables", "tcp", 21, null, null, 1, 20000, "target.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [210, 1, "入口→po0", "nftables", "tcp", 21, 200, 211, 0, 20000, "10.0.0.2", 20001, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [220, 2, "po0→jinx", "nftables", "tcp", 21, 200, 212, 0, 20001, "10.0.0.3", 20002, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [230, 3, "jinx→目标", "nftables", "tcp", 21, 200, 213, 0, 20002, "target.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [300, 1, "用户态模板", "gost", "tcp", 22, null, null, 1, 30000, "target.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [310, 1, "入口→po0", "gost", "tcp", 22, 300, 221, 0, 30000, "10.0.0.2", 30001, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [320, 2, "po0→jinx", "gost", "tcp", 22, 300, 222, 0, 30001, "10.0.0.3", 30002, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [330, 3, "jinx→目标", "gost", "tcp", 22, 300, 223, 0, 30002, "target.test", 443, 1, 1, 1]);

    // 内核链：入口端到端 150ms，po0 起的端到端 145ms，jinx 到目标 10ms（三条都各是「那台到目标」）。
    const stat = ["ruleId", "hostId", "latencyMs", "isTimeout", "probeCount", "probeSuccesses", "recordedAt"];
    await insert("tcping_stats", stat, [210, 1, 150, 0, 3, 3, now - 100]);
    await insert("tcping_stats", stat, [220, 2, 145, 0, 3, 3, now - 100]);
    await insert("tcping_stats", stat, [230, 3, 10, 0, 3, 3, now - 100]);
    // 用户态链：各跳 20 / 120 / 10。
    await insert("tcping_stats", stat, [310, 1, 20, 0, 3, 3, now - 100]);
    await insert("tcping_stats", stat, [320, 2, 120, 0, 3, 3, now - 100]);
    await insert("tcping_stats", stat, [330, 3, 10, 0, 3, 3, now - 100]);
    // 链各跳的 ICMP 汇总（原来模板拿的就是它）：8ms，不该再出现在模板的记录里。
    await insert("forward_group_latency_stats", ["groupId", "latencyMs", "isTimeout", "probeCount", "probeSuccesses", "recordedAt"], [21, 8, 0, 5, 2, now - 100]);
    await insert("forward_group_latency_stats", ["groupId", "latencyMs", "isTimeout", "probeCount", "probeSuccesses", "recordedAt"], [22, 8, 0, 5, 2, now - 100]);

    const kernelSeries = await metrics.getTcpingSeriesByRule(200, { since });
    const userSeries = await metrics.getTcpingSeriesByRule(300, { since });

    // 累计计数：内核链只看入口子规则（100 次 98 成），链各跳 ICMP 计数（100 次 55 成）不算；
    // 用户态链三段串起来乘：100×0.98、100×0.99、100×0.9 → 100 次 87 成。
    const counter = ["kind", "refId", "hostId", "probeKey", "epoch", "totalCount", "totalSuccesses", "batchCount", "batchSuccesses", "recordedAt"];
    await insert("probe_counter_snapshots", counter, ["rule", 210, 1, "k210", "e", 100, 98, 100, 98, now - 90]);
    await insert("probe_counter_snapshots", counter, ["rule", 220, 2, "k220", "e", 100, 97, 100, 97, now - 90]);
    await insert("probe_counter_snapshots", counter, ["rule", 230, 3, "k230", "e", 100, 90, 100, 90, now - 90]);
    await insert("probe_counter_snapshots", counter, ["forwardGroup", 21, 1, "g21", "e", 100, 55, 100, 55, now - 90]);
    await insert("probe_counter_snapshots", counter, ["rule", 310, 1, "k310", "e", 100, 98, 100, 98, now - 90]);
    await insert("probe_counter_snapshots", counter, ["rule", 320, 2, "k320", "e", 100, 99, 100, 99, now - 90]);
    await insert("probe_counter_snapshots", counter, ["rule", 330, 3, "k330", "e", 100, 90, 100, 90, now - 90]);
    await insert("probe_counter_snapshots", counter, ["forwardGroup", 22, 1, "g22", "e", 100, 55, 100, 55, now - 90]);
    const kernelStats = await metrics.getTcpingProbeStatisticsByRule(200, since);
    const userStats = await metrics.getTcpingProbeStatisticsByRule(300, since);

    // 卡片最新延迟：走流量汇总的 includeLatency。
    await insert("forward_rule_traffic_counters", ["ruleId", "hostId", "userId", "bytesIn", "bytesOut", "connections"], [200, 1, 1, 10, 10, 1]);
    await insert("forward_rule_traffic_counters", ["ruleId", "hostId", "userId", "bytesIn", "bytesOut", "connections"], [300, 1, 1, 10, 10, 1]);
    const summary = await metrics.getTrafficSummaryByRule({ ruleIds: [200, 300], includeLatency: true });
    const latest = Object.fromEntries(summary.map((row) => [row.ruleId, [row.latestLatencyMs, row.latestLatencyIsTimeout]]));

    console.log("OUTCOME " + JSON.stringify({
      kernelSeries: kernelSeries.map((item) => [item.latencyMs, item.probeCount, item.probeSuccesses]),
      userSeries: userSeries.map((item) => [item.latencyMs, item.probeCount, item.probeSuccesses]),
      kernelStats: [kernelStats.total, kernelStats.successes, kernelStats.available],
      userStats: [userStats.total, userStats.successes, userStats.available],
      latest,
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  const outcome = JSON.parse(line.slice("OUTCOME ".length));
  assert.deepEqual(outcome.kernelSeries, [[150, 3, 3]], "内核链：入口子规则的 150ms 就是端到端，不是 305，也不是 ICMP 的 8");
  assert.deepEqual(outcome.userSeries, [[150, 9, 9]], "用户态链：20 + 120 + 10");
  assert.deepEqual(outcome.kernelStats, [100, 98, true], "内核链计数只看入口子规则");
  assert.deepEqual(outcome.userStats, [100, 87, true], "用户态链计数按各段成功率相乘");
  assert.deepEqual(outcome.latest, { 200: [150, false], 300: [150, false] }, "卡片最新延迟同口径");
});
