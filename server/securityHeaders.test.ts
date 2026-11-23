import assert from "node:assert/strict";
import { test } from "node:test";

import { buildContentSecurityPolicy, injectScriptNonce, newCspNonce } from "./securityHeaders";

test("script-src carries the per-request nonce and no unsafe-inline", () => {
  const csp = buildContentSecurityPolicy({ nonce: "abc123", frameAncestors: "'none'" });
  const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src "));
  assert.ok(scriptSrc);
  assert.match(scriptSrc, /'nonce-abc123'/);
  assert.doesNotMatch(scriptSrc, /unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test("custom sidebar embeds may frame the panel same-origin only", () => {
  assert.match(buildContentSecurityPolicy({ nonce: "x", frameAncestors: "'self'" }), /frame-ancestors 'self'/);
});

test("nonces are random base64 of 16 bytes", () => {
  const a = newCspNonce();
  const b = newCspNonce();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, "base64").length, 16);
});

test("injectScriptNonce tags inline and module scripts, leaves existing nonces and noscript alone", () => {
  const html = [
    "<head>",
    "<script>",
    "  console.log('boot <script> inside string stays text');",
    "</script>",
    '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
    '<script nonce="keep">x()</script>',
    "<noscript>enable js</noscript>",
    "</head>",
  ].join("\n");
  const out = injectScriptNonce(html, "N0NCE+/=");
  assert.equal((out.match(/nonce="N0NCE\+\/="/g) || []).length, 3, "the string literal inside the script body is also an opening tag lexically; browsers never see it because the body is JS — but it must not break anything");
  assert.match(out, /<script nonce="N0NCE\+\/=">\n {2}console/);
  assert.match(out, /<script nonce="N0NCE\+\/=" type="module" crossorigin src="\/assets\/index-abc\.js"><\/script>/);
  assert.match(out, /<script nonce="keep">x\(\)<\/script>/);
  assert.match(out, /<noscript>enable js<\/noscript>/);
});
