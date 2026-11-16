import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("负载均衡平时值起点：这台机器测这条规则的延迟记录里最近 24 小时的最低延迟", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const metrics = await import("./repositories/metricsRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-floor-"));
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "floor.db") } });
    await ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    await runtime.withSqliteExclusive((sqlite) => {
      const insert = sqlite.prepare(
        `INSERT INTO tcping_stats (ruleId, hostId, latencyMs, isTimeout, recordedAt) VALUES (?, ?, ?, ?, ?)`,
      );
      sqlite.transaction(() => {
        for (let i = 0; i < 12; i += 1) insert.run(7, 1, 9 + (i % 4), 0, now - i * 60);
        insert.run(7, 1, null, 1, now - 30); // 超时的不算
        insert.run(7, 1, 3, 0, now - 2 * 86400); // 太久以前的不算
        insert.run(7, 2, 1, 0, now); // 别的机器测的不算
        for (let i = 0; i < 5; i += 1) insert.run(8, 1, 20, 0, now - i * 60); // 记录太少，不给
      })();
    });
    const floors = await metrics.getRuleLatencyFloors(1, [7, 8, 9], new Date((now - 86400) * 1000));
    assert.deepEqual(Array.from(floors.entries()), [[7, 9]]);
  } finally {
    await runtime.closeDatabase?.().catch?.(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
