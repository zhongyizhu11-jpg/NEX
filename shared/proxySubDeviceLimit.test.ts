import assert from "node:assert/strict";
import test from "node:test";

import { effectiveDeviceLimit, evaluateProxySubDeviceAccess, normalizeProxySubHwid } from "./proxySubDeviceLimit";

const HOUR = 3_600_000;
const base = { enabled: true, strict: false, limit: 2, ip: "1.1.1.1", now: 1_000 * HOUR, ipWindowMs: 24 * HOUR };

test("hwid 只认 10–64 位的字母数字和 = -", () => {
  assert.equal(normalizeProxySubHwid("abc"), "");
  assert.equal(normalizeProxySubHwid("ABCDEF1234-=xyz"), "ABCDEF1234-=xyz");
  assert.equal(normalizeProxySubHwid("有中文的设备标识123456"), "");
});

test("没开限制时照样登记真 hwid，但永远放行", () => {
  const decision = evaluateProxySubDeviceAccess({ ...base, enabled: false, hwid: "DEVICE-0001-ABCDEF", devices: [] });
  assert.equal(decision.allowed, true);
  assert.equal(decision.deviceKey, "DEVICE-0001-ABCDEF");
  assert.equal(decision.isNew, true);
  assert.deepEqual(decision.headers, {});
});

test("带 hwid：已知设备放行，第三台拒绝并带 x-hwid 头", () => {
  const devices = [{ hwid: "DEVICE-0001-ABCDEF", lastSeenAt: base.now }, { hwid: "DEVICE-0002-ABCDEF", lastSeenAt: base.now }];
  const known = evaluateProxySubDeviceAccess({ ...base, hwid: "DEVICE-0001-ABCDEF", devices });
  assert.equal(known.allowed, true);
  assert.equal(known.isNew, false);
  assert.equal(known.headers["x-hwid-active"], "true");
  const third = evaluateProxySubDeviceAccess({ ...base, hwid: "DEVICE-0003-ABCDEF", devices });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "device-limit");
  assert.equal(third.headers["x-hwid-max-devices-reached"], "true");
  assert.equal(third.headers["x-hwid-limit"], "true");
});

test("不带 hwid：严格模式拒绝；退化模式按 IP 算，窗口外的 IP 不算", () => {
  const strict = evaluateProxySubDeviceAccess({ ...base, strict: true, hwid: "", devices: [] });
  assert.equal(strict.allowed, false);
  assert.equal(strict.reason, "hwid-required");
  assert.equal(strict.headers["x-hwid-not-supported"], "true");

  const devices = [{ hwid: "ip:2.2.2.2", lastSeenAt: base.now - HOUR }, { hwid: "ip:3.3.3.3", lastSeenAt: base.now - 48 * HOUR }];
  const relaxed = evaluateProxySubDeviceAccess({ ...base, hwid: "", devices });
  assert.equal(relaxed.allowed, true, "48 小时前的 IP 已经不算一台设备");
  assert.equal(relaxed.deviceKey, "ip:1.1.1.1");
  const full = evaluateProxySubDeviceAccess({ ...base, hwid: "", devices: [...devices, { hwid: "ip:4.4.4.4", lastSeenAt: base.now }] });
  assert.equal(full.allowed, false);
});

test("上限不限（0）时只登记不拒绝；三层上限取最严", () => {
  const decision = evaluateProxySubDeviceAccess({ ...base, limit: 0, hwid: "DEVICE-0009-ABCDEF", devices: Array.from({ length: 10 }, (_item, index) => ({ hwid: `DEVICE-${index}-ABCDEFGH`, lastSeenAt: base.now })) });
  assert.equal(decision.allowed, true);
  assert.equal(effectiveDeviceLimit(0, 0, 0), 0);
  assert.equal(effectiveDeviceLimit(5, 0, 3), 3);
  assert.equal(effectiveDeviceLimit(0, 2, 0), 2);
});
