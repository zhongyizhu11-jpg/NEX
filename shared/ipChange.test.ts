import assert from "node:assert/strict";
import test from "node:test";

import {
  IP_CHANGE_DEFAULT_CHECK_TARGETS,
  IP_CHANGE_PROBE_SERVICE_ID_BASE,
  ipChangeProbeIndex,
  ipChangeProbeServiceId,
  isIpChangeProbeServiceId,
  normalizeIpChangeNumbers,
  parseIpChangeCheckTargets,
} from "./ipChange";

test("探测目标：域名:端口、IP:端口、[IPv6]:端口、只写主机，一行一个", () => {
  const { targets, errors } = parseIpChangeCheckTargets("www.189.cn:80\n1.2.3.4:443\n[2001:db8::1]:8080\nexample.cn\nWWW.189.CN:80", "tcp");
  assert.deepEqual(errors, []);
  assert.deepEqual(targets, [
    { host: "www.189.cn", port: 80 },
    { host: "1.2.3.4", port: 443 },
    { host: "2001:db8::1", port: 8080 },
    { host: "example.cn", port: 80 },
  ]);
  const ping = parseIpChangeCheckTargets("114.114.114.114:53, 223.5.5.5", "ping");
  assert.deepEqual(ping.targets, [{ host: "114.114.114.114", port: 0 }, { host: "223.5.5.5", port: 0 }]);
  assert.equal(parseIpChangeCheckTargets("bad host!:80", "tcp").errors.length, 1);
  assert.equal(parseIpChangeCheckTargets("a.cn:99999", "tcp").errors.length, 1);
  assert.equal(parseIpChangeCheckTargets(Array.from({ length: 9 }, (_, i) => `h${i}.cn:80`).join("\n"), "tcp").targets.length, 8);
});

test("默认目标都能解析，且不含海外有 CDN 节点的大站", () => {
  const { targets, errors } = parseIpChangeCheckTargets(IP_CHANGE_DEFAULT_CHECK_TARGETS, "tcp");
  assert.deepEqual(errors, []);
  assert.ok(targets.length >= 2, "多个目标，避免单个目标挂了被误判");
  assert.ok(!targets.some((target) => /qq\.com|baidu\.com/.test(target.host)));
});

test("保留的 serviceId 段：落在 int32 以内，和真实服务的自增 ID 分得开", () => {
  assert.equal(ipChangeProbeServiceId(0), IP_CHANGE_PROBE_SERVICE_ID_BASE);
  assert.ok(ipChangeProbeServiceId(7) < 2 ** 31 - 1);
  assert.equal(ipChangeProbeIndex(ipChangeProbeServiceId(3)), 3);
  assert.equal(isIpChangeProbeServiceId(42), false);
  assert.equal(isIpChangeProbeServiceId(IP_CHANGE_PROBE_SERVICE_ID_BASE + 8), false);
});

test("数值设置夹到合法范围：检测间隔最少 30 秒", () => {
  assert.deepEqual(normalizeIpChangeNumbers({ failureThreshold: 0, checkIntervalSeconds: 5, cooldownMinutes: "x", maxChangesPerDay: 1000 }), {
    failureThreshold: 2,
    checkIntervalSeconds: 30,
    cooldownMinutes: 30,
    maxChangesPerDay: 48,
  });
});
