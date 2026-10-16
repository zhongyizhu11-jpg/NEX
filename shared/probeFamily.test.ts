import assert from "node:assert/strict";
import test from "node:test";

import { isProbeAddressFamily, normalizeProbeAddressFamily, probeFamilyNumber } from "./probeFamily";

test("地址族：只认 auto / ipv4 / ipv6，其他当 auto", () => {
  assert.equal(isProbeAddressFamily("ipv6"), true);
  assert.equal(isProbeAddressFamily("IPv6"), false);
  assert.equal(normalizeProbeAddressFamily("ipv6", "example.com"), "ipv6");
  assert.equal(normalizeProbeAddressFamily("ipv4", "example.com"), "ipv4");
  assert.equal(normalizeProbeAddressFamily("v6", "example.com"), "auto");
  assert.equal(normalizeProbeAddressFamily(undefined, "example.com"), "auto");
  assert.equal(normalizeProbeAddressFamily(null), "auto");
});

test("地址族：目标本身是 IP 时一律 auto（地址族由地址决定）", () => {
  assert.equal(normalizeProbeAddressFamily("ipv6", "1.1.1.1"), "auto");
  assert.equal(normalizeProbeAddressFamily("ipv4", "2606:4700::1111"), "auto");
  assert.equal(normalizeProbeAddressFamily("ipv4", "[2606:4700::1111]"), "auto");
  assert.equal(normalizeProbeAddressFamily("ipv6", "999.1.1.1"), "ipv6", "不是合法 IP 就当域名看");
  assert.equal(probeFamilyNumber("auto"), 0);
  assert.equal(probeFamilyNumber("ipv4"), 4);
  assert.equal(probeFamilyNumber("ipv6"), 6);
});
