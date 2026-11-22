import assert from "node:assert/strict";
import test from "node:test";

import { diagnosisRouteOutdated, parseDiagnosisRouteRequest } from "./diagnosisRoute";

/*
  用户面板 2026-11-22：13:57:00 把链路「华南-香港」(1) 的出口组换成单出口 jinx(39.9y)(7)，规则「广港hkt/2」(33)
  13:56:50 的诊断是 Po0(200M)(9) → hep ix(12) → hkboil:24895，弹窗还画着这条旧路线。
*/
const request = JSON.stringify({ kind: "forward-via-tunnel", tunnelId: 1, entryHostId: 9, exitHostId: 12, primaryExitHostId: 7, viaActiveExit: true, targetIp: "hkboil.ddos.top", targetPort: 24895, method: "tcp" });
const test1356 = { hostId: 12, requestMessage: request, updatedAt: "2026-11-22T05:56:50.000Z" };
const now = { tunnelId: 1, hostId: 9, targetIp: "hkboil.ddos.top", targetPort: 24895, tunnelEntryHostId: 9, tunnelExitHostIds: [7], topologyChangedAt: "2026-11-22T05:57:00.000Z" };

test("隧道换了出口（hep ix 不在现在的出口里）、诊断早于换拓扑的时间：旧路线", () => {
  assert.equal(diagnosisRouteOutdated(test1356, now), true);
  assert.equal(diagnosisRouteOutdated(test1356, { ...now, topologyChangedAt: null }), true, "没记时间也认得出：测的出口不在现在的出口里");
});

test("换完之后重测的（出口 7、时间在换拓扑之后）：不是旧的；同一秒内的也不算旧", () => {
  const fresh = { hostId: 7, requestMessage: JSON.stringify({ kind: "forward-via-tunnel", tunnelId: 1, entryHostId: 9, exitHostId: 7, targetIp: "hkboil.ddos.top", targetPort: 24895 }), updatedAt: "2026-11-22T06:01:15.000Z" };
  assert.equal(diagnosisRouteOutdated(fresh, now), false);
  assert.equal(diagnosisRouteOutdated({ ...fresh, updatedAt: "2026-11-22T05:57:00.000Z" }, now), false, "库里时间只到秒");
  assert.equal(diagnosisRouteOutdated({ ...fresh, updatedAt: "2026-11-22T05:56:59.000Z" }, now), true);
});

test("负载均衡：测的出口是组里任一台都算现在的路线；规则换了隧道、入口换了、目标换了都是旧的", () => {
  const balanced = { ...now, tunnelExitHostIds: [7, 12, 2], topologyChangedAt: null };
  assert.equal(diagnosisRouteOutdated(test1356, balanced), false);
  assert.equal(diagnosisRouteOutdated(test1356, { ...balanced, tunnelId: 6 }), true, "规则挪到了另一条隧道");
  assert.equal(diagnosisRouteOutdated(test1356, { ...balanced, tunnelEntryHostId: 6 }), true, "隧道换了入口");
  assert.equal(diagnosisRouteOutdated(test1356, { ...balanced, targetPort: 24896 }), true, "目标端口换了");
  assert.equal(diagnosisRouteOutdated(test1356, { ...balanced, targetIp: "HKBOIL.ddos.top" }), false, "域名大小写不算换");
  assert.equal(diagnosisRouteOutdated(test1356, { ...balanced, tunnelId: null }), true, "规则改成了直连");
});

test("直连规则：没有请求 JSON，测的主机和现在的入口不一样才算旧；改成走隧道算旧", () => {
  const direct = { hostId: 9, requestMessage: null, updatedAt: "2026-11-22T05:00:00Z" };
  assert.equal(diagnosisRouteOutdated(direct, { tunnelId: null, hostId: 9, targetIp: "1.2.3.4", targetPort: 80 }), false);
  assert.equal(diagnosisRouteOutdated(direct, { tunnelId: null, hostId: 6, targetIp: "1.2.3.4", targetPort: 80 }), true);
  assert.equal(diagnosisRouteOutdated(direct, { tunnelId: 1, hostId: 9, targetIp: "1.2.3.4", targetPort: 80, tunnelExitHostIds: [7] }), true);
});

test("转发组 / 转发链 / 线路段的诊断不按这套判（它们自己的路线另有记法）", () => {
  const group = { hostId: 9, requestMessage: JSON.stringify({ kind: "forward-group", groupId: 1 }), updatedAt: "2026-11-22T05:00:00Z" };
  assert.equal(diagnosisRouteOutdated(group, { tunnelId: null, hostId: 6, targetIp: "x", targetPort: 1 }), false);
  assert.equal(parseDiagnosisRouteRequest("not json"), null);
  assert.equal(parseDiagnosisRouteRequest(null), null);
});
