import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { newRuleLimitsForm, ruleLimitsChanges, ruleLimitsPayload, ruleLimitsSummary, RuleLimitsForm } from "./RuleLimitsForm";
import { RuleLimitSummary } from "./RuleLimitSummary";

const GB = 1024 ** 3;

test("rule limits start unlimited and send nothing for an untouched form", () => {
  const value = newRuleLimitsForm();
  const payload = ruleLimitsPayload(value);
  assert.equal(payload.expiresAt, null);
  assert.equal(payload.rateLimitMbps, 0);
  assert.equal(payload.trafficLimit, 0);
  assert.equal(payload.trafficMode, "both");
  // An administrator creating an ordinary rule must not turn it into an administrator-managed one.
  assert.deepEqual(ruleLimitsChanges(value), {});
  assert.equal(ruleLimitsSummary(value), null);
  const html = renderToStaticMarkup(<RuleLimitsForm value={value} onChange={() => {}} />);
  assert.match(html, /Mbps/);
  assert.match(html, /流量额度（GB）/);
  assert.match(html, /type="time"/);
  assert.match(html, /仅管理员可设/);
  assert.match(html, /data-testid="rule-limits-section"/);
  // Optional section: nothing required, no warning colours (it lives in the collapsed "更多设置").
  assert.doesNotMatch(html, /text-destructive|border-amber/);
});

test("existing policies round-trip and only changed fields are submitted", () => {
  const expiresAt = new Date(2026, 10, 7, 18, 59, 0);
  const rule = { expiresAt, trafficMode: "max", trafficLimit: 100 * GB, rateLimitMbps: 15, quotaUsedIn: 10, quotaUsedOut: 20 };
  const value = newRuleLimitsForm(rule);
  assert.equal(value.quota, "100");
  assert.equal(value.speed, "15");
  assert.equal(value.expiresTime, "18:59");
  const payload = ruleLimitsPayload(value);
  assert.equal(payload.expiresAt?.getTime(), expiresAt.getTime());
  assert.equal(payload.trafficLimit, 100 * GB);
  assert.equal(payload.trafficMode, "max");
  assert.deepEqual(ruleLimitsChanges(value, rule), {}, "editing other fields must not resend the limits");
  assert.deepEqual(ruleLimitsChanges({ ...value, speed: "20" }, rule), { rateLimitMbps: 20 });
  assert.deepEqual(ruleLimitsChanges({ ...value, expiresDate: "" }, rule), { expiresAt: null });
  assert.deepEqual(ruleLimitsChanges({ ...value, quota: "" }, rule), { trafficLimit: 0 });
  // An unrounded stored quota is not "changed" just because the form shows it rounded.
  const odd = { trafficLimit: 123456789 };
  assert.deepEqual(ruleLimitsChanges(newRuleLimitsForm(odd), odd), {});
  assert.equal(ruleLimitsSummary(value), "限速 15 Mbps · 额度 100 GB · 11-07 到期");
});

test("invalid input is rejected with a readable message", () => {
  const value = newRuleLimitsForm();
  assert.throws(() => ruleLimitsPayload({ ...value, speed: "1.5" }), /限速/);
  assert.throws(() => ruleLimitsPayload({ ...value, quota: "-1" }), /流量额度/);
  assert.throws(() => ruleLimitsPayload({ ...value, expiresDate: "2026-13-01" }), /到期/);
  assert.throws(() => ruleLimitsPayload({ ...value, expiresDate: "2026-11-01", expiresTime: "25:00" }), /到期/);
  assert.equal(ruleLimitsPayload({ ...value, quota: "0.0000000001" }).trafficLimit, 1, "a tiny quota never rounds to unlimited");
});

test("card summary uses the enforcement counters and has no write controls", () => {
  const now = new Date(2026, 9, 17, 12, 0, 0).getTime();
  const render = (rule: any) => renderToStaticMarkup(<RuleLimitSummary rule={rule} now={now} />);
  assert.equal(render({}), "", "rules without limits render nothing");
  assert.equal(render({ adminManaged: true }), "", "managed rules without limits render nothing");
  const rule = { trafficLimit: 1024, quotaUsedIn: 600, quotaUsedOut: 500 };
  const both = render({ ...rule, trafficMode: "both" });
  assert.match(both, /1\.07 KB \/ 1 KB/);
  assert.match(both, /aria-valuenow="100"/);
  assert.match(both, /data-tone="down"/);
  assert.doesNotMatch(both, /<button|<input/);
  assert.match(render({ ...rule, trafficMode: "max" }), /600 B \/ 1 KB/);
  assert.match(render({ ...rule, trafficMode: "outbound" }), /500 B \/ 1 KB/);
  assert.match(render({ trafficLimit: 1024 }), /— \/ 1 KB/, "a counter that has not started shows a dash, not zero");
  assert.match(render({ rateLimitMbps: 12 }), /限速 12 Mbps/);
  assert.match(render({ expiresAt: new Date(2026, 10, 1, 23, 59) }), /11-01 23:59 到期/);
  const expired = render({ expiresAt: new Date(2026, 9, 1, 0, 0), ruleLimitReason: "expired" });
  assert.match(expired, /已于 10-01 00:00 到期/);
  assert.match(expired, /data-tone="down"/);
});
