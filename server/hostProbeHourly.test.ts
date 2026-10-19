import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 主机服务延迟图表能看 30 天：原始样本照旧只留 72 小时，按小时汇总进 host_probe_service_hourly。
// 这里测汇总口径、增量水位不重复计数、30 天清理，以及长范围读小时表、短范围读原始样本。

test("SQLite hourly rollup for host probes: aggregates per hour, never double counts, keeps 30 days", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-probe-hourly-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const repo = await mod("server/repositories/hostProbeHourlyRepository.ts");
    const insert = (table, data) => runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.values(data).map(()=>'?').join(',')+')',Object.values(data));
    const nowMs = Date.UTC(2026, 9, 12, 6, 30); // 整点后 30 分钟
    const now = Math.floor(nowMs / 1000);
    const hour = Math.floor(now / 3600) * 3600;
    const prev = hour - 3600;
    // 服务 5 在主机 1：上一小时 3 条（一条整批超时、一条 10 次成功 9 次），这一小时 1 条，另有一条还在 5 分钟延后窗口里。
    await insert("host_probe_service_stats", { serviceId: 5, hostId: 1, latencyMs: 20, isTimeout: 0, probeCount: 10, probeSuccesses: 10, recordedAt: prev + 60 });
    await insert("host_probe_service_stats", { serviceId: 5, hostId: 1, latencyMs: 40, isTimeout: 0, probeCount: 10, probeSuccesses: 9, recordedAt: prev + 120 });
    await insert("host_probe_service_stats", { serviceId: 5, hostId: 1, latencyMs: null, isTimeout: 1, probeCount: 10, probeSuccesses: 0, recordedAt: prev + 180 });
    await insert("host_probe_service_stats", { serviceId: 5, hostId: 1, latencyMs: 30, isTimeout: 0, probeCount: 4, probeSuccesses: 4, recordedAt: hour + 60 });
    await insert("host_probe_service_stats", { serviceId: 5, hostId: 1, latencyMs: 999, isTimeout: 0, probeCount: 1, probeSuccesses: 1, recordedAt: now - 60 });
    // 同一个服务在另一台主机上单独一行。
    await insert("host_probe_service_stats", { serviceId: 5, hostId: 2, latencyMs: 80, isTimeout: 0, probeCount: 2, probeSuccesses: 2, recordedAt: hour + 90 });

    assert.equal(await repo.rollupHostProbeHourlyStats(nowMs), now - 300);
    const rows = async () => runtime.queryRaw('SELECT "serviceId","hostId","hourStart","probeCount","probeSuccesses","latencySum","latencyWeight","minLatencyMs","maxLatencyMs" FROM host_probe_service_hourly ORDER BY "hostId","hourStart"');
    const first = (await rows()).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v == null ? null : Number(v)])));
    assert.deepEqual(first, [
      { serviceId: 5, hostId: 1, hourStart: prev, probeCount: 30, probeSuccesses: 19, latencySum: 20*10 + 40*9, latencyWeight: 19, minLatencyMs: 20, maxLatencyMs: 40 },
      { serviceId: 5, hostId: 1, hourStart: hour, probeCount: 4, probeSuccesses: 4, latencySum: 120, latencyWeight: 4, minLatencyMs: 30, maxLatencyMs: 30 },
      { serviceId: 5, hostId: 2, hourStart: hour, probeCount: 2, probeSuccesses: 2, latencySum: 160, latencyWeight: 2, minLatencyMs: 80, maxLatencyMs: 80 },
    ]);

    // 再跑一次：没有新样本就什么都不加。
    await repo.rollupHostProbeHourlyStats(nowMs);
    assert.equal((await rows()).length, 3);
    assert.equal(Number((await rows())[0].probeCount), 30);

    // 十分钟后：延后的那条进来了，累加到这一小时那行上。
    const later = nowMs + 10 * 60_000;
    await repo.rollupHostProbeHourlyStats(later);
    const current = (await rows())[1];
    assert.equal(Number(current.probeCount), 5);
    assert.equal(Number(current.maxLatencyMs), 999);

    // 原始样本清掉以后还能画 7 天：点和原始曲线同一个样子，按主机过滤。
    await runtime.executeRaw('DELETE FROM host_probe_service_stats');
    const week = await repo.getHostProbeServiceHourlySeries({ serviceIds: [5], hostId: 1, hours: 168, nowMs: later });
    assert.equal(week.length, 2);
    assert.deepEqual(week[0], { serviceId: 5, hostId: 1, latencyMs: Math.round((20*10 + 40*9) / 19), isTimeout: false, probeCount: 30, probeSuccesses: 19, recordedAt: new Date(prev * 1000) });
    // 30 天按 3 小时一个点：两小时并成一个点（若跨了 3 小时边界则是两个点）。
    const month = await repo.getHostProbeServiceHourlySeries({ serviceIds: [5], hostId: 1, hours: 720, nowMs: later });
    const sameBucket = Math.floor(prev / 10800) === Math.floor(hour / 10800);
    assert.equal(month.length, sameBucket ? 1 : 2);
    assert.equal(month.reduce((sum, row) => sum + row.probeCount, 0), 35);

    // 超过 30 天的行会被清掉。
    await insert("host_probe_service_hourly", { serviceId: 5, hostId: 1, hourStart: hour - 40 * 86400, probeCount: 1, probeSuccesses: 1, latencySum: 1, latencyWeight: 1, updatedAt: now });
    await insert("host_probe_service_hourly", { serviceId: 5, hostId: 1, hourStart: hour - 29 * 86400, probeCount: 1, probeSuccesses: 1, latencySum: 1, latencyWeight: 1, updatedAt: now });
    await repo.cleanOldHostProbeHourlyStats(later);
    const remaining = await runtime.queryRaw('SELECT "hourStart" FROM host_probe_service_hourly WHERE "hostId" = 1 ORDER BY "hourStart"');
    assert.deepEqual(remaining.map((row) => Number(row.hourStart)), [hour - 29 * 86400, prev, hour]);

    // 删主机 / 删服务时一起清掉。
    await repo.deleteHostProbeHourlyStats({ hostId: 2 });
    assert.equal((await runtime.queryRaw('SELECT 1 FROM host_probe_service_hourly WHERE "hostId" = 2')).length, 0);
    await repo.deleteHostProbeHourlyStats({ serviceId: 5 });
    assert.equal((await rows()).length, 0);

    // 面板停了好几天：水位跳到原始样本还在的那一段。
    await runtime.executeRaw("UPDATE system_settings SET value = ? WHERE key = ?", [String(now - 10 * 86400), repo.HOST_PROBE_HOURLY_WATERMARK_KEY]);
    assert.equal(await repo.rollupHostProbeHourlyStats(later), Math.floor(later / 1000) - 300);
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "probe.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") }, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("服务延迟接口：72 小时以内读原始样本，更长读小时表，最长 30 天", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server/routers/hosts.ts"), "utf8");
  const procedure = source.slice(source.indexOf("probeServiceSeries: protectedProcedure"), source.indexOf("createProbeService: adminProcedure"));
  assert.match(procedure, /hours: z\.number\(\)\.min\(0\.5\)\.max\(24 \* 30\)/);
  assert.match(procedure, /if \(hours > HOST_PROBE_RAW_MAX_HOURS\) return getHostProbeServiceHourlySeries/);
  // 权限过滤在分流之前：非管理员只看得到自己的服务。
  assert.ok(procedure.indexOf("visibleIds.has(id)") < procedure.indexOf("getHostProbeServiceHourlySeries"));
});
