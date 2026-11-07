import assert from "node:assert/strict";
import test from "node:test";

import { exitAddressMismatch, hostEgressAddress, recordHostObservedAddress, resetHostObservedAddressesForTest, withHostObservedAddress } from "./hostObservedAddress";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);

test("登记的 IPv4 和面板看到的不一样才算不符；不同族、登记为空都不算", () => {
  assert.equal(exitAddressMismatch({ ipv4: "1.2.3.4" }, "1.2.3.4"), false);
  assert.equal(exitAddressMismatch({ ipv4: "1.2.3.4" }, "5.6.7.8"), true);
  assert.equal(exitAddressMismatch({ ipv4: "1.2.3.4" }, "2001:db8::1"), false, "族不同不比");
  assert.equal(exitAddressMismatch({ ipv6: "2001:db8::1" }, "2001:db8::2"), true);
  assert.equal(exitAddressMismatch({}, "5.6.7.8"), false);
  assert.equal(exitAddressMismatch({ ip: "1.2.3.4" }, "5.6.7.8"), true, "只有 ip 一栏时拿它比");
  assert.equal(exitAddressMismatch({ ipv4: "1.2.3.4" }, null), false);
});

test("心跳记下的地址十分钟内有效；汇总行补 observedIp 和 exitIpMismatch", () => {
  resetHostObservedAddressesForTest();
  recordHostObservedAddress(1, "5.6.7.8", T0);
  recordHostObservedAddress(2, "not-an-ip", T0);
  const rows = withHostObservedAddress([
    { id: 1, ipv4: "1.2.3.4" },
    { id: 2, ipv4: "1.2.3.4" },
    { id: 3, ipv4: "9.9.9.9" },
  ], T0 + 1000);
  assert.deepEqual(rows.map((row) => [row.observedIp, row.exitIpMismatch]), [["5.6.7.8", true], [null, false], [null, false]]);
  assert.equal(withHostObservedAddress([{ id: 1, ipv4: "1.2.3.4" }], T0 + 11 * 60_000)[0].observedIp, null);
});

test("出口地址：十分钟内看到的心跳来源优先，没有就按登记的 IPv4、IPv6、ip 一栏；域名不算", () => {
  resetHostObservedAddressesForTest();
  recordHostObservedAddress(1, "5.6.7.8", T0);
  assert.equal(hostEgressAddress({ id: 1, ipv4: "1.2.3.4" }, T0 + 1000), "5.6.7.8", "看到的心跳来源压过登记地址");
  assert.equal(hostEgressAddress({ id: 1, ipv4: "1.2.3.4" }, T0 + 11 * 60_000), "1.2.3.4", "心跳来源过期就按登记的");
  assert.equal(hostEgressAddress({ id: 2, ipv6: "2001:db8::1" }, T0), "2001:db8::1");
  assert.equal(hostEgressAddress({ id: 2, ipv4: " 1.2.3.4 ", ipv6: "2001:db8::1" }, T0), "1.2.3.4", "IPv4 排在 IPv6 前面");
  assert.equal(hostEgressAddress({ id: 3, ip: "9.9.9.9" }, T0), "9.9.9.9", "只有 ip 一栏时拿它");
  assert.equal(hostEgressAddress({ id: 3, ip: "example.com" }, T0), "", "域名不是出口 IP");
  assert.equal(hostEgressAddress(null, T0), "");
});
