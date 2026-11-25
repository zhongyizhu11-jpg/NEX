import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("forward self-test leases recover lost deliveries and give claimed work a fresh timeout", () => {
  runInDatabase(String.raw`
    try {
      const tests = await import(url("server/repositories/forwardTestRepository.ts"));
      const metrics = await import(url("server/repositories/metricsRepository.ts"));
      const indexColumns = runtime.getDatabaseKind() === "postgresql"
        ? (await query("SELECT i.relname AS name, array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS cols FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum WHERE t.relname = 'forward_tests' GROUP BY i.relname"))
          .map((row) => String(row.cols).split(","))
        : await Promise.all((await query('PRAGMA index_list("forward_tests")')).map(async (index) => (
          (await query('PRAGMA index_info("' + String(index.name).replaceAll('"', '""') + '")'))
            .map((column) => String(column.name))
        )));
      assert.equal(indexColumns.some((columns) => columns.join(",") === "status,createdAt"), true);
      assert.equal(indexColumns.some((columns) => columns.join(",") === "status,updatedAt"), true);
      const now = Math.floor(Date.now() / 1000);
      await exec(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [1, 0, 10, 1, "pending", now, now],
      );

      assert.equal(await tests.hasActiveForwardTests(), true);
      assert.deepEqual((await tests.getPendingForwardTestsByHost(10)).map((row) => Number(row.id)), [1]);
      assert.equal(await tests.markForwardTestRunning(1), true);
      assert.deepEqual(await tests.getPendingForwardTestsByHost(10), []);
      assert.equal(await tests.markForwardTestRunning(1), false);

      await exec('UPDATE "forward_tests" SET "updatedAt" = ? WHERE "id" = ?', [now - 20, 1]);
      assert.deepEqual((await tests.getPendingForwardTestsByHost(10)).map((row) => Number(row.id)), [1]);
      assert.equal(await tests.markForwardTestRunning(1), true);
      assert.equal(await tests.completeForwardTestIfActive(1, { status: "success", latencyMs: 12 }), true);
      assert.equal(await tests.completeForwardTestIfActive(1, { status: "failed" }), false);
      assert.equal(await tests.hasActiveForwardTests(), false);

      await exec(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [2, 0, 11, 1, "running", now - 60, now],
      );
      assert.equal(await tests.hasActiveForwardTests(), true);
      assert.deepEqual(await metrics.timeoutStaleForwardTests(30), []);
      assert.equal(await tests.completeForwardTestIfActive(2, { status: "success", latencyMs: 9 }), true);
      assert.equal(await tests.hasActiveForwardTests(), false);

      await exec(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [3, 0, 12, 1, "running", now - 60, now - 40],
      );
      const timedOut = await metrics.timeoutStaleForwardTests(30);
      assert.deepEqual(timedOut.map((row) => Number(row.id)), [3]);
      assert.equal(await tests.hasActiveForwardTests(), false);
      assert.equal(await tests.completeForwardTestIfActive(3, { status: "success", latencyMs: 9 }), false);
      const timeoutRow = (await query('SELECT "status" FROM "forward_tests" WHERE "id" = ?', [3]))[0];
      assert.equal(timeoutRow.status, "timeout");

      await exec(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "message", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          4, 4, 14, 1, "running", JSON.stringify({ kind: "direct" }), now - 60, now - 10,
          5, 0, 15, 1, "running", JSON.stringify({ kind: "tunnel", tunnelId: 5 }), now - 60, now - 10,
        ],
      );
      const timeoutForTest = (row) => {
        try {
          const kind = JSON.parse(String(row.message || "{}"))?.kind;
          return kind === "tunnel" ? 30 : 8;
        } catch {
          return 8;
        }
      };
      const shortTimeouts = await metrics.timeoutStaleForwardTests(8, timeoutForTest);
      assert.deepEqual(shortTimeouts.map((row) => [Number(row.id), Number(row.timeoutSeconds)]), [[4, 8]]);
      assert.equal(await tests.hasActiveForwardTests(), true);

      await exec('UPDATE "forward_tests" SET "updatedAt" = ? WHERE "id" = ?', [now - 40, 5]);
      const runtimeTimeouts = await metrics.timeoutStaleForwardTests(8, timeoutForTest);
      assert.deepEqual(runtimeTimeouts.map((row) => [Number(row.id), Number(row.timeoutSeconds)]), [[5, 30]]);
      assert.equal(await tests.hasActiveForwardTests(), false);

      await exec(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)',
        [
          6, 20, 20, 1, "success", now, now,
          7, 20, 20, 1, "failed", now, now,
        ],
      );
      const latestCompleted = await tests.getLatestForwardTest(20, { includeActive: false });
      assert.equal(Number(latestCompleted?.id), 7, "completed rows with equal timestamps must prefer the larger id");
      // 原生 SQL 拿到的是秒；返回前要换成 Date，否则前端 new Date(秒) 会落到 1970 年
      assert.ok(latestCompleted?.updatedAt instanceof Date, "updatedAt must come back as a Date");
      assert.equal(latestCompleted.updatedAt.getTime(), Number(now) * 1000);

      await exec(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)',
        [
          8, 20, 20, 1, "pending", now, now,
          9, 20, 20, 1, "running", now, now,
        ],
      );
      const latestActive = await tests.getLatestForwardTest(20);
      assert.equal(Number(latestActive?.id), 9, "active rows with equal timestamps must prefer the larger id");
    } finally {
    }
  `, { name: "selftest-dispatch" });
});
