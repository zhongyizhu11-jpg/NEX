import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  手动逐跳测试（转发链 / 隧道）的批次落在数据库里：面板在 Agent 回结果之前重启，结果回来后照样
  汇总；超时、迟到的重复上报、续租都不会把批次算错。每个阶段是一个独立进程 = 一次真实的面板重启。
*/
test("manual probe batches survive a panel restart, time out from first dispatch and settle once", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-manual-probe-"));
  const databasePath = path.join(directory, "probe.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    const stage = process.env.NEX_PROBE_STAGE;
    try {
      if (stage === "seed") {
        // Start from the pre-upgrade table: the new columns arrive by additive migration.
        await runtime.executeRaw("CREATE TABLE forward_tests (id INTEGER PRIMARY KEY AUTOINCREMENT, ruleId INTEGER NOT NULL, hostId INTEGER NOT NULL, userId INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', listenOk INTEGER NOT NULL DEFAULT 0, targetReachable INTEGER NOT NULL DEFAULT 0, forwardOk INTEGER NOT NULL DEFAULT 0, latencyMs INTEGER, message TEXT, createdAt INTEGER NOT NULL DEFAULT (unixepoch()), updatedAt INTEGER NOT NULL DEFAULT (unixepoch()))");
      }
      await (await import(url("server/dbSchema.ts"))).ensureDatabaseSchema();
      const db = await import(url("server/db.ts"));
      const tests = await import(url("server/repositories/forwardTestRepository.ts"));
      const metrics = await import(url("server/repositories/metricsRepository.ts"));
      const chain = await import(url("server/forwardChainManualProbe.ts"));
      const tunnelProbe = await import(url("server/tunnelManualProbe.ts"));
      const scheduler = await import(url("server/scheduler.ts"));
      const selfTestTiming = await import(url("server/selfTestTiming.ts"));
      const { Router } = await import("express");
      const { registerAgentSelfTestRoutes } = await import(url("server/agentSelfTestRoutes.ts"));
      const agentRouter = Router();
      registerAgentSelfTestRoutes(agentRouter);
      const route = (p) => agentRouter.stack.find((layer) => layer.route?.path === p).route.stack[0].handle;
      const agent = async (p, hostId, body) => {
        let result; let status = 200;
        const res = { json: (value) => { result = value; return res; }, status: (code) => { status = code; return res; } };
        await route(p)({ agentToken: "token-" + hostId, body, headers: {} }, res);
        return { status, body: result };
      };
      const rowsOf = (batchId) => runtime.queryRaw('SELECT * FROM "forward_tests" WHERE "batchId" = ? ORDER BY "id"', [batchId]);
      const now = Math.floor(Date.now() / 1000);
      const hop = (groupId, index, extra = {}) => ({
        ruleId: 0, hostId: index + 1, userId: 1, status: "pending",
        message: JSON.stringify({ kind: "forward-chain", groupId, targetIp: "192.0.2." + (index + 2), targetPort: 0,
          method: "ping", hopLabel: (index + 1) + "/2", routeLabel: "host-" + (index + 1) + " -> host-" + (index + 2), ...extra }),
      });

      if (stage === "seed") {
        for (let id = 1; id <= 3; id++) {
          await runtime.insertAndGetId("hosts", { id, name: "host-" + id, ip: "192.0.2." + id, userId: 1, agentToken: "token-" + id });
        }
        await runtime.insertAndGetId("tunnels", { id: 7, name: "t7", entryHostId: 1, exitHostId: 3, userId: 1, listenPort: 4003, mode: "tls", isRunning: true });

        // Forward chain batch, created atomically: a rollback leaves nothing behind.
        await assert.rejects(runtime.withDatabaseTransaction(async () => {
          await tests.createForwardTestBatch(chain.newForwardChainBatchId(), [hop(9, 0), hop(9, 1)]);
          throw new Error("rollback");
        }), /rollback/);
        assert.equal((await runtime.queryRaw('SELECT * FROM "forward_tests"')).length, 0);
        const batchId = chain.newForwardChainBatchId();
        const ids = await tests.createForwardTestBatch(batchId, [hop(9, 0), hop(9, 1)]);
        const created = await tests.getForwardTestById(ids[0]);
        assert.equal(created.batchId, batchId);
        assert.equal(created.requestMessage, created.message, "request payload kept apart from the result");
        await runtime.executeRaw('INSERT INTO "system_settings" ("key", "value") VALUES (?, ?)', ["test:fcBatch", batchId]);

        // Both hops are delivered; the first answers before the panel restarts.
        for (const hostId of [1, 2]) {
          const pulled = await agent("/api/agent/selftest-pull", hostId, {});
          assert.equal(pulled.body.selfTests.length, 1);
        }
        const first = await agent("/api/agent/selftest-result", 1, { testId: ids[0], targetReachable: true, latencyMs: 7, message: "ok" });
        assert.equal(first.status, 200);
        assert.equal(await chain.settleManualForwardChainBatch(batchId), false, "a hop is still outstanding");
        const kept = await tests.getForwardTestById(ids[0]);
        assert.equal(kept.message, "ok");
        assert.equal(JSON.parse(kept.requestMessage).hopLabel, "1/2", "dispatch payload survives the result");

        // Strict result validation.
        for (const bad of [{ testId: String(ids[1]), targetReachable: true, latencyMs: 3 }, { testId: 1.5, targetReachable: true, latencyMs: 3 },
          { testId: ids[1], targetReachable: "yes", latencyMs: 3 }, { testId: ids[1], targetReachable: true, latencyMs: null },
          { testId: ids[1], targetReachable: true, latencyMs: Number.NaN }]) {
          assert.equal((await agent("/api/agent/selftest-result", 2, bad)).status, 400, JSON.stringify(bad));
        }
        assert.equal((await tests.getForwardTestById(ids[1])).status, "running");

        // Tunnel multi-exit batch whose second branch will time out after the restart.
        const tpBatch = tunnelProbe.newTunnelProbeBatchId();
        const tunnelHop = (index) => ({ ruleId: 0, hostId: 1, userId: 1, message: JSON.stringify({ kind: "tunnel-hop", tunnelId: 7,
          targetIp: "192.0.2.3", targetPort: 4003 + index, hopLabel: "出口 " + (index + 1) + "/2", routeLabel: "host-1 -> exit-" + (index + 1),
          batchId: tpBatch, groupKey: "tunnel-7-load-balance", groupLabel: "多出口负载", latencyMode: "max" }) });
        const tpIds = await tests.createForwardTestBatch(tpBatch, [tunnelHop(0), tunnelHop(1)]);
        await db.updateTunnelTestResult(7, { status: "pending", latencyMs: null, message: "pending" });
        await runtime.executeRaw('INSERT INTO "system_settings" ("key", "value") VALUES (?, ?)', ["test:tpBatch", tpBatch]);
        await runtime.executeRaw('INSERT INTO "system_settings" ("key", "value") VALUES (?, ?)', ["test:tpIds", JSON.stringify(tpIds)]);
        // A periodic tunnel sample must not finish the pending manual test.
        await metrics.insertTunnelLatencyStat({ tunnelId: 7, latencyMs: 4, isTimeout: false }, { preserveMessage: true });
        assert.equal((await db.getTunnelById(7)).lastTestStatus, "pending");
        await agent("/api/agent/selftest-result", 1, { testId: tpIds[0], targetReachable: true, latencyMs: 12 });
      } else {
        // ---- after the restart: nothing in memory, only the database ----
        const setting = async (key) => (await runtime.queryRaw('SELECT "value" FROM "system_settings" WHERE "key" = ?', [key]))[0].value;
        const batchId = await setting("test:fcBatch");
        const [, secondId] = (await rowsOf(batchId)).map((row) => Number(row.id));
        const done = await agent("/api/agent/selftest-result", 2, { testId: secondId, targetReachable: true, latencyMs: 0.4, message: "ok" });
        assert.equal(done.status, 200);
        const summary = await tests.getLatestForwardTest(0, { includeActive: false });
        assert.equal(summary.id, secondId, "the last hop row carries the summary");
        assert.equal(summary.status, "success");
        assert.equal(summary.latencyMs, 8, "7ms + sub-millisecond hop rounded up to 1ms");
        assert.equal(JSON.parse(summary.message).kind, "forward-chain-hop-summary");
        assert.equal(JSON.parse(summary.message).details.length, 2);
        const groupStats = await runtime.queryRaw('SELECT * FROM "forward_group_latency_stats" WHERE "groupId" = 9');
        assert.equal(groupStats.length, 1);
        assert.equal(Number(groupStats[0].latencyMs), 8);
        // Duplicate report / concurrent settle / recovery: aggregated exactly once.
        assert.equal((await agent("/api/agent/selftest-result", 2, { testId: secondId, targetReachable: true, latencyMs: 9 })).body.ignored, true);
        await Promise.all([chain.settleManualForwardChainBatch(batchId), chain.recoverManualForwardChainBatches()]);
        assert.equal((await runtime.queryRaw('SELECT * FROM "forward_group_latency_stats" WHERE "groupId" = 9')).length, 1);

        // A finished batch whose summary was never written (panel exited in between) is recovered at startup.
        const orphan = chain.newForwardChainBatchId();
        for (const id of await tests.createForwardTestBatch(orphan, [hop(11, 0), hop(11, 1)])) {
          await tests.completeForwardTestIfActive(id, { status: "failed", message: "unreachable" });
        }
        await scheduler.recoverPendingSelfTestSweep();
        const orphanRows = await rowsOf(orphan);
        assert.equal(orphanRows.every((row) => Number(row.batchSettled) === 1), true);
        assert.match(String(orphanRows[1].message), /forward-chain-hop-summary/);
        assert.equal((await runtime.queryRaw('SELECT * FROM "forward_group_latency_stats" WHERE "groupId" = 11'))[0].isTimeout, 1);

        // Tunnel batch: the outstanding branch times out; the sweep aggregates from the DB.
        const tpBatch = await setting("test:tpBatch");
        const tpIds = JSON.parse(await setting("test:tpIds"));
        await runtime.executeRaw('UPDATE "forward_tests" SET "status" = \'running\', "firstDispatchedAt" = ?, "updatedAt" = ? WHERE "id" = ?', [now - 50, now - 50, tpIds[1]]);
        selfTestTiming.selfTestSweepActivity.markActive();
        await scheduler.runSelfTestTimeoutSweep();
        const tunnel = await db.getTunnelById(7);
        assert.equal(tunnel.lastTestStatus, "success", "one healthy exit is enough in load-balance (max) mode");
        assert.equal(tunnel.lastLatencyMs, 12);
        const tunnelSummary = JSON.parse(tunnel.lastTestMessage);
        assert.equal(tunnelSummary.kind, "tunnel-load-balance-summary");
        assert.match(tunnelSummary.details[1].message, /超时/);
        assert.equal(Number((await rowsOf(tpBatch))[0].batchSettled), 1);
        // A late report of the timed-out branch is ignored and cannot re-aggregate.
        assert.equal((await agent("/api/agent/selftest-result", 1, { testId: tpIds[1], targetReachable: true, latencyMs: 5 })).body.ignored, true);

        // A new test supersedes an unfinished batch of the same tunnel.
        const stale = tunnelProbe.newTunnelProbeBatchId();
        await tests.createForwardTestBatch(stale, [{ ruleId: 0, hostId: 1, userId: 1, message: JSON.stringify({ kind: "tunnel-hop", tunnelId: 7, hopLabel: "x", batchId: stale }) }]);
        assert.equal(await tunnelProbe.supersedeManualTunnelProbeBatches(7), 1);
        assert.equal(await tunnelProbe.supersedeManualTunnelProbeBatches(17), 0);

        // Lease renewal must not move the original deadline.
        const id = await tests.createForwardTest({ ruleId: 0, hostId: 3, userId: 1, message: JSON.stringify({ kind: "tunnel-hop", tunnelId: 7 }) });
        await runtime.executeRaw('UPDATE "forward_tests" SET "status" = \'running\', "firstDispatchedAt" = ?, "updatedAt" = ? WHERE "id" = ?', [now - 40, now - 10, id]);
        assert.equal(await tests.markForwardTestRunning(id), true, "lost delivery is redelivered");
        assert.equal(Math.floor((await tests.getForwardTestById(id)).firstDispatchedAt.getTime() / 1000), now - 40);
        await runtime.executeRaw('UPDATE "forward_tests" SET "firstDispatchedAt" = ?, "updatedAt" = ? WHERE "id" = ?', [now - 46, now - 9, id]);
        assert.equal((await tests.getPendingForwardTestsByHost(3)).length, 0, "past its deadline: not handed out again");
        assert.equal(await tests.markForwardTestRunning(id), false);
        assert.equal((await metrics.timeoutStaleForwardTests(8, () => 45)).some((row) => Number(row.id) === id), true,
          "times out from first dispatch even though updatedAt was renewed");
        const ancient = await tests.createForwardTest({ ruleId: 0, hostId: 3, userId: 1 });
        await runtime.executeRaw('UPDATE "forward_tests" SET "status" = \'running\', "createdAt" = ?, "firstDispatchedAt" = ?, "updatedAt" = ? WHERE "id" = ?', [now - 91, now, now, ancient]);
        assert.equal(await tests.markForwardTestRunning(ancient), false);
        assert.equal((await metrics.timeoutStaleForwardTests(8, () => 45)).some((row) => Number(row.id) === ancient), true, "maximum lifetime");

        // A tunnel stuck in "pending" by a pre-upgrade in-memory batch is released.
        await runtime.executeRaw('UPDATE "tunnels" SET "lastTestStatus" = \'pending\', "lastTestAt" = ? WHERE "id" = 7', [now - 600]);
        await tunnelProbe.recoverManualTunnelProbeBatches();
        assert.equal((await db.getTunnelById(7)).lastTestStatus, "failed");
      }
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    for (const stage of ["seed", "restart"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
        env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NEX_PROBE_STAGE: stage,
          FORWARDX_LOG_DIR: path.join(directory, "logs"), NODE_ENV: "test" },
      });
      assert.equal(result.status, 0, `${stage}: ${result.stderr || result.stdout}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
