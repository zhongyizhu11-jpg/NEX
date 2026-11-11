import assert from "node:assert/strict";
import test from "node:test";
import {
  checkHostProbeHttpUrl,
  describeHostProbeFailure,
  describeHostProbeFailureShort,
  HOST_PROBE_HTTP_AGENT_VERSION,
  hostAgentSupportsHttpProbe,
  hostProbeHttpStatusMatches,
  hostProbeHttpUrlHostname,
  normalizeHostProbeFailure,
  normalizeHostProbeHttpExpectedStatus,
  normalizeHostProbeHttpStatus,
  normalizeHostProbeHttpTimeout,
  normalizeHostProbeMethod,
  parseHostProbeHttpExpectedStatus,
} from "./hostProbeService";

test("method normalization keeps legacy rows as tcping and accepts http", () => {
  assert.equal(normalizeHostProbeMethod("ping"), "ping");
  assert.equal(normalizeHostProbeMethod("http"), "http");
  assert.equal(normalizeHostProbeMethod("HTTPS"), "http");
  assert.equal(normalizeHostProbeMethod(""), "tcping");
  assert.equal(normalizeHostProbeMethod("whatever"), "tcping");
});

test("HTTP probe is gated on the first supporting Agent version", () => {
  assert.equal(HOST_PROBE_HTTP_AGENT_VERSION, "2.2.255");
  assert.equal(hostAgentSupportsHttpProbe("2.2.252"), false);
  assert.equal(hostAgentSupportsHttpProbe("2.2.255"), true);
  assert.equal(hostAgentSupportsHttpProbe("v2.3.0"), true);
  assert.equal(hostAgentSupportsHttpProbe(""), false);
  assert.equal(hostAgentSupportsHttpProbe(null), false);
});

test("URL validation only accepts http(s) without credentials or fragments", () => {
  const ok = checkHostProbeHttpUrl("  https://example.com/health?x=1  ");
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.url, "https://example.com/health?x=1");
  assert.equal(hostProbeHttpUrlHostname("http://[2001:db8::1]:8080/"), "2001:db8::1");
  for (const bad of [
    "",
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "https://example.com/#frag",
    "https://exa mple.com/",
    "https://example.com/\u0000",
    "example.com",
    `https://example.com/${"a".repeat(2100)}`,
  ]) {
    assert.equal(checkHostProbeHttpUrl(bad).ok, false, bad);
  }
});

test("expected status accepts singles, ranges and Nxx and defaults to 200-399", () => {
  const empty = parseHostProbeHttpExpectedStatus("");
  assert.ok(empty.ok);
  assert.equal(empty.ok && empty.normalized, "200-399");
  const mixed = parseHostProbeHttpExpectedStatus("200, 204，301-302 4xx");
  assert.ok(mixed.ok);
  assert.equal(mixed.ok && mixed.normalized, "200,204,301-302,400-499");
  assert.equal(parseHostProbeHttpExpectedStatus("399-200").ok, false);
  assert.equal(parseHostProbeHttpExpectedStatus("700").ok, false);
  assert.equal(parseHostProbeHttpExpectedStatus("ok").ok, false);
  assert.equal(normalizeHostProbeHttpExpectedStatus("garbage"), "200-399");
  assert.equal(hostProbeHttpStatusMatches(302, ""), true);
  assert.equal(hostProbeHttpStatusMatches(404, ""), false);
  assert.equal(hostProbeHttpStatusMatches(204, "200,204"), true);
});

test("timeout is clamped to 1..30 seconds with a 5 second default", () => {
  assert.equal(normalizeHostProbeHttpTimeout(undefined), 5);
  assert.equal(normalizeHostProbeHttpTimeout(0), 5);
  assert.equal(normalizeHostProbeHttpTimeout(12), 12);
  assert.equal(normalizeHostProbeHttpTimeout(99), 30);
});

test("failure text separates status mismatch from connection failure for http only", () => {
  assert.equal(describeHostProbeFailure("http", { failure: "http_status", httpStatus: 503 }), "HTTP 状态码不符（返回 503）");
  assert.equal(describeHostProbeFailure("http", { failure: "timeout" }), "连接超时");
  assert.equal(describeHostProbeFailure("http", { failure: "tls" }), "证书校验失败");
  assert.equal(describeHostProbeFailure("http", {}), "连接失败 / 超时");
  assert.equal(describeHostProbeFailureShort("http", { failure: "http_status", httpStatus: 404 }), "状态码不符 404");
  // Ping / TCPing 照旧「超时」
  assert.equal(describeHostProbeFailure("tcping", { failure: "http_status" }), "超时");
  assert.equal(normalizeHostProbeFailure("HTTP_STATUS"), "http_status");
  assert.equal(normalizeHostProbeFailure("refused"), "refused");
  assert.equal(normalizeHostProbeFailure("nonsense"), null);
  assert.equal(normalizeHostProbeHttpStatus(200), 200);
  assert.equal(normalizeHostProbeHttpStatus(99), null);
  assert.equal(normalizeHostProbeHttpStatus("abc"), null);
});
