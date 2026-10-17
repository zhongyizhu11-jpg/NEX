import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isAdminManagedRule, ruleLimitReason, ruleTrafficUsed, assertRuleWritable } from "../shared/ruleLimits";
import { selectEffectiveForwardRateLimit, selectProtocolGuardRateLimit } from "./agentHeartbeatRoute";
import { ruleLimitRootId } from "./ruleLimits";

test("rule quota uses cumulative directional totals; optional expiry doesn't depend on creation time", () => {
  assert.equal(ruleTrafficUsed("outbound", 600, 500), 500);
  assert.equal(ruleTrafficUsed("both", 600, 500), 1100);
  assert.equal(ruleTrafficUsed("max", 600, 500), 600);
  assert.equal(ruleTrafficUsed("garbage", 600, 500), 1100, "unknown modes count both directions");
  assert.equal(ruleLimitReason({ trafficLimit: 1000, trafficMode: "both" }, { bytesIn: 600, bytesOut: 500 }), "traffic_limit");
  assert.equal(ruleLimitReason({ trafficLimit: 1000, trafficMode: "max" }, { bytesIn: 600, bytesOut: 500 }), null);
  assert.equal(ruleLimitReason({ trafficLimit: 1000, trafficMode: "outbound" }, { bytesIn: 0, bytesOut: 1000 }), "traffic_limit", "exact boundary");
  assert.equal(ruleLimitReason({ trafficLimit: 0, expiresAt: null }), null);
  assert.equal(ruleLimitReason({ expiresAt: new Date(10) }, undefined, 10), "expired");
  assert.equal(ruleLimitReason({ expiresAt: new Date(11) }, undefined, 10), null);
  assert.equal(ruleLimitReason({ expiresAt: new Date(10), trafficLimit: 1 }, { bytesIn: 5, bytesOut: 5 }, 10), "expired", "expiry wins");
});

test("administrator-managed rules are read-only for their owner, writable for administrators", () => {
  assert.equal(isAdminManagedRule({}), false);
  assert.equal(isAdminManagedRule({ adminManaged: 1 }), true);
  assert.equal(isAdminManagedRule({ trafficLimit: 5 }), true);
  assert.equal(isAdminManagedRule({ expiresAt: new Date() }), true);
  assert.doesNotThrow(() => assertRuleWritable({ id: 1, role: "admin" }, { userId: 2, adminManaged: true }));
  assert.doesNotThrow(() => assertRuleWritable({ id: 2, role: "user" }, { userId: 2 }));
  assert.throws(() => assertRuleWritable({ id: 2, role: "user" }, { userId: 2, adminManaged: true }), /管理员管理/);
  assert.throws(() => assertRuleWritable({ id: 3, role: "user" }, { userId: 2 }), /无权/);
});

test("per-rule speed caps reuse supported backend guards and cannot relax wider caps", () => {
  const base = { userId: 2, hostId: 1, ruleId: 8, ruleLimitMbps: 10 };
  assert.deepEqual(selectEffectiveForwardRateLimit(base), { mbps: 10, scope: "rule-8-host-1" });
  assert.deepEqual(selectEffectiveForwardRateLimit({ ...base, userLimitMbps: 5 }), { mbps: 5, scope: "user-2-host-1" });
  assert.equal(selectEffectiveForwardRateLimit({ ...base, forwardGroupId: 2, forwardGroupLimitMbps: 3 }).mbps, 3);
  assert.deepEqual(selectEffectiveForwardRateLimit({ ...base, ruleLimitMbps: 0 }), { mbps: 0, scope: "" });
  for (const forwardType of ["iptables", "nftables", "realm", "socat", "nginx"]) {
    assert.equal(selectProtocolGuardRateLimit({ agentVersion: "2.2.190", hostId: 1, rule: { forwardType, userId: 2 }, rateLimitScope: "rule-8-host-1", limitIn: 1250000, limitOut: 1250000 }).rateLimitScope, "rule-8-host-1");
  }
  // Group members and route relays share their root rule's bucket.
  assert.equal(ruleLimitRootId({ id: 30, forwardGroupRuleId: 8 }), 8);
  assert.equal(ruleLimitRootId({ id: 31, routeParentRuleId: 9 }), 9);
  assert.equal(ruleLimitRootId({ id: 32 }), 32);
});

test("real SQLite rule quotas, admin permissions, expiry, resets, member inheritance and migration defaults", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-rule-limits-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/ruleLimits.fixture.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "limits.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
