import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMigrationRuntimeExpectations,
  pruneMigrationSnapshotForPanelBackup,
  stripProxyDataFromSnapshot,
  remapRoutePathHosts,
  type MigrationImportedIds,
  type MigrationSnapshot,
} from "./migration";
import {
  approveMigrationRequest,
  consumeApprovedMigrationRequest,
  consumeTakeoverToken,
  createMigrationCode,
  createMigrationRequest,
  prepareTakeoverToken,
} from "./migrationCodes";

function snapshot(tables: MigrationSnapshot["tables"]): MigrationSnapshot {
  return {
    version: 1,
    exportedAt: 2_000_000,
    tables,
  };
}

const importedIds: MigrationImportedIds = {
  hosts: { 1: 101, 2: 102 },
  tunnels: { 10: 110 },
  forwardRules: { 20: 120, 21: 121 },
};

test("essential snapshot pruning keeps business data and removes rebuildable history", () => {
  const result = pruneMigrationSnapshotForPanelBackup({
    ...snapshot({
      users: [{ id: 1, username: "admin" }],
      forward_rules: [{ id: 2, userId: 1 }],
      traffic_stats: [{ id: 3, ruleId: 2 }],
      traffic_stat_buckets: [{ id: 4, ruleId: 2 }],
      host_metrics: [{ id: 5, hostId: 1 }],
    }),
    dataScope: "essential",
    takeoverToken: "takeover-token",
  });
  assert.equal(result.tables.users.length, 1);
  assert.equal(result.tables.forward_rules.length, 1);
  assert.equal(result.tables.traffic_stats, undefined);
  assert.equal(result.tables.traffic_stat_buckets, undefined);
  assert.equal(result.tables.host_metrics, undefined);
  assert.equal(result.takeoverToken, "takeover-token");
});

test("backup import reports partial success after row-level failures instead of throwing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-partial-import-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        tables: {
          forward_rules: [{
            id: 1,
            hostId: 999,
            userId: 999,
            name: "orphan",
            forwardType: "gost",
            protocol: "tcp",
            sourcePort: 12000,
            targetIp: "example.com",
            targetPort: 443,
          }],
        },
      });
      assert.equal(result.success, true);
      assert.equal(result.partial, true);
      assert.equal(result.skippedRows, 1);
      assert.match(result.warnings[0], /其余数据已经导入/);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("essential migration skips rebuildable history while SQLite direct migration copies the full database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-scope-migration-"));
  const sourcePath = path.join(directory, "source.db");
  const targetPath = path.join(directory, "target.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import BetterSqlite3 from "better-sqlite3";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    const sourcePath = process.env.FORWARDX_SOURCE_DB;
    const targetPath = process.env.SQLITE_PATH;
    const now = Math.floor(Date.now() / 1000);

    const source = new BetterSqlite3(sourcePath);
    await schema.ensureDatabaseSchema(source);
    source.prepare("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')").run();
    source.prepare("INSERT INTO auth_sessions (id, sid, userId, kind, expiresAt) VALUES (1, 'session-1', 1, 'browser', ?)").run(now + 3600);
    source.prepare("INSERT INTO hosts (id, name, ip, userId, isOnline, lastHeartbeat) VALUES (1, 'edge', '192.0.2.1', 1, 1, ?)").run(now);
    source.prepare("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId, isEnabled, isRunning) VALUES (1, 'tunnel', 1, 1, 22000, 1, 1, 1)").run();
    source.prepare("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, tunnelId, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete) VALUES (1, 1, 'rule', 'gost', 'tcp', 1, 12000, 'example.com', 443, 1, 1, 1, 0), (2, 1, 'deleted-rule', 'gost', 'tcp', 1, 12001, 'deleted.example.com', 443, 1, 0, 1, 1)").run();
    source.prepare("INSERT INTO host_metrics (id, hostId, cpuUsage, recordedAt) VALUES (1, 1, 77, ?)").run(now);
    source.prepare("INSERT INTO tcping_stats (id, ruleId, hostId, latencyMs, isTimeout, recordedAt) VALUES (1, 1, 1, 33, 0, ?)").run(now);
    source.prepare("INSERT INTO host_traffic_counters (id, hostId, bytesIn, bytesOut) VALUES (1, 1, 1000, 2000)").run();
    source.prepare("INSERT INTO traffic_stat_buckets (id, bucketStart, bucketMinutes, userId, ruleId, hostId, bytesIn, bytesOut, connections) VALUES (1, ?, 30, 1, 1, 1, 500, 600, 2)").run(now);
    source.prepare("INSERT INTO agent_traffic_reports (id, hostId, producerId, reportId, receivedAt) VALUES (1, 1, 'agent-producer', 'pending-report', ?)").run(now);
    source.prepare("UPDATE system_settings SET value = 'https://old.example.com' WHERE key = 'panelPublicUrl'").run();
    source.close();

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: sourcePath } });
      const exportProgress = [];
      const essential = await migration.exportMigrationSnapshot("https://old.example.com", {
        dataScope: "essential",
        onProgress: (progress) => exportProgress.push(progress),
      });
      assert.equal(essential.dataScope, "essential");
      assert.equal(essential.tables.users.length, 1);
      assert.equal(essential.tables.host_traffic_counters.length, 1);
      assert.equal(essential.tables.agent_traffic_reports.length, 1);
      assert.equal(essential.tables.host_metrics, undefined);
      assert.equal(essential.tables.tcping_stats, undefined);
      assert.equal(essential.tables.traffic_stat_buckets, undefined);
      assert.equal(essential.tables.config_audit_events, undefined);
      assert.equal(exportProgress[0].status, "reading");
      assert.equal(exportProgress.at(-1).status, "complete");
      assert.equal(exportProgress.at(-1).tableIndex, exportProgress.at(-1).tableTotal);
      const full = await migration.exportMigrationSnapshot("https://old.example.com", { dataScope: "full" });
      assert.equal(full.tables.traffic_stat_buckets.length, 1);
      await runtime.closeDatabase();

      const legacySource = new BetterSqlite3(sourcePath);
      legacySource.exec("DROP TABLE agent_traffic_reports");
      legacySource.close();

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: targetPath } });
      await schema.ensureDatabaseSchema();
      const direct = await migration.importDirectSqliteBackup({
        kind: "sqlite-direct",
        filePath: sourcePath,
        meta: {
          version: 1,
          format: "forwardx-sqlite-backup-v1",
          exportedAt: Date.now(),
          appVersion: "test",
          sourcePanelUrl: "https://old.example.com",
          takeoverToken: "TOKEN",
          dataScope: "full",
          byteLength: 1,
          sha256: "0".repeat(64),
        },
      }, "https://new.example.com");

      assert.equal(direct.result.transferMode, "sqlite-direct");
      assert.equal(direct.result.dataScope, "full");
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM users"))[0].count, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM host_metrics"))[0].count, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM tcping_stats"))[0].count, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_stat_buckets"))[0].count, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM agent_traffic_reports"))[0].count, 0);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM auth_sessions"))[0].count, 1);
      assert.equal(Number((await runtime.queryRaw("SELECT isOnline FROM hosts WHERE id = 1"))[0].isOnline), 0);
      assert.equal(Number((await runtime.queryRaw("SELECT isRunning FROM tunnels WHERE id = 1"))[0].isRunning), 0);
      assert.deepEqual(
        await runtime.queryRaw("SELECT id, isRunning, pendingDelete FROM forward_rules ORDER BY id"),
        [
          { id: 1, isRunning: 0, pendingDelete: 0 },
          { id: 2, isRunning: 0, pendingDelete: 1 },
        ],
      );
      assert.equal((await runtime.queryRaw("SELECT value FROM system_settings WHERE key = 'panelPublicUrl'"))[0].value, "https://new.example.com");
    } finally {
      await runtime.closeDatabase();
    }

    const unchangedSource = new BetterSqlite3(sourcePath, { readonly: true });
    assert.equal(Number(unchangedSource.prepare("SELECT isOnline FROM hosts WHERE id = 1").get().isOnline), 1);
    unchangedSource.close();
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        SQLITE_PATH: targetPath,
        FORWARDX_SOURCE_DB: sourcePath,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("快照不带设置表里的运行时缓存：导出时去掉，导入时也不收", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-runtime-cache-migration-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    // 出口报的端口按这个面板的主机、规则 ID 记（server/tunnelExitPorts），换个面板就对不上。
    const cacheKey = settings.RUNTIME_CACHE_SETTING_PREFIX + "tunnelExitPorts:1";
    const cacheValue = JSON.stringify([{ ruleId: 1, kind: "scheduler", port: 41002, entryHostIds: [2] }]);
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_SOURCE_DB } });
      await schema.ensureDatabaseSchema();
      await settings.setSetting(cacheKey, cacheValue);
      await settings.setSetting("trafficBillingEnabled", "true");
      const exported = await migration.exportMigrationSnapshot("https://old.example.com", { dataScope: "full" });
      const exportedKeys = exported.tables.system_settings.map((row) => String(row.key));
      assert.ok(exportedKeys.includes("trafficBillingEnabled"));
      assert.deepEqual(exportedKeys.filter((key) => key.startsWith(settings.RUNTIME_CACHE_SETTING_PREFIX)), []);
      await runtime.closeDatabase();

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TARGET_DB } });
      await schema.ensureDatabaseSchema();
      // 别处来的快照里带着也不收。
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        tables: {
          system_settings: [
            { key: "trafficBillingEnabled", value: "true" },
            { key: cacheKey, value: cacheValue },
          ],
        },
      });
      assert.equal(result.success, true);
      const keys = (await runtime.queryRaw("SELECT key FROM system_settings")).map((row) => String(row.key));
      assert.ok(keys.includes("trafficBillingEnabled"));
      assert.deepEqual(keys.filter((key) => key.startsWith(settings.RUNTIME_CACHE_SETTING_PREFIX)), []);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_SOURCE_DB: path.join(directory, "source.db"),
        FORWARDX_TARGET_DB: path.join(directory, "target.db"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("structured restore batches 3,000 rules, isolates invalid rows, and preserves cumulative traffic", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-structured-migration-"));
  const databasePath = path.join(directory, "target.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    const now = Math.floor(Date.now() / 1000);
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'temporary', 'admin')");

      const metrics = Array.from({ length: 10_000 }, (_, index) => ({
        id: 1_000 + index,
        hostId: 100,
        cpuUsage: index % 100,
        recordedAt: now + index,
      }));
      const rules = Array.from({ length: 3_000 }, (_, index) => ({
        id: 300 + index,
        hostId: 100,
        name: "rule-" + index,
        forwardType: "gost",
        protocol: index % 2 === 0 ? "tcp" : "udp",
        tunnelId: 200,
        sourcePort: 12_000 + index,
        targetIp: "target-" + index + ".example.com",
        targetPort: 20_000 + index,
        userId: 10,
        isEnabled: 1,
        isRunning: 1,
        pendingDelete: index === 0 ? 1 : 0,
      }));
      const buckets = Array.from({ length: 240 }, (_, index) => ({
        id: 3_000 + index,
        bucketStart: now + index * 1_800,
        bucketMinutes: 30,
        userId: 10,
        ruleId: 300,
        hostId: 100,
        bytesIn: 1_000 + index,
        bytesOut: 2_000 + index,
        connections: index,
        updatedAt: now,
      }));
      const progress = [];
      const startedAt = Date.now();
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        dataScope: "full",
        tables: {
          users: [{ id: 10, username: "admin", password: "source", role: "admin" }],
          hosts: [{ id: 100, name: "edge", ip: "192.0.2.1", userId: 10, isOnline: 1 }],
          tunnels: [{ id: 200, name: "tunnel", entryHostId: 100, exitHostId: 100, listenPort: 22000, userId: 10, isEnabled: 1, isRunning: 1 }],
          forward_rules: rules,
          host_metrics: [...metrics, { id: 99_999, hostId: 100, cpuUsage: 50, recordedAt: null }],
          forward_rule_traffic_counters: [{ id: 400, ruleId: 300, hostId: 100, userId: 10, bytesIn: 123456, bytesOut: 654321, connections: 7 }],
          user_traffic_counters: [{ id: 500, userId: 10, bytesIn: 123456, bytesOut: 654321, connections: 7 }],
          traffic_stat_buckets: buckets,
        },
      }, {
        onProgress: (value, step) => progress.push({ value, step }),
      });

      assert.equal(result.mode, "restore");
      assert.equal(result.partial, false);
      assert.equal(result.inserted.forward_rules, rules.length);
      assert.equal(result.inserted.host_metrics, metrics.length);
      assert.equal(result.skipped.host_metrics, 1);
      assert.equal(result.inserted.traffic_stat_buckets, buckets.length);
      assert.equal(result.reused.users, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM host_metrics"))[0].count, metrics.length);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules"))[0].count, rules.length);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules WHERE isRunning <> 0"))[0].count, 0);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_stat_buckets"))[0].count, buckets.length);
      assert.deepEqual(
        await runtime.queryRaw("SELECT id, userId, isOnline FROM hosts WHERE id = 100"),
        [{ id: 100, userId: 1, isOnline: 0 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT id, hostId, userId, isRunning, pendingDelete FROM forward_rules WHERE id = 300"),
        [{ id: 300, hostId: 100, userId: 1, isRunning: 0, pendingDelete: 1 }],
      );
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules WHERE pendingDelete <> 0"))[0].count, 1);
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM forward_rule_traffic_counters WHERE id = 400"),
        [{ bytesIn: 123456, bytesOut: 654321, connections: 7 }],
      );
      assert.ok(progress.some((item) => item.step.includes("host_metrics") && item.step.includes("/")));
      assert.ok(new Set(progress.map((item) => item.value)).size > 5);
      assert.ok(Date.now() - startedAt < 15_000, "3,000-rule structured migration exceeded 15 seconds");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("incremental structured migration batches generated IDs and keeps valid rules when one row fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-incremental-migration-"));
  const databasePath = path.join(directory, "target.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'temporary', 'admin')");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, userId, agentToken) VALUES (1, 'existing', '192.0.2.1', 1, 'existing-token')");
      await runtime.executeRaw("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId) VALUES (1, 1, 'existing-rule', 'gost', 'tcp', 15000, 'existing.example.com', 443, 1)");
      await runtime.executeRaw("INSERT INTO forward_rule_traffic_counters (id, ruleId, hostId, userId, bytesIn, bytesOut, connections) VALUES (1, 1, 1, 1, 777, 888, 9)");
      await runtime.executeRaw("INSERT INTO user_traffic_counters (id, userId, bytesIn, bytesOut, connections) VALUES (1, 1, 777, 888, 9)");

      const rules = Array.from({ length: 3_000 }, (_, index) => ({
        id: 300 + index,
        hostId: 100,
        name: "incremental-rule-" + index,
        forwardType: "gost",
        protocol: index % 2 === 0 ? "tcp" : "udp",
        sourcePort: 16_000 + index,
        targetIp: "incremental-" + index + ".example.com",
        targetPort: 24_000 + index,
        userId: 10,
        isEnabled: true,
        isRunning: true,
      }));
      let importedIds = null;
      const startedAt = Date.now();
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        dataScope: "essential",
        tables: {
          users: [{ id: 10, username: "admin", password: "source", role: "admin" }],
          hosts: [{ id: 100, name: "new-edge", ip: "198.51.100.10", userId: 10, agentToken: "new-token", isOnline: true }],
          forward_rules: [
            ...rules,
            { id: 99_999, hostId: 100, name: null, forwardType: "gost", protocol: "tcp", sourcePort: 30_000, targetIp: "invalid.example.com", targetPort: 443, userId: 10 },
          ],
        },
      }, {
        onImportedIds: (value) => { importedIds = value; },
      });

      assert.equal(result.mode, "incremental");
      assert.equal(result.partial, true);
      assert.equal(result.inserted.forward_rules, rules.length);
      assert.equal(result.skipped.forward_rules, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules"))[0].count, rules.length + 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules WHERE isRunning <> 0"))[0].count, 0);
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM forward_rule_traffic_counters WHERE id = 1"),
        [{ bytesIn: 777, bytesOut: 888, connections: 9 }],
      );
      assert.ok(importedIds);
      assert.notEqual(importedIds.hosts[100], 100);
      const [importedHost] = await runtime.queryRaw("SELECT id, agentToken, isOnline FROM hosts WHERE id = ?", [importedIds.hosts[100]]);
      assert.equal(importedHost.agentToken, "new-token");
      assert.equal(importedHost.isOnline, 0);
      const [firstRule] = await runtime.queryRaw("SELECT id, hostId, userId FROM forward_rules WHERE name = ?", ["incremental-rule-0"]);
      assert.equal(firstRule.hostId, importedIds.hosts[100]);
      assert.equal(firstRule.userId, 1);
      assert.equal(importedIds.forwardRules[300], firstRule.id);
      assert.ok(Date.now() - startedAt < 15_000, "3,000-rule incremental migration exceeded 15 seconds");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration runtime expectations include fresh hosts and previously running resources", () => {
  const result = buildMigrationRuntimeExpectations(snapshot({
    hosts: [
      { id: 1, isOnline: true, lastHeartbeat: 1_990 },
      { id: 2, isOnline: true, lastHeartbeat: 1_000 },
    ],
    tunnels: [{ id: 10, isEnabled: true, isRunning: true }],
    forward_rules: [
      { id: 20, isEnabled: true, isRunning: true, pendingDelete: false },
      { id: 21, isEnabled: true, isRunning: false, pendingDelete: false },
    ],
  }), importedIds);

  assert.deepEqual(result.hostIds, [101]);
  assert.deepEqual(result.ruleIds, [120]);
  assert.deepEqual(result.tunnelIds, [110]);
  assert.deepEqual(result.allImportedHostIds, [101, 102]);
});

test("migration refuses active forwarding when no online Agent can be verified", () => {
  assert.throws(() => buildMigrationRuntimeExpectations(snapshot({
    hosts: [{ id: 1, isOnline: false, lastHeartbeat: 1_990 }],
    forward_rules: [{ id: 20, isEnabled: true, isRunning: true, pendingDelete: false }],
  }), importedIds), /没有可验证的在线 Agent/);
});

test("takeover token is target-bound and can only commit after prepare", () => {
  const code = createMigrationCode();
  const target = "https://new.example.com";
  const request = createMigrationRequest(code.code, target);
  assert.ok(request);
  assert.ok(approveMigrationRequest(request.id));
  const takeover = consumeApprovedMigrationRequest(request.id, code.code, target);
  assert.ok(takeover);

  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), false);
  assert.equal(prepareTakeoverToken(takeover.takeoverToken, "https://other.example.com"), null);
  assert.ok(prepareTakeoverToken(takeover.takeoverToken, target));
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, "https://other.example.com"), false);
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), true);
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), false);
});

test("migration approval binds the selected data scope and SQLite transfer request", () => {
  const code = createMigrationCode();
  const request = createMigrationRequest(code.code, "https://new.example.com", {
    dataScope: "full",
    targetDatabaseType: "sqlite",
    directSqliteRequested: true,
  });
  assert.equal(request?.dataScope, "full");
  assert.equal(request?.targetDatabaseType, "sqlite");
  assert.equal(request?.directSqliteRequested, true);
  assert.ok(request && approveMigrationRequest(request.id));
  const takeover = request
    ? consumeApprovedMigrationRequest(request.id, code.code, "https://new.example.com")
    : null;
  assert.equal(takeover?.dataScope, "full");
  assert.equal(takeover?.directSqliteRequested, true);
});

test("导入快照时线路组路径里的中转按主机 ID 映射走", () => {
  /*
    paths[].hops 每一项都是一台中转机的 ID。其余主机引用都过了映射，这一列是 JSON，
    照抄过来的话这些跳指向导入库里另一台机器：启动时的中继修复会在错误的机器上建中继，
    或者整条路径找不到主机而失效 —— 用户看到的是「线路组莫名其妙不通了」。
  */
  const maps = { hosts: new Map([[1, 101], [2, 102]]) } as any;
  const paths = [
    { key: "a", name: "主线路", hops: [1, 2], dest: null, weight: 50, probe: null, dial: null },
    { key: "b", name: "备用线路", hops: [], dest: { ip: "198.51.100.9", port: 443 }, weight: 50, probe: null, dial: null },
  ];
  const remapped = JSON.parse(String(remapRoutePathHosts(JSON.stringify(paths), maps)));
  assert.deepEqual(remapped.map((path: any) => path.hops), [[101, 102], []]);
  assert.equal(remapped[1].dest.ip, "198.51.100.9", "落地地址照旧");
  assert.equal(remapRoutePathHosts(null, maps), null, "没有线路组的规则照旧是 null");
  assert.throws(
    () => remapRoutePathHosts(JSON.stringify([{ key: "a", name: "A", hops: [7], dest: null, weight: 50 }]), maps),
    /依赖数据缺失/,
    "快照里缺这台中转就报错，不留一个错的主机 ID",
  );
});

test("导入快照时隧道 / 线路组的入口出口组和节点的前置代理按新 ID 补回", () => {
  /*
    这四列都指向「排在后面才导入」或「同一张表」的行：tunnels.entryGroupId / exitGroupId、
    forward_groups.entryGroupId、proxy_nodes.frontProxyId。以前原样照抄旧 ID，导入后
    指向了导入库里另一组 / 另一个节点。源 ID 故意从 50 起，和导入库生成的 1、2… 错开。
  */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-deferred-group-refs-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      // 导入库里先占住和快照相同的 ID，逼导入走增量合并、生成新 ID —— 否则恢复模式会
      // 沿用原 ID，映射是恒等的，测不出「照抄旧 ID」这个错。
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'existing', 'h', 'admin')");
      await exec("INSERT INTO hosts (id, name, ip, userId, agentToken) VALUES (1, 'existing', '192.0.2.1', 1, 'existing')");
      for (const id of [61, 62]) await exec("INSERT INTO forward_groups (id, name, targetIp, userId) VALUES (?, 'occupied', '', 1)", [id]);
      for (const id of [70, 71]) await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (?, 'occupied', 1, 1, ?, 1)", [id, 40000 + id]);
      for (const id of [81, 82]) await exec("INSERT INTO proxy_nodes (id, name, address, port, userId) VALUES (?, 'occupied', '192.0.2.9', 1, 1)", [id]);
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        tables: {
          users: [{ id: 57, username: "owner", password: "h", role: "admin" }],
          hosts: [
            { id: 50, name: "in", ip: "203.0.113.1", userId: 57, agentToken: "t50" },
            { id: 51, name: "out", ip: "203.0.113.2", userId: 57, agentToken: "t51" },
          ],
          // 61 的入口组是排在它后面的 62：同表自引用也得等第二遍。
          forward_groups: [
            { id: 61, name: "chain", groupMode: "failover", targetIp: "198.51.100.1", userId: 57, entryGroupId: 62 },
            { id: 62, name: "entry", groupMode: "entry", targetIp: "", userId: 57, entryGroupId: null },
          ],
          tunnels: [
            { id: 70, name: "t-bound", entryHostId: 50, exitHostId: 51, entryGroupId: 62, exitGroupId: 61, listenPort: 30001, userId: 57, mode: "tls", secret: "s" },
            // 源库里就悬空的出口组：置空，不报错、也不留一个指向别处的旧 ID。
            { id: 71, name: "t-dangling", entryHostId: 50, exitHostId: 51, entryGroupId: null, exitGroupId: 999, listenPort: 30002, userId: 57, mode: "tls", secret: "s" },
          ],
          proxy_nodes: [
            { id: 81, name: "via-front", address: "198.51.100.2", port: 443, userId: 57, frontProxyId: 82 },
            { id: 82, name: "front", address: "198.51.100.3", port: 443, userId: 57, frontProxyId: 0 },
          ],
        },
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(result.warnings || [], [], "都能映射上，不该有告警");
      const one = async (sql, params) => (await runtime.queryRaw(sql, params))[0];
      const entry = await one("SELECT id FROM forward_groups WHERE name = ?", ["entry"]);
      const chain = await one("SELECT id, entryGroupId FROM forward_groups WHERE name = ?", ["chain"]);
      assert.notEqual(Number(entry.id), 62, "测试前提：导入库生成了新 ID");
      assert.equal(Number(chain.entryGroupId), Number(entry.id));
      const bound = await one("SELECT entryGroupId, exitGroupId FROM tunnels WHERE name = ?", ["t-bound"]);
      assert.equal(Number(bound.entryGroupId), Number(entry.id));
      assert.equal(Number(bound.exitGroupId), Number(chain.id));
      const dangling = await one("SELECT entryGroupId, exitGroupId FROM tunnels WHERE name = ?", ["t-dangling"]);
      assert.equal(dangling.entryGroupId, null);
      assert.equal(dangling.exitGroupId, null);
      const front = await one("SELECT id, frontProxyId FROM proxy_nodes WHERE name = ?", ["front"]);
      const via = await one("SELECT frontProxyId FROM proxy_nodes WHERE name = ?", ["via-front"]);
      assert.equal(Number(via.frontProxyId), Number(front.id));
      assert.equal(Number(front.frontProxyId), 0);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("设置页反复拉数据概况时，同一个连接只补一次表结构；重连后再补", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-summary-schema-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    const originalExec = Database.prototype.exec;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };
    Database.prototype.exec = function (sql) {
      statements.push(String(sql));
      return originalExec.call(this, sql);
    };
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    const config = { type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } };
    // 补表结构就是逐表 CREATE TABLE IF NOT EXISTS；数这一类就知道补没补。
    const schemaChecks = () => statements.filter((sql) => /CREATE TABLE IF NOT EXISTS/i.test(sql)).length;
    try {
      await runtime.connectDatabase(config);
      statements = [];
      await migration.getPanelDataSummary();
      assert.ok(schemaChecks() > 0, "第一次要补表结构");
      migration.invalidatePanelDataSummaryCache();
      statements = [];
      await migration.getPanelDataSummary();
      assert.equal(schemaChecks(), 0, "同一个连接第二次不该再补");
      statements = [];
      await migration.getPanelDataSummary({ useCache: false });
      assert.ok(schemaChecks() > 0, "导入 / 迁移那几处（useCache: false）照旧每次都补");
      await runtime.closeDatabase();
      await runtime.connectDatabase(config);
      migration.invalidatePanelDataSummaryCache();
      statements = [];
      await migration.getPanelDataSummary();
      assert.ok(schemaChecks() > 0, "重连换了连接对象，要重新补");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("不带订阅与代理节点导出：整组表去掉，规则上的节点绑定清空，SS 出口数出来提醒", () => {
  const { snapshot: stripped, warnings } = stripProxyDataFromSnapshot(snapshot({
    users: [{ id: 1, username: "admin" }],
    forward_rules: [
      { id: 2, userId: 1, proxyNodeId: 7 },
      { id: 3, userId: 1, egressType: "ss_host", egressInboundId: 9 },
      { id: 4, userId: 1 },
    ],
    proxy_nodes: [{ id: 7 }],
    proxy_inbounds: [{ id: 9 }],
    proxy_sub_tokens: [{ id: 11 }],
    subscription_plan_proxy_nodes: [{ id: 12, nodeId: 7 }],
  }));
  assert.equal(stripped.tables.proxy_nodes, undefined);
  assert.equal(stripped.tables.proxy_inbounds, undefined);
  assert.equal(stripped.tables.proxy_sub_tokens, undefined);
  assert.equal(stripped.tables.subscription_plan_proxy_nodes, undefined);
  assert.equal(stripped.tables.users.length, 1);
  assert.equal(stripped.tables.forward_rules.length, 3, "规则一条不少");
  assert.equal(stripped.tables.forward_rules[0].proxyNodeId, null, "节点绑定清空，导入时不会因为依赖缺失失败");
  assert.equal(stripped.tables.forward_rules[1].egressInboundId, 9, "出口入站 id 留着，导入那边按直接连接落库");
  assert.deepEqual(warnings, [
    "1 条节点自动绑定的转发去掉了节点关联，导入后是普通转发",
    "1 条规则的 Shadowsocks 出口指向没导出的落地入站，导入后改为直接连接",
  ]);
  assert.deepEqual(stripProxyDataFromSnapshot(snapshot({ users: [{ id: 1 }] })).warnings, []);
});
