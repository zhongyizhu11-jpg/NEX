import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStatement,
  recordDatabaseStatement,
  statementFingerprint,
  takeDatabaseStatementStats,
  enableStatementFingerprints,
} from "./dbStatementStats";
import {
  applySlowQueryThresholdMs,
  clearSlowQueries,
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  listSlowQueries,
  normalizeSlowQueryThresholdMs,
} from "./slowQueryLog";
import { AgentHeartbeatGate } from "./agentHeartbeatGate";
import { shouldSendDesiredState } from "./agentHeartbeatDispatch";

test("statements are classified as read / write / other", () => {
  assert.equal(classifyStatement("  select 1"), "read");
  assert.equal(classifyStatement("WITH x AS (SELECT 1) SELECT * FROM x"), "read");
  assert.equal(classifyStatement("insert into t values (?)"), "write");
  assert.equal(classifyStatement("UPDATE hosts SET a = ?"), "write");
  assert.equal(classifyStatement("DELETE FROM t"), "write");
  assert.equal(classifyStatement("BEGIN IMMEDIATE"), "other");
  assert.equal(classifyStatement(""), "other");
});

test("fingerprints drop literals, numbers and IN-list lengths but keep the statement shape", () => {
  const a = statementFingerprint("SELECT * FROM hosts WHERE id IN (?, ?, ?) AND name = 'x' LIMIT 10");
  const b = statementFingerprint("SELECT *   FROM hosts WHERE id IN (?, ?) AND name = 'it''s' LIMIT 25");
  assert.equal(a, b);
  assert.equal(a, "SELECT * FROM hosts WHERE id IN (?…) AND name = ? LIMIT ?");
  // PostgreSQL 占位符 $1 和多行 VALUES 也归成同一种
  assert.equal(
    statementFingerprint("INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4), ($5, $6)"),
    statementFingerprint("INSERT INTO t (a, b) VALUES (?, ?)"),
  );
  assert.notEqual(statementFingerprint("SELECT a FROM t"), statementFingerprint("SELECT b FROM t"));
});

test("statement counters report deltas and reset", () => {
  enableStatementFingerprints(true);
  takeDatabaseStatementStats();
  recordDatabaseStatement("sqlite", "SELECT 1", performance.now() - 2);
  recordDatabaseStatement("sqlite", "SELECT 2", performance.now() - 1);
  recordDatabaseStatement("sqlite", "INSERT INTO t VALUES (1)", performance.now(), new Error("boom"));
  const stats = takeDatabaseStatementStats();
  assert.equal(stats.read, 2);
  assert.equal(stats.write, 1);
  assert.equal(stats.errors, 1);
  assert.ok(stats.readMs >= 2);
  assert.equal(stats.top[0].sql, "SELECT ?");
  assert.equal(stats.top[0].count, 2);
  const empty = takeDatabaseStatementStats();
  assert.equal(empty.read + empty.write + empty.other, 0);
  enableStatementFingerprints(false);
});

test("slow statements above the threshold are grouped by fingerprint; 0 turns the log off", () => {
  assert.equal(normalizeSlowQueryThresholdMs("abc"), DEFAULT_SLOW_QUERY_THRESHOLD_MS);
  assert.equal(normalizeSlowQueryThresholdMs(-1), DEFAULT_SLOW_QUERY_THRESHOLD_MS);
  assert.equal(normalizeSlowQueryThresholdMs(10_000_000), 60_000);
  applySlowQueryThresholdMs(50);
  clearSlowQueries();
  recordDatabaseStatement("sqlite", "SELECT * FROM traffic_stats WHERE ruleId = 1", performance.now() - 80);
  recordDatabaseStatement("sqlite", "SELECT * FROM traffic_stats WHERE ruleId = 2", performance.now() - 120);
  recordDatabaseStatement("sqlite", "SELECT 1", performance.now() - 1);
  const list = listSlowQueries();
  assert.equal(list.thresholdMs, 50);
  assert.equal(list.entries.length, 1, "fast statements are not recorded");
  const [entry] = list.entries;
  assert.equal(entry.fingerprint, "SELECT * FROM traffic_stats WHERE ruleId = ?");
  assert.equal(entry.count, 2);
  assert.ok(entry.maxMs >= 120);
  assert.ok(entry.avgMs >= 80);
  assert.equal(list.recent.length, 2);

  applySlowQueryThresholdMs(0);
  clearSlowQueries();
  recordDatabaseStatement("sqlite", "SELECT * FROM traffic_stats", performance.now() - 5000);
  assert.equal(listSlowQueries().entries.length, 0);
  applySlowQueryThresholdMs(DEFAULT_SLOW_QUERY_THRESHOLD_MS);
});

test("desired state is resent (at most once a minute) while the Agent reports an older applied hash", () => {
  const actions = [{ op: "apply", statusType: "rule", ruleId: 1, sourcePort: 20000, forwardType: "gost" }];
  const hostId = 987_654;
  assert.equal(shouldSendDesiredState(hostId, actions, [], 1_000, 7), true, "first delivery");
  assert.equal(shouldSendDesiredState(hostId, actions, [], 2_000, 7), false, "unchanged and acknowledged");
  assert.equal(shouldSendDesiredState(hostId, actions, [], 30_000, 7, true), false, "behind, but sent less than 60s ago");
  assert.equal(shouldSendDesiredState(hostId, actions, [], 62_000, 7, true), true, "behind for over 60s: resend");
  assert.equal(shouldSendDesiredState(hostId, actions, [], 200_000, 7, false), false, "caught up: no resend");
});

test("queued heartbeats get a retry hint by queue position and any of the first free slots may enter", () => {
  const gate = new AgentHeartbeatGate(1000, () => 10_000, 2);
  const first = gate.tryAcquire(1);
  const second = gate.tryAcquire(2);
  assert.ok(first && second);
  for (const hostId of [3, 4, 5, 6, 7, 8]) assert.equal(gate.tryAcquire(hostId), null);
  assert.equal(gate.retryHintSeconds(3), 3);
  assert.equal(gate.retryHintSeconds(8), 6, "five ahead with two slots per batch");
  assert.equal(gate.retryHintSeconds(99), 5, "not queued: the old fixed 5 seconds");
  first();
  second();
  // 两个位置空出来：排第二的先回来也能进，不必等队头
  const fourth = gate.tryAcquire(4);
  assert.ok(fourth, "second in line may take a free slot");
  assert.equal(gate.tryAcquire(6), null, "but not someone further back");
  const third = gate.tryAcquire(3);
  assert.ok(third);
  fourth();
  third();
});
