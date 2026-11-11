import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCarrierView,
  carrierFailTone,
  missingCarrierPreset,
  normalizeProbeCarrier,
  SHANGHAI_CARRIER_PRESET,
  type CarrierSeriesRow,
} from "./probeCarrier";

const NOW = 1_700_000_000;

const services = [
  { id: 1, name: "上海电信 Ping", carrier: "ct", method: "ping", targetIp: "202.96.209.5" },
  { id: 2, name: "上海联通 TCPing", carrier: "cu", method: "tcping", targetIp: "210.22.84.3", targetPort: 53 },
  { id: 3, name: "上海移动 Ping", carrier: "cm", method: "ping", targetIp: "211.136.150.66" },
  { id: 4, name: "没打标签", carrier: null, method: "ping", targetIp: "1.1.1.1" },
];

function row(serviceId: number, hostId: number, agoSec: number, latencyMs: number | null, probeCount = 5, probeSuccesses = 5): CarrierSeriesRow {
  return { serviceId, hostId, at: NOW - agoSec, latencyMs, probeCount, probeSuccesses };
}

test("按运营商分组：每台主机当前 RTT、24 小时失败率、30 分钟一格的走势；没标签的不出现", () => {
  const groups = buildCarrierView(services, [
    row(1, 10, 3600, 30),
    row(1, 10, 120, 32, 5, 4),
    row(1, 11, 7200, 40),
    // 当前 RTT 只认 15 分钟内的样本
    row(2, 10, 3 * 3600, 25, 1, 1),
    row(2, 10, 300, null, 1, 0),
    row(4, 10, 60, 5),
    // 窗口外的丢掉
    row(3, 10, 30 * 3600, 50),
  ], NOW);
  assert.deepEqual(groups.map((group) => group.carrier), ["ct", "cu", "cm"]);
  const ct = groups[0];
  assert.deepEqual(ct.services.map((service) => service.id), [1]);
  assert.deepEqual(ct.hosts.map((host) => host.hostId), [10, 11]);
  const h10 = ct.hosts[0];
  assert.equal(h10.currentMs, 32);
  assert.equal(h10.failPct, 10, "10 次里失败 1 次");
  assert.equal(h10.failKind, "loss");
  assert.equal(h10.trend.length, 49, "24 小时 48 格，加上当前这一格");
  assert.ok(h10.trend.some((point) => point.latencyMs === 30));
  assert.equal(ct.hosts[1].currentMs, null, "两小时前的样本不算当前");
  assert.equal(ct.hosts[1].avgMs, 40);

  const cu = groups[1].hosts[0];
  assert.equal(cu.failKind, "tcpFail");
  assert.equal(cu.currentMs, null, "最近一次连不上就没有当前 RTT");
  assert.equal(cu.failPct, 50);
  assert.equal(groups[2].hosts.length, 0);
  assert.equal(groups.flatMap((group) => group.services).some((service) => service.id === 4), false);
});

test("上海三网预设：电信 Ping、联通 TCPing 53、移动 Ping；已经有的不重复加", () => {
  assert.deepEqual(SHANGHAI_CARRIER_PRESET.map((item) => [item.carrier, item.method, item.targetIp, item.targetPort]), [
    ["ct", "ping", "202.96.209.5", null],
    ["cu", "tcping", "210.22.84.3", 53],
    ["cm", "ping", "211.136.150.66", null],
  ]);
  assert.equal(missingCarrierPreset([]).length, 3);
  assert.deepEqual(missingCarrierPreset([{ method: "ping", targetIp: "202.96.209.5" }, { method: "tcping", targetIp: "210.22.84.3", targetPort: 80 }]).map((item) => item.carrier), ["cu", "cm"]);
  assert.equal(missingCarrierPreset(services).length, 0);
});

test("取值兜底", () => {
  assert.equal(normalizeProbeCarrier("CT"), "ct");
  assert.equal(normalizeProbeCarrier("telecom"), null);
  assert.equal(normalizeProbeCarrier(null), null);
  assert.equal(carrierFailTone(null), "none");
  assert.equal(carrierFailTone(0), "ok");
  assert.equal(carrierFailTone(3), "warn");
  assert.equal(carrierFailTone(20), "down");
});
