import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { splitCounterDelta } from "./hostRateBuckets";

test("两次心跳之间的流量按时间比例摊进它跨过的 5 分钟桶", () => {
  // 04:00 到 06:00（跨过 05:00 的桶边界）一共 120 秒、1200 字节：两个桶各 60 秒、各 600 字节
  const base = Date.UTC(2026, 10, 10, 0, 0, 0);
  const pieces = splitCounterDelta(base + 240_000, base + 360_000, 1200, 2400);
  assert.deepEqual(pieces.map((piece) => [piece.bucketStart, piece.bytesIn, piece.bytesOut, piece.coveredSeconds]), [
    [base / 1000, 600, 1200, 60],
    [base / 1000 + 300, 600, 1200, 60],
  ]);
  // 同一个桶里：整段归它
  assert.deepEqual(splitCounterDelta(base + 10_000, base + 40_000, 90, 0).map((piece) => piece.coveredSeconds), [30]);
  // 时间倒着走：不摊
  assert.deepEqual(splitCounterDelta(base + 40_000, base + 10_000, 90, 0), []);
});

/**
 * 接上真库（SQLite）跑一遍：95 计费的主机心跳攒出 5 分钟桶写进库，固定费用的不写；
 * 账本读得到费用折算、到期（周期顺延的按账单日往后推）、已用量和 95 值。
 */
test("主机账本接上真库：只有 95 计费的主机记桶，账本读得到费用、到期、流量和 95 值", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-ledger-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const rate = await import(url("server/hostRateBuckets.ts"));
      const ledger = await import(url("server/routers/hostLedger.ts"));
      const time = await import(url("shared/billingTime.ts"));

      await runtime.executeRaw("INSERT INTO users (id, username, password, role, email) VALUES (1, 'admin', 'h', 'admin', 'ops@example.com')");
      const nowMs = time.billingDateTime(2026, 11, 11, 12).getTime();
      const sec = (ms) => Math.floor(ms / 1000);
      // 1 号：季付 90 元，每月 1 号重置、额度 1000G；2 号：95 计费、5 美元底价 + 每 Mbps 1 美元；
      // 3 号：周期顺延的年付机，停机时间已经过了，账单日 3 月 15 日。新列不填，看默认值。
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, costCents, costCurrency, billingCycleMonths, trafficLimit, trafficAutoReset, trafficResetDay, stoppedAt) VALUES (1, '港-1', '203.0.113.1', 'slave', 't1', 1, 9000, 'CNY', 3, ?, 1, 1, ?)", [1000 * 1024 ** 3, sec(time.billingDateTime(2026, 11, 20).getTime())]);
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, costCents, costCurrency, bandwidthBilling, p95PriceCents, billingDay) VALUES (2, '日-1', '203.0.113.2', 'slave', 't2', 1, 500, 'USD', 'p95', 100, 1)");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, costCents, billingCycleMonths, billingMonth, billingDay, expiryHandling, stoppedAt) VALUES (3, '美-1', '203.0.113.3', 'slave', 't3', 1, 12000, 12, 3, 15, 'extend_cycle', ?)", [sec(time.billingDateTime(2026, 3, 15).getTime())]);
      const defaults = (await runtime.queryRaw("SELECT costCents, costCurrency, bandwidthBilling, p95PriceCents FROM hosts WHERE id = 3"))[0];
      assert.deepEqual([Number(defaults.p95PriceCents), defaults.costCurrency, defaults.bandwidthBilling], [0, "CNY", "fixed"]);

      // 港-1 的计数器：本月已用 500G（双向）
      await runtime.executeRaw("INSERT INTO host_traffic_counters (hostId, bytesIn, bytesOut, createdAt, updatedAt) VALUES (1, ?, ?, ?, ?)", [200 * 1024 ** 3, 300 * 1024 ** 3, sec(time.billingDateTime(2026, 10, 1).getTime()), sec(nowMs)]);

      // 固定费用的主机心跳：一个桶都不记
      const fixedHost = { id: 1, bandwidthBilling: "fixed" };
      const t0 = time.billingDateTime(2026, 11, 11, 10).getTime();
      for (let i = 0; i <= 40; i += 1) {
        assert.equal(await rate.recordHostRateSample(fixedHost, { atMs: t0 + i * 30_000, networkIn: i * 1e6, networkOut: i * 2e6 }), 0);
      }
      // 95 计费的主机：每 30 秒一次心跳，出方向 10 Mbps（每 30 秒 37.5 MB），入方向 5 Mbps
      const p95Host = { id: 2, bandwidthBilling: "p95" };
      let written = 0;
      for (let i = 0; i <= 40; i += 1) {
        written += await rate.recordHostRateSample(p95Host, { atMs: t0 + i * 30_000, networkIn: i * 18_750_000, networkOut: i * 37_500_000 });
      }
      // 20 分钟 = 4 个完整的桶落库，第五个还开着留在内存里
      assert.equal(written, 4);
      const rows = await runtime.queryRaw("SELECT hostId, bucketStart, bytesOut, coveredSeconds FROM host_rate_buckets ORDER BY bucketStart");
      assert.equal(rows.length, 4);
      assert.ok(rows.every((row) => Number(row.hostId) === 2));
      assert.ok(rows.every((row) => Number(row.coveredSeconds) === 300), JSON.stringify(rows));
      assert.ok(rows.every((row) => Math.abs(Number(row.bytesOut) - 375_000_000) <= 1), JSON.stringify(rows));
      // 同一个桶再写一次是累加（面板重启前后各记了半个桶），覆盖秒数封顶 300
      await rate.upsertHostRateBuckets(2, [{ bucketStart: Number(rows[0].bucketStart), bytesIn: 1, bytesOut: 1, coveredSeconds: 200 }]);
      const merged = (await runtime.queryRaw("SELECT bytesOut, coveredSeconds FROM host_rate_buckets WHERE bucketStart = ?", [Number(rows[0].bucketStart)]))[0];
      assert.deepEqual([Number(merged.bytesOut), Number(merged.coveredSeconds)], [375_000_001, 300]);
      // 心跳隔了一个小时（掉线）：不摊，不造假尖峰
      assert.equal(await rate.recordHostRateSample(p95Host, { atMs: t0 + 80 * 60_000, networkIn: 9e12, networkOut: 9e12 }), 0);
      const afterGap = await runtime.queryRaw("SELECT MAX(bytesOut) AS peak FROM host_rate_buckets");
      assert.ok(Number(afterGap[0].peak) < 400_000_000, String(afterGap[0].peak));

      const result = await ledger.loadHostLedger(nowMs);
      const byId = new Map(result.rows.map((row) => [row.hostId, row]));
      const hk = byId.get(1);
      assert.equal(hk.monthlyFixedCents, 3000);
      assert.equal(hk.usedBytes, 500 * 1024 ** 3);
      assert.equal(hk.expiry.daysLeft, 9);
      assert.equal(hk.projection.willExceed, true);
      const jp = byId.get(2);
      assert.equal(jp.currency, "USD");
      assert.equal(jp.p95.sufficient, false, "只有二十来分钟的样本，必须标样本不足");
      assert.equal(jp.p95.shortReason, "too_few");
      assert.ok(Math.abs(jp.p95.mbps - 10) < 0.01, String(jp.p95.mbps));
      // 周期顺延、停机时间已过：按年付、账单日 3 月 15 日推到 2027-03-15，不显示「已过期」
      const us = byId.get(3);
      assert.equal(us.expiry.expiresAtMs, time.billingDateTime(2027, 3, 15).getTime());
      assert.ok(us.expiry.daysLeft > 100);
      assert.equal(us.monthlyFixedCents, 1000);
      // 只读：库里的 stoppedAt 没被改
      const stored = (await runtime.queryRaw("SELECT stoppedAt FROM hosts WHERE id = 3"))[0];
      assert.equal(Number(stored.stoppedAt), sec(time.billingDateTime(2026, 3, 15).getTime()));
      assert.deepEqual(result.summary.monthlyByCurrency.map((item) => item.currency), ["CNY", "USD"]);
      assert.equal(result.summary.monthlyByCurrency[0].cents, 4000);
      assert.equal(result.summary.expiringWithin30Days, 1);

      // 清理只删 40 天以前的
      await rate.upsertHostRateBuckets(2, [{ bucketStart: sec(nowMs) - 50 * 86400, bytesIn: 1, bytesOut: 1, coveredSeconds: 300 }]);
      await rate.cleanOldHostRateBuckets(nowMs);
      const left = await runtime.queryRaw("SELECT COUNT(*) AS n FROM host_rate_buckets");
      assert.equal(Number(left[0].n), 4);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "host-ledger.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
