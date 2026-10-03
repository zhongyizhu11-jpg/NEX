import assert from "node:assert/strict";
import test from "node:test";

import { parseManualHostAddress } from "./hostManualAddress";

test("手填检测 IP：单个、两个、框里原样的写法都认；清空交回自动", () => {
  assert.deepEqual(parseManualHostAddress("43.136.54.65"), { manual: true, ip: "43.136.54.65", ipv4: "43.136.54.65", ipv6: null });
  assert.deepEqual(parseManualHostAddress("IPv4 1.2.3.4  /  IPv6 2001:DB8::1"), { manual: true, ip: "1.2.3.4", ipv4: "1.2.3.4", ipv6: "2001:db8::1" });
  assert.deepEqual(parseManualHostAddress("[2001:db8::2]"), { manual: true, ip: "2001:db8::2", ipv4: null, ipv6: "2001:db8::2" });
  assert.deepEqual(parseManualHostAddress("  "), { manual: false });
  assert.match((parseManualHostAddress("example.com") as any).error, /不是 IP/);
  assert.match((parseManualHostAddress("1.2.3.4 5.6.7.8") as any).error, /各填一个/);
});
