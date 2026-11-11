import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_PUBLIC_ADDRESS_LIST_AGENT_VERSION,
  MAX_HOST_PUBLIC_ADDRESSES,
  applyChosenPrimaryAddress,
  hostAddressRows,
  hostDetectedAddressesSignature,
  hostHasMultiplePublicAddresses,
  hostPrimaryAddressOptions,
  hostPrimaryAddressPatch,
  hostPrimaryAddressWarnings,
  normalizeHostDetectedAddressReport,
  normalizePublicAddress,
  parseHostDetectedAddresses,
  serializeHostDetectedAddresses,
} from "./hostPublicAddresses";

const detected = serializeHostDetectedAddresses({
  ipv4: ["45.32.10.1", "45.32.10.2"],
  ipv6: ["2001:19f0:5:1::1", "2001:19f0:5:2::2"],
  egressIpv4: "45.32.10.1",
  egressIpv6: "2001:19f0:5:1::1",
  reportedAt: 1,
});

test("agent version gate is the next agent release", () => {
  assert.equal(HOST_PUBLIC_ADDRESS_LIST_AGENT_VERSION, "2.2.255");
});

test("report normalization drops private / bogus addresses, dedupes and bounds", () => {
  const many = Array.from({ length: 40 }, (_, index) => `45.33.${index}.1`);
  const report = normalizeHostDetectedAddressReport({
    ipv4: ["45.32.10.1", "10.0.0.1", "192.168.1.1", "100.64.0.1", "45.32.10.1", "not-an-ip", "2001:19f0::1", ...many],
    ipv6: ["2001:19F0:5:1::1", "fd00::1", "fe80::1", "::1", "1.2.3.4"],
    egressIpv4: "45.32.10.1",
    egressIpv6: "fe80::1",
  }, 1234);
  assert.ok(report);
  assert.equal(report.ipv4[0], "45.32.10.1");
  assert.equal(report.ipv4.length, MAX_HOST_PUBLIC_ADDRESSES);
  assert.ok(!report.ipv4.includes("10.0.0.1"));
  assert.deepEqual(report.ipv6, ["2001:19f0:5:1::1"]);
  assert.equal(report.egressIpv4, "45.32.10.1");
  assert.equal(report.egressIpv6, null);
  assert.equal(report.reportedAt, 1234);
});

test("absent report (old agent / non-static heartbeat) is null, an empty one is not", () => {
  assert.equal(normalizeHostDetectedAddressReport(undefined), null);
  assert.equal(normalizeHostDetectedAddressReport({}), null);
  assert.equal(normalizeHostDetectedAddressReport([]), null);
  const empty = normalizeHostDetectedAddressReport({ ipv4: [], ipv6: [] });
  assert.deepEqual(empty?.ipv4, []);
});

test("203.0.x addresses outside the documentation /24 are kept (host addresses are not SSRF targets)", () => {
  assert.equal(normalizePublicAddress("203.0.178.1", "ipv4"), "203.0.178.1");
  assert.equal(normalizePublicAddress("0.1.2.3", "ipv4"), "");
  assert.equal(normalizePublicAddress("::", "ipv6"), "");
});

test("stored JSON round-trips; signature ignores reportedAt", () => {
  const parsed = parseHostDetectedAddresses(detected);
  assert.ok(parsed);
  assert.deepEqual(parsed.ipv4, ["45.32.10.1", "45.32.10.2"]);
  const later = { ...parsed, reportedAt: 99 };
  assert.equal(hostDetectedAddressesSignature(parsed), hostDetectedAddressesSignature(later));
  assert.equal(parseHostDetectedAddresses("{broken"), null);
  assert.equal(parseHostDetectedAddresses(null), null);
});

test("never chosen: the agent-reported address is used exactly as today", () => {
  assert.equal(applyChosenPrimaryAddress({ detectedAddresses: detected }, "ipv4", "45.32.10.1"), "45.32.10.1");
  assert.equal(applyChosenPrimaryAddress({}, "ipv6", ""), "");
});

test("chosen primary replaces the reported address even when it disappeared, with a warning", () => {
  const host = { ipv4: "45.32.10.9", primaryIpv4: "45.32.10.9", detectedAddresses: detected };
  assert.equal(applyChosenPrimaryAddress(host, "ipv4", "45.32.10.1"), "45.32.10.9");
  const warnings = hostPrimaryAddressWarnings(host);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /45\.32\.10\.9 不在 Agent 最近检测到的地址里/);
  assert.deepEqual(hostPrimaryAddressWarnings({ ...host, primaryIpv4: "45.32.10.2" }), []);
});

test("manual address override wins: chosen primary is flagged as inactive", () => {
  const warnings = hostPrimaryAddressWarnings({ addressManual: true, primaryIpv4: "45.32.10.2", detectedAddresses: detected });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /暂不生效/);
});

test("address rows mark primary / chosen / egress and keep a vanished primary visible", () => {
  const rows = hostAddressRows({ ipv4: "45.32.10.2", ipv6: "2001:19f0:5:1::1", primaryIpv4: "45.32.10.2", detectedAddresses: detected });
  assert.deepEqual(rows.map((row) => [row.address, row.primary, row.chosen, row.egress, row.detected]), [
    ["45.32.10.2", true, true, false, true],
    ["45.32.10.1", false, false, true, true],
    ["2001:19f0:5:1::1", true, false, true, true],
    ["2001:19f0:5:2::2", false, false, false, true],
  ]);
  const vanished = hostAddressRows({ ipv4: "45.32.10.9", primaryIpv4: "45.32.10.9", detectedAddresses: detected });
  assert.deepEqual(vanished[0], { family: "ipv4", address: "45.32.10.9", primary: true, chosen: true, egress: false, detected: false });
  // 老 Agent：没有列表，只有原来那一个地址
  assert.equal(hostAddressRows({ ipv4: "45.32.10.1" }).length, 1);
});

test("primary options come from the detected list (plus the chosen one)", () => {
  assert.deepEqual(hostPrimaryAddressOptions({ detectedAddresses: detected }, "ipv4"), ["45.32.10.1", "45.32.10.2"]);
  assert.deepEqual(hostPrimaryAddressOptions({ primaryIpv4: "45.32.10.9", detectedAddresses: detected }, "ipv4"), ["45.32.10.1", "45.32.10.2", "45.32.10.9"]);
  assert.equal(hostHasMultiplePublicAddresses({ detectedAddresses: detected }), true);
  assert.equal(hostHasMultiplePublicAddresses({}), false);
});

test("primary patch writes the chosen address into ip / ipv4 and reverts to egress when cleared", () => {
  const host = { ip: "45.32.10.1", ipv4: "45.32.10.1", ipv6: "2001:19f0:5:1::1", detectedAddresses: detected };
  assert.deepEqual(hostPrimaryAddressPatch(host, { primaryIpv4: "45.32.10.2" }), { primaryIpv4: "45.32.10.2", ipv4: "45.32.10.2", ip: "45.32.10.2" });
  const chosen = { ...host, ip: "45.32.10.2", ipv4: "45.32.10.2", primaryIpv4: "45.32.10.2" };
  assert.deepEqual(hostPrimaryAddressPatch(chosen, { primaryIpv4: null }), { primaryIpv4: null, ipv4: "45.32.10.1", ip: "45.32.10.1" });
  // 没变：什么都不写
  assert.deepEqual(hostPrimaryAddressPatch(chosen, { primaryIpv4: "45.32.10.2" }), {});
  assert.deepEqual(hostPrimaryAddressPatch(host, {}), {});
  // 手改地址：只记下选择
  assert.deepEqual(hostPrimaryAddressPatch(host, { primaryIpv6: "2001:19f0:5:2::2" }, { addressManual: true }), { primaryIpv6: "2001:19f0:5:2::2" });
  assert.throws(() => hostPrimaryAddressPatch(host, { primaryIpv4: "8.8.8.8" }), /只能从 Agent 检测到的地址里选/);
  assert.throws(() => hostPrimaryAddressPatch(host, { primaryIpv4: "10.0.0.1" }), /不是公网 IPv4/);
});
