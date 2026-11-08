import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultHealthCheckTarget,
  healthCheckTargetNeedsPort,
  healthCheckTargetPlaceholder,
  normalizeForwardGroupHealthCheckMethod,
} from "../shared/forwardGroupHealthCheck";
import { normalizeChinaHealthTarget } from "./repositories/forwardGroupRepository";

test("health check method defaults to TCPing and only accepts a known value", () => {
  assert.equal(normalizeForwardGroupHealthCheckMethod("ping"), "ping");
  assert.equal(normalizeForwardGroupHealthCheckMethod("  PING "), "ping");
  assert.equal(normalizeForwardGroupHealthCheckMethod("tcp"), "tcp");
  assert.equal(normalizeForwardGroupHealthCheckMethod("icmp"), "tcp");
  assert.equal(normalizeForwardGroupHealthCheckMethod(null), "tcp");
  assert.equal(normalizeForwardGroupHealthCheckMethod(undefined), "tcp");
});

test("only TCPing needs a port on the target", () => {
  assert.equal(healthCheckTargetNeedsPort("tcp"), true);
  assert.equal(healthCheckTargetNeedsPort("ping"), false);
  assert.equal(defaultHealthCheckTarget("tcp"), "www.189.cn:80");
  assert.equal(defaultHealthCheckTarget("ping"), "www.189.cn");
  assert.match(healthCheckTargetPlaceholder("tcp"), /端口/);
  assert.doesNotMatch(healthCheckTargetPlaceholder("ping"), /:80/);
});

test("TCPing targets keep their host and port", () => {
  const parsed = normalizeChinaHealthTarget("www.189.cn:443", "tcp");
  assert.equal(parsed.host, "www.189.cn");
  assert.equal(parsed.port, 443);
  assert.equal(parsed.text, "www.189.cn:443");
  assert.equal(parsed.method, "tcp");
});

test("TCPing falls back to port 80 and to the default target", () => {
  assert.equal(normalizeChinaHealthTarget("www.189.cn", "tcp").port, 80);
  assert.equal(normalizeChinaHealthTarget("", "tcp").text, "www.189.cn:80");
});

test("ping targets drop the port so a bare host is the stored form", () => {
  const bare = normalizeChinaHealthTarget("1.1.1.1", "ping");
  assert.equal(bare.host, "1.1.1.1");
  assert.equal(bare.port, 0);
  assert.equal(bare.text, "1.1.1.1");
  assert.equal(bare.method, "ping");

  // A port the operator typed is meaningless for ICMP, so it is dropped rather
  // than rejected.
  const withPort = normalizeChinaHealthTarget("1.1.1.1:80", "ping");
  assert.equal(withPort.host, "1.1.1.1");
  assert.equal(withPort.port, 0);
  assert.equal(withPort.text, "1.1.1.1");
});

test("ping uses its own default target", () => {
  assert.equal(normalizeChinaHealthTarget("", "ping").text, "www.189.cn");
});

test("IPv6 targets keep bracket form for TCPing and drop it for ping", () => {
  const tcp = normalizeChinaHealthTarget("[2606:4700:4700::1111]:443", "tcp");
  assert.equal(tcp.host, "2606:4700:4700::1111");
  assert.equal(tcp.port, 443);
  assert.equal(tcp.text, "[2606:4700:4700::1111]:443");

  const ping = normalizeChinaHealthTarget("2606:4700:4700::1111", "ping");
  assert.equal(ping.host, "2606:4700:4700::1111");
  assert.equal(ping.port, 0);
  assert.equal(ping.text, "[2606:4700:4700::1111]");
});

test("an omitted method keeps the previous TCPing behaviour", () => {
  // Existing callers pass no method; their targets must parse exactly as before.
  const parsed = normalizeChinaHealthTarget("www.189.cn:80");
  assert.equal(parsed.port, 80);
  assert.equal(parsed.text, "www.189.cn:80");
  assert.equal(parsed.method, "tcp");
});

test("malformed targets are rejected for both methods", () => {
  assert.throws(() => normalizeChinaHealthTarget("bad host", "tcp"));
  assert.throws(() => normalizeChinaHealthTarget("bad host", "ping"));
  assert.throws(() => normalizeChinaHealthTarget("has/slash", "ping"));
});

test("an out-of-range port fails TCPing but is ignored by ping", () => {
  // 99999 is not a valid port, so it is not consumed as one and stays part of
  // the host, which then fails the host check for TCPing.
  assert.throws(() => normalizeChinaHealthTarget("[2606:4700::1111]:99999", "tcp"));
  // Ping never looks at a port at all.
  assert.equal(normalizeChinaHealthTarget("1.1.1.1:99999", "ping").host, "1.1.1.1");
});

test("UDP 方法：认 udp、要端口、默认探公共 DNS 的 53 端口", async () => {
  const { FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS, forwardGroupHealthProbeMethodForAgent } = await import("../shared/forwardGroupHealthCheck");
  assert.equal(normalizeForwardGroupHealthCheckMethod("udp"), "udp");
  assert.equal(normalizeForwardGroupHealthCheckMethod(" UDP "), "udp");
  assert.equal(healthCheckTargetNeedsPort("udp"), true);
  assert.equal(defaultHealthCheckTarget("udp"), "223.5.5.5:53");
  assert.match(healthCheckTargetPlaceholder("udp"), /端口/);
  assert.equal(FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS.udp, "UDP - 探测 UDP 端口");
  const parsed = normalizeChinaHealthTarget("223.5.5.5", "udp");
  assert.equal(parsed.port, 53, "UDP 没写端口补 53，不是 TCPing 的 80");
  assert.equal(parsed.method, "udp");
  assert.equal(normalizeChinaHealthTarget("", "udp").text, "223.5.5.5:53");
  assert.equal(normalizeChinaHealthTarget("udp://1.1.1.1:5353", "udp").port, 5353);
  // 探测那台的 Agent 要 2.2.251 起才认 udp，更老的改发 ping；tcp / ping 不受版本影响
  assert.equal(forwardGroupHealthProbeMethodForAgent("udp", "2.2.251"), "udp");
  assert.equal(forwardGroupHealthProbeMethodForAgent("udp", "2.2.250"), "ping");
  assert.equal(forwardGroupHealthProbeMethodForAgent("udp", ""), "ping");
  assert.equal(forwardGroupHealthProbeMethodForAgent("ping", "2.2.100"), "ping");
  assert.equal(forwardGroupHealthProbeMethodForAgent("tcp", null), "tcp");
});
