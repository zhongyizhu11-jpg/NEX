import assert from "node:assert/strict";
import { test } from "node:test";

import { crossSiteRequestReason, parseTrustedOrigins } from "./csrf";

const panel = (headers: Record<string, string>, hostname = "panel.example.com") => ({ headers, hostname });

test("same-origin browser requests pass regardless of port or scheme", () => {
  assert.equal(crossSiteRequestReason(panel({ origin: "https://panel.example.com" })), null);
  assert.equal(crossSiteRequestReason(panel({ origin: "http://panel.example.com:9810" })), null);
  assert.equal(crossSiteRequestReason(panel({ origin: "HTTPS://Panel.Example.com" })), null);
});

test("same-site but different host is rejected (the gap SameSite=Lax leaves open)", () => {
  const reason = crossSiteRequestReason(panel({ origin: "https://evil.example.com" }));
  assert.ok(reason && /does not match/.test(reason));
});

test("cross-site origins and Origin: null are rejected", () => {
  assert.ok(crossSiteRequestReason(panel({ origin: "https://attacker.test" })));
  assert.ok(crossSiteRequestReason(panel({ origin: "null" })));
  assert.ok(crossSiteRequestReason(panel({ origin: "not a url" })));
});

test("requests without Origin pass unless Sec-Fetch-Site says cross-site", () => {
  assert.equal(crossSiteRequestReason(panel({})), null);
  assert.equal(crossSiteRequestReason(panel({ "sec-fetch-site": "same-origin" })), null);
  assert.equal(crossSiteRequestReason(panel({ "sec-fetch-site": "none" })), null);
  assert.ok(crossSiteRequestReason(panel({ "sec-fetch-site": "cross-site" })));
});

test("mobile app origins pass; localhost with a port only outside production", () => {
  assert.equal(crossSiteRequestReason(panel({ origin: "capacitor://localhost" }), { isProduction: true }), null);
  assert.equal(crossSiteRequestReason(panel({ origin: "http://localhost" }), { isProduction: true }), null);
  assert.ok(crossSiteRequestReason(panel({ origin: "http://localhost:5173" }), { isProduction: true }));
  assert.equal(crossSiteRequestReason(panel({ origin: "http://localhost:5173" }), { isProduction: false }), null);
});

test("FORWARDX_TRUSTED_ORIGINS accepts full origins or bare hostnames", () => {
  const trusted = parseTrustedOrigins(" https://ops.example.com, status.example.com ,, ");
  assert.equal(crossSiteRequestReason(panel({ origin: "https://ops.example.com" }), { trustedOrigins: trusted, isProduction: true }), null);
  assert.equal(crossSiteRequestReason(panel({ origin: "http://status.example.com:8080" }), { trustedOrigins: trusted, isProduction: true }), null);
  assert.ok(crossSiteRequestReason(panel({ origin: "https://other.example.com" }), { trustedOrigins: trusted, isProduction: true }));
});

test("falls back to the Host header when req.hostname is absent, and skips contexts without headers", () => {
  assert.equal(crossSiteRequestReason({ headers: { origin: "http://10.0.0.8:9810", host: "10.0.0.8:9810" } }), null);
  assert.ok(crossSiteRequestReason({ headers: { origin: "http://10.0.0.9", host: "10.0.0.8:9810" } }));
  assert.equal(crossSiteRequestReason({ headers: { origin: "http://[::1]:9810", host: "[::1]:9810" } }), null);
  assert.equal(crossSiteRequestReason(null), null);
  assert.equal(crossSiteRequestReason({}), null);
});
