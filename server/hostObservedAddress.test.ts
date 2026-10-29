import assert from "node:assert/strict";
import test from "node:test";

import { exitAddressMismatch, recordHostObservedAddress, resetHostObservedAddressesForTest, withHostObservedAddress } from "./hostObservedAddress";

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
