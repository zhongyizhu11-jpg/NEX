import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 机器人报的规则状态，要跟着探测的**年纪**走，而不是只看它成没成功。
 *
 * 这一组走真库：写一条 forward_tests 的超时记录，按记录时间新旧各跑一遍，核对
 * 从「库里那一行」到「机器人说的那句话」这条链路整条都对。
 *
 * 光测 effectiveRuleStatusInfo 不够 —— 那个函数只认手里的 summary，而这条链路
 * 真正容易断的一环是**中间那一步有没有把时间戳带过来**：带丢了的话新鲜期判定
 * 永远为假，机器人就从此再也报不出任何一次超时，而且一声不响。
 */
test("SQLite 机器人按探测新鲜期报状态，且时间戳一路带得到", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tg-probe-age-"));
  const databasePath = path.join(directory, "tg-probe-age.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const bot = await import(url("server/telegram/telegramBot.ts"));
    const { LINK_PROBE_FRESH_MS } = await import(url("shared/linkProbePolicy.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, "agentToken", "userId", "isOnline") VALUES (?, ?, ?, ?, ?, ?)',
      [10, "入口", "203.0.113.10", "tok10", 1, 1],
    );
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [1, 10, "转发", 8080, "198.51.100.1", 80, 1, 1, 1],
    );

    /**
     * 先有流量计数行，才有「这条规则的汇总」可谈 —— 延迟是挂在汇总行上带出来的。
     */
    await exec(
      'INSERT INTO forward_rule_traffic_counters (id, "ruleId", "hostId", "userId", "bytesIn", "bytesOut", connections)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [1, 1, 10, 1, 1024, 2048, 3],
    );

    const admin = { id: 1, role: "admin" };
    /** 普通转发的延迟来自 tcping_stats（forward_tests 只喂转发链与隧道那两路）。 */
    const writeTimeoutProbe = async (recordedAtMs) => {
      await exec('DELETE FROM tcping_stats');
      await exec(
        'INSERT INTO tcping_stats (id, "ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt")'
          + ' VALUES (?, ?, ?, ?, ?, ?)',
        [1, 1, 10, null, 1, Math.floor(recordedAtMs / 1000)],
      );
    };
    const statusNow = async () => {
      const summaries = await bot.aiRuleTrafficSummaryMap(admin, [1], { includeLatency: true });
      const summary = summaries.get(1);
      const rule = { id: 1, isEnabled: true, isRunning: true };
      return { summary, info: bot.effectiveRuleStatusInfo(rule, summary) };
    };

    /** 刚探到的超时：必须报出来。 */
    await writeTimeoutProbe(Date.now() - 1_000);
    const fresh = await statusNow();
    assert.ok(
      fresh.summary?.latestLatencyAt,
      "探测时间戳在中间那一步被丢掉了 —— 新鲜期判定会永远为假，机器人从此再也报不出超时",
    );
    assert.equal(fresh.summary.latestLatencyIsTimeout, true);
    assert.equal(fresh.info.kind, "abnormal");
    assert.equal(fresh.info.label, "目标探测超时");

    /** 陈年的超时：当作没探测过，回到 Agent 上报的运行状态。 */
    await writeTimeoutProbe(Date.now() - LINK_PROBE_FRESH_MS - 60_000);
    const stale = await statusNow();
    assert.equal(stale.summary.latestLatencyIsTimeout, true, "库里那一行仍然是超时");
    assert.equal(
      stale.info.kind,
      "running",
      "面板按新鲜期判成运行中，机器人拿陈年那次超时判成「目标探测超时」—— 同一条规则两个答案",
    );
    assert.equal(stale.info.label, "运行中");

    console.log("OK");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});
