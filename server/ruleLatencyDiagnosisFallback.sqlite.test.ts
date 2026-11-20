import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  规则卡的延迟：入口实时 / 两段相加 → 定时探测 → 最近一次成功的诊断（2026-11 用户面板 2.3.542）。
  单出口链路 9 上的规则、nftables 转发组规则：没有定时探测，卡上原来空着，可诊断测过（8 ms / 202 ms）。
*/
test("没有定时探测的规则：卡上退回最近一次成功的诊断合计，时间是诊断的；有定时探测的照旧用探测", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-diagnosis-fallback-"));
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "d.db") } });
    await ensureDatabaseSchema();
    const exec = (sql: string, params: unknown[] = []) => runtime.executeRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);
    await exec(`INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')`);
    await exec(`INSERT INTO hosts (id, name, ip, "userId", "hostType") VALUES (1, 'Po0', '198.51.100.1', 1, 'slave'), (2, 'jinx', '198.51.100.2', 1, 'slave')`);
    await exec(`INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "forwardxVersion", "listenPort", "userId", secret, "isEnabled", "isRunning") VALUES (9, 'single', 1, 2, 'forwardx', 'v1', 40001, 1, 's', 1, 1)`);
    const columns = `(id, "hostId", name, "forwardType", protocol, "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning")`;
    await exec(`INSERT INTO forward_rules ${columns} VALUES (91, 1, 'via-tunnel', 'gost', 'tcp', 9, 30001, 'target.test', 443, 1, 1, 1)`);
    await exec(`INSERT INTO forward_rules ${columns} VALUES (92, 1, 'nft', 'nftables', 'tcp', NULL, 30002, 'target.test', 443, 1, 1, 1)`);
    await exec(`INSERT INTO forward_rules ${columns} VALUES (93, 1, 'probed', 'nftables', 'tcp', NULL, 30003, 'target.test', 443, 1, 1, 1)`);
    const testColumns = `("ruleId", "hostId", "userId", status, "latencyMs", message, "createdAt", "updatedAt")`;
    // 91：最近一次成功的诊断 8 ms；再往后一次失败了的不算（失败没有合计）
    await exec(`INSERT INTO forward_tests ${testColumns} VALUES (91, 1, 1, 'success', 11, '{}', ?, ?)`, [now - 3600, now - 3600]);
    await exec(`INSERT INTO forward_tests ${testColumns} VALUES (91, 1, 1, 'success', 8, '{}', ?, ?)`, [now - 600, now - 600]);
    await exec(`INSERT INTO forward_tests ${testColumns} VALUES (91, 1, 1, 'failed', NULL, '{}', ?, ?)`, [now - 60, now - 60]);
    await exec(`INSERT INTO forward_tests ${testColumns} VALUES (92, 1, 1, 'success', 202, '{}', ?, ?)`, [now - 300, now - 300]);
    // 93：有定时探测（12 ms），诊断再新也不顶它
    await exec(`INSERT INTO tcping_stats ("ruleId", "hostId", "latencyMs", "isTimeout", "probeCount", "probeSuccesses", "recordedAt") VALUES (93, 1, 12, 0, 3, 3, ?)`, [now - 120]);
    await exec(`INSERT INTO forward_tests ${testColumns} VALUES (93, 1, 1, 'success', 30, '{}', ?, ?)`, [now - 30, now - 30]);

    const metrics = await import("./repositories/metricsRepository");
    const rows = await metrics.getTrafficSummaryByRule({ ruleIds: [91, 92, 93] }) as Array<Record<string, any>>;
    const byRule = new Map(rows.map((row) => [Number(row.ruleId), row]));
    assert.equal(byRule.get(91)?.latestLatencyMs, 8);
    assert.equal(byRule.get(91)?.latestLatencySource, "diagnosis");
    assert.equal(byRule.get(91)?.latestLatencyIsTimeout, false);
    assert.equal(Math.floor(new Date(byRule.get(91)?.latestLatencyAt).getTime() / 1000), now - 600, "时间是那次诊断的：过期了卡上照旧灰掉");
    assert.equal(byRule.get(92)?.latestLatencyMs, 202);
    assert.equal(byRule.get(92)?.latestLatencySource, "diagnosis");
    assert.equal(byRule.get(93)?.latestLatencyMs, 12);
    assert.equal(byRule.get(93)?.latestLatencySource, "probe");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
