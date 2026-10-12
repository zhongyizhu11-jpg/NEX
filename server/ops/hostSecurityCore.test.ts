import assert from "node:assert/strict";
import test from "node:test";
import {
  applyIncomingFinding,
  availableActions,
  decideFinding,
  findingsToResolve,
  normalizeSecurityReport,
} from "./hostSecurityCore";

const NOW = 1_800_000_000;

test("new finding opens and notifies only when high or critical", () => {
  const high = applyIncomingFinding(null, { severity: "high", since: NOW }, false);
  assert.equal(high.status, "open");
  assert.equal(high.notify, true);
  assert.equal(high.newEpisode, true);
  const low = applyIncomingFinding(null, { severity: "low", since: NOW }, false);
  assert.equal(low.status, "open");
  assert.equal(low.notify, false);
});

test("acknowledged finding stays quiet while the same episode continues", () => {
  const existing = { status: "acknowledged" as const, expectedScope: null, episodeAt: NOW, resolvedAt: null };
  const same = applyIncomingFinding(existing, { severity: "critical", since: NOW }, false);
  assert.equal(same.status, "acknowledged");
  assert.equal(same.reopened, false);
  assert.equal(same.notify, false);
});

test("acknowledged finding re-opens when it happens again later", () => {
  const existing = { status: "acknowledged" as const, expectedScope: null, episodeAt: NOW, resolvedAt: NOW + 300 };
  const again = applyIncomingFinding(existing, { severity: "critical", since: NOW + 900 }, false);
  assert.equal(again.status, "open");
  assert.equal(again.reopened, true);
  assert.equal(again.notify, true);
  assert.equal(again.episodeAt, NOW + 900);
  // 一条低危的重新打开：状态变，但不打扰人。
  const quiet = applyIncomingFinding(existing, { severity: "low", since: NOW + 900 }, false);
  assert.equal(quiet.status, "open");
  assert.equal(quiet.notify, false);
});

test("expected (host scope) never re-opens", () => {
  const existing = { status: "expected" as const, expectedScope: "host" as const, episodeAt: NOW, resolvedAt: null };
  const again = applyIncomingFinding(existing, { severity: "critical", since: NOW + 3600 }, false);
  assert.equal(again.status, "expected");
  assert.equal(again.expectedScope, "host");
  assert.equal(again.notify, false);
});

test("expected on all hosts applies to hosts that never saw it before", () => {
  const fresh = applyIncomingFinding(null, { severity: "critical", since: NOW }, true);
  assert.equal(fresh.status, "expected");
  assert.equal(fresh.expectedScope, "all");
  assert.equal(fresh.notify, false);
  // 已经开着的那条也收起来。
  const open = applyIncomingFinding({ status: "open", expectedScope: null, episodeAt: NOW, resolvedAt: null }, { severity: "high", since: NOW + 60 }, true);
  assert.equal(open.status, "expected");
  assert.equal(open.expectedScope, "all");
});

test("decisions map to statuses; reopen clears the scope", () => {
  assert.deepEqual(decideFinding("acknowledge"), { status: "acknowledged", expectedScope: null });
  assert.deepEqual(decideFinding("expected", "all"), { status: "expected", expectedScope: "all" });
  assert.deepEqual(decideFinding("expected"), { status: "expected", expectedScope: "host" });
  assert.deepEqual(decideFinding("reopen"), { status: "open", expectedScope: null });
});

test("a re-delivered event (same since) does not re-open", () => {
  const existing = { status: "acknowledged" as const, expectedScope: null, episodeAt: NOW, resolvedAt: null };
  assert.equal(applyIncomingFinding(existing, { severity: "high", since: NOW }, false).status, "acknowledged");
});

test("complete checks resolve persistent findings that are gone", () => {
  const ids = findingsToResolve([
    { id: 1, fingerprint: "aaaaaaaa", persistent: true, resolvedAt: null },
    { id: 2, fingerprint: "bbbbbbbb", persistent: true, resolvedAt: null },
    { id: 3, fingerprint: "cccccccc", persistent: false, resolvedAt: null },
    { id: 4, fingerprint: "dddddddd", persistent: true, resolvedAt: NOW },
  ], ["aaaaaaaa"]);
  assert.deepEqual(ids, [2]);
});

test("report normalization drops malformed findings and clamps fields", () => {
  const report = normalizeSecurityReport({
    checkedAt: NOW,
    baselineReady: true,
    complete: true,
    findings: [
      { fingerprint: "ABCDEF0123456789", kind: "miner_process", severity: "critical", title: "x", since: NOW - 10, at: NOW, evidence: { pid: 5, exe: "/tmp/x", nested: { a: 1 }, "bad key": 1 } },
      { fingerprint: "not hex!", kind: "miner_process" },
      { fingerprint: "abcdef01", kind: "Bad-Kind" },
    ],
    active: ["abcdef0123456789", "zz"],
    actionResults: [{ id: 3, ok: true, message: "ok", quarantineId: "q3-ab" }, { id: 0 }],
  }, NOW);
  assert.ok(report);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].fingerprint, "abcdef0123456789");
  assert.deepEqual(report.findings[0].evidence, { pid: 5, exe: "/tmp/x" });
  assert.deepEqual(report.active, ["abcdef0123456789"]);
  assert.equal(report.actionResults.length, 1);
  assert.equal(normalizeSecurityReport("nope"), null);
});

test("only process findings offer actions; quarantine needs a hash", () => {
  assert.deepEqual(availableActions("miner_process", { pid: 10, exe: "/tmp/x", sha256: "ab" }, false), ["kill", "quarantine"]);
  assert.deepEqual(availableActions("miner_process", { pid: 10, exe: "/tmp/x", sha256: "ab" }, true), ["kill", "restore"]);
  assert.deepEqual(availableActions("suspicious_process", { pid: 10, exe: "/root/a" }, false), ["kill"]);
  assert.deepEqual(availableActions("ssh_key_added", { path: "/root/.ssh/authorized_keys" }, false), []);
  assert.deepEqual(availableActions("account_new", { user: "bob" }, false), []);
});
