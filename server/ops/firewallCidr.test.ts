import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateCidrs,
  CidrMatcher,
  formatCidr,
  formatCidrShort,
  normalizeClientIp,
  parseCidr,
  parseIp,
  parseZoneText,
} from "./firewallCidr";

test("parseIp handles v4, v6, mapped and brackets", () => {
  assert.deepEqual(parseIp("1.2.3.4"), { family: 4, value: 0x01020304n });
  assert.equal(parseIp("::ffff:1.2.3.4")?.family, 4);
  assert.equal(parseIp("::ffff:1.2.3.4")?.value, 0x01020304n);
  assert.equal(parseIp("[2001:db8::1]")?.family, 6);
  assert.equal(parseIp("fe80::1%eth0")?.family, 6);
  assert.equal(parseIp("1.2.3.256"), null);
  assert.equal(parseIp("example.com"), null);
  assert.equal(parseIp(""), null);
  assert.equal(normalizeClientIp("::ffff:8.8.8.8"), "8.8.8.8");
  assert.equal(normalizeClientIp("2001:DB8:0:0:0:0:0:1"), "2001:db8::1");
});

test("parseCidr masks host bits and validates prefix", () => {
  assert.equal(formatCidr(parseCidr("1.2.3.4/24")!), "1.2.3.0/24");
  assert.equal(formatCidr(parseCidr("1.2.3.4")!), "1.2.3.4/32");
  assert.equal(formatCidrShort(parseCidr("1.2.3.4")!), "1.2.3.4");
  assert.equal(formatCidr(parseCidr("2001:db8:1:2::5/48")!), "2001:db8:1::/48");
  assert.equal(formatCidrShort(parseCidr("2001:db8::1")!), "2001:db8::1");
  assert.equal(parseCidr("1.2.3.0/33"), null);
  assert.equal(parseCidr("2001:db8::/129"), null);
  assert.equal(parseCidr("1.2.3.0/ 24"), null);
  assert.equal(parseCidr("::ffff:1.2.3.0/120"), null);
  assert.equal(formatCidr(parseCidr("0.0.0.0/0")!), "0.0.0.0/0");
});

test("aggregateCidrs merges overlaps and adjacent blocks (v4 + v6)", () => {
  const result = aggregateCidrs([
    "10.0.0.0/25", "10.0.0.128/25", // 相邻 → /24
    "10.0.1.0/24", // 再相邻 → 10.0.0.0/23
    "10.0.0.5", // 被包含
    "192.168.1.0/24", "192.168.1.128/26", // 包含
    "1.0.0.1", "1.0.0.2", // 1.0.0.1/32 + 1.0.0.2/32（不能并成 /31：1.0.0.0/31 不含 .2）
    "2001:db8::/33", "2001:db8:8000::/33", // → 2001:db8::/32
    "2001:db8::1",
    "junk",
  ]);
  assert.deepEqual(result.v4, ["1.0.0.1/32", "1.0.0.2/32", "10.0.0.0/23", "192.168.1.0/24"]);
  assert.deepEqual(result.v6, ["2001:db8::/32"]);
  assert.equal(result.invalid, 1);
});

test("aggregateCidrs splits a non-aligned range into minimal CIDRs", () => {
  // 1.0.0.1 ~ 1.0.0.6 → .1/32 .2/31 .4/31 .6/32
  const result = aggregateCidrs(["1.0.0.1", "1.0.0.2/31", "1.0.0.4/31", "1.0.0.6"]);
  assert.deepEqual(result.v4, ["1.0.0.1/32", "1.0.0.2/31", "1.0.0.4/31", "1.0.0.6/32"]);
  const whole = aggregateCidrs(["0.0.0.0/1", "128.0.0.0/1"]);
  assert.deepEqual(whole.v4, ["0.0.0.0/0"]);
});

test("parseZoneText skips comments and wrong family", () => {
  const text = "# Country: China (CN)\n1.0.1.0/24\n1.0.2.0/23\n\n1.0.8.0/21 ; note\n2400:3200::/32\n<html>\n";
  const v4 = parseZoneText(text, 4);
  assert.deepEqual(v4.cidrs, ["1.0.1.0/24", "1.0.2.0/23", "1.0.8.0/21"]);
  assert.equal(v4.invalid, 2); // <html> + 一条 v6
  const v6 = parseZoneText("2400:3200::/32\n2400:3201::/32\n", 6);
  assert.deepEqual(v6.cidrs, ["2400:3200::/31"]);
});

test("CidrMatcher matches v4, v6 and mapped addresses", () => {
  const matcher = new CidrMatcher(["1.0.1.0/24", "1.0.8.0/21", "2400:3200::/32", "8.8.8.8"]);
  assert.equal(matcher.contains("1.0.1.200"), true);
  assert.equal(matcher.contains("1.0.2.1"), false);
  assert.equal(matcher.contains("1.0.15.255"), true);
  assert.equal(matcher.contains("1.0.16.0"), false);
  assert.equal(matcher.contains("::ffff:8.8.8.8"), true);
  assert.equal(matcher.contains("8.8.8.9"), false);
  assert.equal(matcher.contains("2400:3200:1::1"), true);
  assert.equal(matcher.contains("2400:3201::1"), false);
  assert.equal(matcher.contains("not-an-ip"), false);
  assert.equal(new CidrMatcher([]).contains("1.1.1.1"), false);
});
