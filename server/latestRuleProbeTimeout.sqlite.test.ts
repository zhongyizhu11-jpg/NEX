import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("诊断判断主出口是不是在超时：只看这台机器、这段时间里最近的一次", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-probe-timeout-"));
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "p.db") } });
    await ensureDatabaseSchema();
    const { isLatestRuleProbeTimeout } = await import("./repositories/metricsRepository");
    const sec = Math.floor(Date.now() / 1000);
    const insert = (hostId: number, isTimeout: boolean, ago: number) => runtime.executeRaw(
      `INSERT INTO tcping_stats ("ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt") VALUES (5, ?, ?, ?, ?)`,
      [hostId, isTimeout ? null : 12, isTimeout ? 1 : 0, sec - ago],
    );
    const since = new Date(Date.now() - 5 * 60_000);
    assert.equal(await isLatestRuleProbeTimeout(5, 2, since), null, "没测过");
    await insert(2, false, 200);
    await insert(2, true, 30);
    await insert(3, false, 10);
    assert.equal(await isLatestRuleProbeTimeout(5, 2, since), true, "主出口最近一次超时（别的出口通不算）");
    await insert(2, false, 5);
    assert.equal(await isLatestRuleProbeTimeout(5, 2, since), false, "又通了");
    assert.equal(await isLatestRuleProbeTimeout(5, 2, new Date(Date.now() + 60_000)), null, "太早的不算");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
