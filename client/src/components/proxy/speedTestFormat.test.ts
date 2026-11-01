import assert from "node:assert/strict";
import test from "node:test";

import { formatSpeedMs, formatTraffic, speedServerLabel } from "./speedTestFormat";

test("测速点：Ookla 写运营商、城市和多远；Cloudflare 写机房；面板就写面板服务器", () => {
  assert.equal(speedServerLabel({ server: "ookla", serverName: "China Telecom · Guangzhou", serverDistanceKm: 3, colo: "" }), "Ookla · China Telecom · Guangzhou · 3 km");
  assert.equal(speedServerLabel({ server: "ookla", serverName: "HGC", serverDistanceKm: 0, colo: "" }), "Ookla · HGC");
  assert.equal(speedServerLabel({ server: "cloudflare", serverName: "", serverDistanceKm: 0, colo: "HKG" }), "Cloudflare · HKG");
  assert.equal(speedServerLabel({ server: "panel", serverName: "", serverDistanceKm: 0, colo: "" }), "面板服务器");
});

test("延迟、抖动不到 10 ms 留一位小数（抖动 0.3 ms 不再显示成 0）；流量按 MB / GB", () => {
  assert.equal(formatSpeedMs(0.34), "0.3 ms");
  assert.equal(formatSpeedMs(2), "2.0 ms");
  assert.equal(formatSpeedMs(41.6), "42 ms");
  assert.equal(formatTraffic(293_000_000), "279 MB");
  assert.equal(formatTraffic(2.5 * (1 << 30)), "2.5 GB");
});
