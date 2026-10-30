import assert from "node:assert/strict";
import { test } from "node:test";
import { CidrMatcher } from "./firewallCidr";
import {
  decidePanelAccess,
  isPanelAccessExemptPath,
  panelAccessSelfLockoutError,
  type CountryLookup,
} from "./firewallPanelAccess";
import type { PanelAccessRule } from "./firewallStore";

const CN = new CidrMatcher(["1.0.1.0/24", "2400:3200::/32"]);
const HK = new CidrMatcher(["1.32.192.0/18"]);

function lookup(missing: string[] = []): CountryLookup {
  return {
    missing,
    match: (ip) => (CN.contains(ip) ? "CN" : HK.contains(ip) ? "HK" : null),
  };
}

const rule = (mode: PanelAccessRule["mode"], countries: string[], includeSubscription = false): PanelAccessRule => ({ mode, countries, includeSubscription });

test("off rule allows everyone", () => {
  assert.equal(decidePanelAccess("1.0.1.5", rule("off", ["CN"]), lookup()).allowed, true);
  assert.equal(decidePanelAccess("1.0.1.5", rule("block", []), lookup()).allowed, true);
});

test("block mode denies listed countries only", () => {
  const r = rule("block", ["CN"]);
  assert.deepEqual(decidePanelAccess("1.0.1.5", r, lookup()), { allowed: false, reason: "matched", country: "CN" });
  assert.equal(decidePanelAccess("::ffff:1.0.1.5", r, lookup()).allowed, false);
  assert.equal(decidePanelAccess("2400:3200::8", r, lookup()).allowed, false);
  assert.equal(decidePanelAccess("8.8.8.8", r, lookup()).allowed, true);
});

test("allow mode denies everything not listed, but fails open while data is missing", () => {
  const r = rule("allow", ["HK"]);
  assert.equal(decidePanelAccess("1.32.200.1", r, lookup()).allowed, true);
  assert.deepEqual(decidePanelAccess("8.8.8.8", r, lookup()), { allowed: false, reason: "not-matched", country: null });
  assert.deepEqual(decidePanelAccess("8.8.8.8", r, lookup(["HK"])), { allowed: true, reason: "no-data", country: null });
});

test("private, loopback and unknown addresses are always allowed", () => {
  const r = rule("allow", ["HK"]);
  for (const ip of ["127.0.0.1", "::1", "10.1.2.3", "192.168.1.9", "::ffff:192.168.1.9", "fd00::1", "100.64.0.1"]) {
    assert.equal(decidePanelAccess(ip, r, lookup()).allowed, true, ip);
  }
  assert.equal(decidePanelAccess("", r, lookup()).reason, "unknown-ip");
});

test("agent, sync, stream, payment webhooks and migration are exempt; subscription is optional", () => {
  const off = { includeSubscription: false };
  const on = { includeSubscription: true };
  for (const path of ["/api/agent/heartbeat", "/api/agent/ext", "/api/agent/install.sh", "/api/sync", "/api/stream", "/api/payment/webhook/alipay", "/api/migration/export", "/api/nodecheck/speed/down"]) {
    assert.equal(isPanelAccessExemptPath(path, on), true, path);
  }
  for (const path of ["/", "/login", "/api/trpc/auth.login", "/assets/index.js", "/api/agentx", "/api/nodecheck"]) {
    assert.equal(isPanelAccessExemptPath(path, off), false, path);
  }
  assert.equal(isPanelAccessExemptPath("/api/sub/abc", off), true);
  assert.equal(isPanelAccessExemptPath("/api/sub/abc", on), false);
});

test("self-lockout check refuses a rule that would block the requester", () => {
  assert.match(panelAccessSelfLockoutError("1.0.1.5", rule("block", ["CN"]), lookup()) || "", /1\.0\.1\.5.*打不开面板/);
  assert.match(panelAccessSelfLockoutError("8.8.8.8", rule("allow", ["HK"]), lookup()) || "", /不在放行的国家里/);
  assert.equal(panelAccessSelfLockoutError("1.32.200.1", rule("allow", ["HK"]), lookup()), null);
  assert.equal(panelAccessSelfLockoutError("8.8.8.8", rule("block", ["CN"]), lookup()), null);
  // 本机 / 内网访问面板的管理员不会被挡
  assert.equal(panelAccessSelfLockoutError("127.0.0.1", rule("allow", ["HK"]), lookup()), null);
  assert.equal(panelAccessSelfLockoutError("::ffff:10.0.0.2", rule("allow", ["HK"]), lookup()), null);
  // 国家数据没齐：不让保存
  assert.match(panelAccessSelfLockoutError("8.8.8.8", rule("allow", ["HK", "JP"]), lookup(["JP"])) || "", /还没下载好/);
  // 关掉永远可以保存
  assert.equal(panelAccessSelfLockoutError("1.0.1.5", rule("off", []), lookup()), null);
});
