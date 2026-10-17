import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LATENCY_DAY_SECONDS,
  LATENCY_HISTORY_DAYS,
  latencyDayHealth,
  latencyDayKey,
  latencyDayLossPercent,
  latencyDayStart,
} from "../shared/latencyHistory";

// 30 天延迟历史（上游 v2.3.284 的按天色块）。NEX 不把原始样本留 30 天，而是按天汇总进
// latency_daily_stats —— 这里测汇总口径、增量水位不重复计数、30 天清理和权限。

test("days are cut at panel-timezone midnight (UTC+8) and keyed by the panel calendar date", () => {
  // 2026-10-12 00:00 +08:00 == 2026-10-11T16:00:00Z
  const midnight = Date.UTC(2026, 9, 11, 16) / 1000;
  assert.equal(latencyDayStart(midnight), midnight);
  assert.equal(latencyDayStart(midnight + LATENCY_DAY_SECONDS - 1), midnight);
  assert.equal(latencyDayStart(midnight - 1), midnight - LATENCY_DAY_SECONDS);
  assert.equal(latencyDayKey(midnight), "2026-10-12");
  assert.equal(latencyDayKey(midnight - LATENCY_DAY_SECONDS), "2026-10-11");
  assert.equal(LATENCY_HISTORY_DAYS, 30);
});

test("daily health colors follow packet loss: ≤1% good, ≤5% warning, >5% bad, no samples none", () => {
  assert.equal(latencyDayHealth(0, 0), "none");
  assert.equal(latencyDayHealth(100, 100), "good");
  assert.equal(latencyDayHealth(100, 99), "good");
  assert.equal(latencyDayHealth(100, 95), "warning");
  assert.equal(latencyDayHealth(100, 94), "bad");
  assert.equal(latencyDayHealth(100, 500), "good", "successes are clamped to the probe count");
  assert.equal(latencyDayLossPercent({ probeCount: 200, probeSuccesses: 190 }), 5);
  assert.equal(latencyDayLossPercent({ probeCount: 0, probeSuccesses: 0 }), null);
});

test("SQLite rollup aggregates raw samples per day, never double counts, and keeps 30 days", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-latency-daily-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const repo = await mod("server/repositories/latencyDailyRepository.ts");
    const shared = await mod("shared/latencyHistory.ts");
    const insert = (table, data) => runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.values(data).map(()=>'?').join(',')+')',Object.values(data));
    const nowMs = Date.UTC(2026, 9, 12, 6); // 2026-10-12 14:00 +08:00
    const now = Math.floor(nowMs / 1000);
    const today = shared.latencyDayStart(now);
    const yesterday = today - 86400;
    // 规则 7：昨天 3 条（一条整批超时、一条 10 次成功 9 次），今天 2 条。
    await insert("tcping_stats", { ruleId: 7, hostId: 1, latencyMs: 20, isTimeout: 0, probeCount: 10, probeSuccesses: 10, recordedAt: yesterday + 3600 });
    await insert("tcping_stats", { ruleId: 7, hostId: 1, latencyMs: 40, isTimeout: 0, probeCount: 10, probeSuccesses: 9, recordedAt: yesterday + 7200 });
    await insert("tcping_stats", { ruleId: 7, hostId: 1, latencyMs: null, isTimeout: 1, probeCount: 10, probeSuccesses: 0, recordedAt: yesterday + 10800 });
    await insert("tcping_stats", { ruleId: 7, hostId: 1, latencyMs: 30, isTimeout: 0, probeCount: 4, probeSuccesses: 4, recordedAt: today + 60 });
    // 还在 5 分钟延后窗口里的样本这一轮不算。
    await insert("tcping_stats", { ruleId: 7, hostId: 1, latencyMs: 999, isTimeout: 0, probeCount: 1, probeSuccesses: 1, recordedAt: now - 60 });
    // 隧道：只汇总总序列，分入口的子序列不算进去。
    await insert("tunnel_latency_stats", { tunnelId: 3, seriesKey: null, latencyMs: 50, isTimeout: 0, probeCount: 5, probeSuccesses: 5, recordedAt: today + 120 });
    await insert("tunnel_latency_stats", { tunnelId: 3, seriesKey: "total", latencyMs: 70, isTimeout: 0, probeCount: 5, probeSuccesses: 5, recordedAt: today + 180 });
    await insert("tunnel_latency_stats", { tunnelId: 3, seriesKey: "entry:9", latencyMs: 900, isTimeout: 0, probeCount: 5, probeSuccesses: 0, recordedAt: today + 180 });
    await insert("forward_group_latency_stats", { groupId: 4, latencyMs: 15, isTimeout: 0, probeCount: 2, probeSuccesses: 1, recordedAt: today + 240 });

    const through = await repo.rollupLatencyDailyStats(nowMs);
    assert.equal(through, now - 300);
    const rules = await repo.getLatencyDailyHistory("rule", [7, 8], nowMs);
    assert.deepEqual(rules.get(8), []);
    const days = rules.get(7);
    assert.equal(days.length, 2);
    assert.deepEqual(days[0], { dayStart: yesterday, probeCount: 30, probeSuccesses: 19, avgLatencyMs: Math.round((20*10 + 40*9) / 19), minLatencyMs: 20, maxLatencyMs: 40 });
    assert.deepEqual(days[1], { dayStart: today, probeCount: 4, probeSuccesses: 4, avgLatencyMs: 30, minLatencyMs: 30, maxLatencyMs: 30 });
    const tunnel = (await repo.getLatencyDailyHistory("tunnel", [3], nowMs)).get(3);
    assert.deepEqual(tunnel, [{ dayStart: today, probeCount: 10, probeSuccesses: 10, avgLatencyMs: 60, minLatencyMs: 50, maxLatencyMs: 70 }]);
    const group = (await repo.getLatencyDailyHistory("group", [4], nowMs)).get(4);
    assert.equal(group[0].probeCount, 2);
    assert.equal(group[0].probeSuccesses, 1);

    // 再跑一次：没有新样本就什么都不加。
    await repo.rollupLatencyDailyStats(nowMs);
    assert.deepEqual((await repo.getLatencyDailyHistory("rule", [7], nowMs)).get(7), days);

    // 十分钟后：上一轮延后的那条进来了，加到今天那一行上（累加，不是覆盖）。
    const later = nowMs + 10 * 60_000;
    await repo.rollupLatencyDailyStats(later);
    const after = (await repo.getLatencyDailyHistory("rule", [7], later)).get(7);
    assert.deepEqual(after[1], { dayStart: today, probeCount: 5, probeSuccesses: 5, avgLatencyMs: Math.round((30*4 + 999) / 5), minLatencyMs: 30, maxLatencyMs: 999 });
    assert.deepEqual(after[0], days[0], "finished days stay frozen");

    // 原始样本清掉以后历史还在：这是 30 天能看到的前提。
    await runtime.executeRaw('DELETE FROM tcping_stats');
    assert.equal((await repo.getLatencyDailyHistory("rule", [7], later)).get(7).length, 2);

    // 超过 30 天的行会被清掉；只返回最近 30 天。
    await insert("latency_daily_stats", { targetType: "rule", targetId: 7, dayStart: today - 40 * 86400, probeCount: 1, probeSuccesses: 1, latencySum: 1, latencyWeight: 1, updatedAt: now });
    await insert("latency_daily_stats", { targetType: "rule", targetId: 7, dayStart: today - 29 * 86400, probeCount: 1, probeSuccesses: 1, latencySum: 1, latencyWeight: 1, updatedAt: now });
    assert.equal((await repo.getLatencyDailyHistory("rule", [7], later)).get(7).length, 3, "only the latest 30 calendar days are returned");
    await repo.cleanOldLatencyDailyStats(later);
    const remaining = await runtime.queryRaw('SELECT "dayStart" FROM latency_daily_stats WHERE "targetId" = 7 ORDER BY "dayStart"');
    assert.deepEqual(remaining.map((row) => Number(row.dayStart)), [today - 29 * 86400, yesterday, today]);

    // 面板停了好几天：水位跳到原始样本还在的那一段，不去扫早就删光的区间。
    await runtime.executeRaw("UPDATE system_settings SET value = ? WHERE key = ?", [String(now - 10 * 86400), repo.LATENCY_DAILY_WATERMARK_KEY]);
    const resumed = await repo.rollupLatencyDailyStats(later);
    assert.equal(resumed, Math.floor(later / 1000) - 300);
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "latency.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") }, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("latency history procedures keep the same visibility as the latency charts", () => {
  const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const rules = source("server/routers/rules.selfTest.ts");
  const history = rules.slice(rules.indexOf("latencyHistory: protectedProcedure"), rules.indexOf("startSelfTest: protectedProcedure"));
  assert.match(history, /rule\.userId !== ctx\.user\.id/);
  const tunnels = source("server/routers/tunnels.ts");
  const batch = tunnels.slice(tunnels.indexOf("latencyHistoryBatch: protectedProcedure"), tunnels.indexOf("latencySparkBatch: protectedProcedure"));
  assert.match(batch, /Number\(tunnel\.userId\) === Number\(ctx\.user\.id\)/, "non-admins only get their own tunnels");
  assert.match(batch, /ctx\.user\.role === "admin" \? "admin" : ctx\.user\.id/, "cache keys never share another user's view");
  const groups = source("server/routers/forwardGroups.ts");
  const groupHistory = groups.slice(groups.indexOf("latencyHistory: protectedProcedure"));
  assert.match(groupHistory.slice(0, 400), /assertForwardGroupAccess\(input\.groupId, ctx\.user\)/);
});
