import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 逐跳连接统计接上真库：脏行被挡掉、不存在的隧道不收、按组和按小时加总、导出 CSV。 */
test("connection stage stats ingest and aggregate against a real database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-conn-stats-"));
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
      const stats = await import(url("server/ops/connStats.ts"));
      const { connStatsRouter } = await import(url("server/routers/ops/connStats.ts"));

      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (1, '港-1', '203.0.113.1', 'slave', 'tok1', 1)");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (2, '日-1', '203.0.113.2', 'slave', 'tok2', 1)");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (3, '前置 A', '203.0.113.3', 'slave', 'tok3', 1)");
      await runtime.executeRaw("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (7, '港-日', 1, 2, 30000, 1)");
      const exists = async (id) => id === 7;
      const now = Date.now();
      const entryRow = { tunnelId: 7, ruleId: 3, role: "entry", stage: "tcp", endpoint: "203.0.113.2:30000", attempts: 10, failures: 2, sumMs: 400, maxMs: 120, buckets: [6, 1, 1, 0, 0, 0], lastError: "timeout" };
      const saved = await stats.recordConnStatsReport(1, [
        entryRow,
        { ...entryRow, stage: "pool", attempts: 30, failures: 0, sumMs: 0, maxMs: 0, buckets: [30, 0, 0, 0, 0, 0], lastError: null },
        { ...entryRow, tunnelId: 99 },          // 隧道不存在
        { ...entryRow, role: "hacker" },        // 角色不认
        { ...entryRow, endpoint: "<b>x</b>" },  // 端点不认
        { ...entryRow, attempts: 0 },           // 没有尝试
      ], { nowMs: now - 2 * 3600_000, tunnelExists: exists });
      assert.equal(saved, 2);
      await stats.recordConnStatsReport(1, [{ ...entryRow, failures: 0, lastError: null }], { nowMs: now, tunnelExists: exists });
      await stats.recordConnStatsReport(2, [{ tunnelId: 7, ruleId: 3, role: "exit", stage: "target", endpoint: "198.51.100.9:443", attempts: 5, failures: 1, sumMs: 80, maxMs: 30, buckets: [4, 0, 0, 0, 0, 0], lastError: "connection refused" }], { nowMs: now, tunnelExists: exists });

      // 单连接叠加的每一路：前置 A（relay#3）两分钟前拨了一次、跑了 75 MB；刚才又报了一分钟流量（没有新拨号）。
      // 另有一路是同一条线开的第 2 路并发，via 乱写的会被清成空。
      const legRow = { tunnelId: 7, ruleId: 3, role: "entry", stage: "leg", endpoint: "203.0.113.3:31000", via: "relay#3", attempts: 1, failures: 0, sumMs: 30, maxMs: 30, buckets: [1, 0, 0, 0, 0, 0], bytesUp: 25_000_000, bytesDown: 50_000_000 };
      assert.equal(await stats.recordConnStatsReport(1, [legRow], { nowMs: now - 120_000, tunnelExists: exists }), 1);
      assert.equal(await stats.recordConnStatsReport(1, [
        { ...legRow, attempts: 0, failures: 0, sumMs: 0, maxMs: 0, buckets: [0, 0, 0, 0, 0, 0], bytesUp: 0, bytesDown: 37_500_000 },
        { ...legRow, via: "stream#2", endpoint: "203.0.113.2:30000", bytesUp: 0, bytesDown: 12_500_000 },
        { ...legRow, via: "<script>", attempts: 0, bytesUp: 0, bytesDown: 0 }, // 既没拨号也没流量：不收
        { ...entryRow, attempts: 0, bytesUp: 100 },                            // 不是 leg 的字节数不算，也就没有尝试
      ], { nowMs: now, tunnelExists: exists }), 2);

      const result = await stats.getTunnelConnStats(7, 24, now);
      assert.ok(result.groups.every((group) => group.stage !== "leg"), "每一路不混进阶段表");
      assert.equal(result.legs.length, 2);
      const relayLeg = result.legs.find((leg) => leg.via === "relay#3");
      assert.equal(relayLeg.summary.attempts, 1);
      assert.equal(relayLeg.bytesUp, 25_000_000);
      assert.equal(relayLeg.bytesDown, 87_500_000);
      // 最近 5 分钟下行 87.5 MB：87.5e6 × 8 ÷ 300 ≈ 2.3 Mbps。
      assert.equal(result.legRecentSeconds, 300);
      assert.equal(relayLeg.recentDownMbps, 2.3);
      assert.equal(relayLeg.sharePercent, 90);
      const tcp = result.groups.find((group) => group.stage === "tcp");
      assert.equal(tcp.summary.attempts, 20);
      assert.equal(tcp.summary.failures, 2);
      assert.equal(tcp.summary.successRate, 90);
      assert.equal(tcp.lastError, "timeout");
      const target = result.groups.find((group) => group.stage === "target");
      assert.equal(target.hostId, 2);
      assert.equal(target.lastError, "connection refused");
      assert.ok(result.hourly.length >= 3);
      assert.ok(result.hourly.every((row) => row.hourAt % 3600 === 0));

      const caller = connStatsRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1", socket: {} },
        res: { cookie() {}, clearCookie() {} },
        user: { id: 1, role: "admin", username: "admin" },
        authSession: null,
        authFailureReason: null,
      });
      const view = await caller.tunnel({ tunnelId: 7, hours: 24 });
      assert.equal(view.tunnel.name, "港-日");
      assert.ok(view.groups.some((group) => group.hostName === "日-1"));
      assert.deepEqual(view.legs.map((leg) => leg.legName).sort(), ["前置 A", "第 2 路"]);
      const csv = await caller.export({ tunnelId: 7, hours: 24, format: "csv" });
      assert.match(csv.content, /日-1,exit,target,198\.51\.100\.9:443/);
      assert.match(csv.content, /港-1,entry,leg,203\.0\.113\.3:31000,.*,前置 A,25000000,87500000/);
      await assert.rejects(() => caller.tunnel({ tunnelId: 99, hours: 24 }), /隧道不存在/);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "conn-stats.db"),
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
