import assert from "node:assert/strict";
import test from "node:test";

import { describeMemberLive, groupHasMemberProbes, summarizeGroupLive } from "./forwardGroupMemberLive";

const inUse = { groupMode: "failover", isEnabled: true, templateRuleCount: 2, chinaHealthCheckEnabled: true };

test("被规则用着的转发组：按探测结果，健康的带延迟和国内探测", () => {
  assert.equal(groupHasMemberProbes(inUse), true);
  assert.deepEqual(describeMemberLive(inUse, { healthStatus: "healthy", lastLatencyMs: 23.4, chinaHealthStatus: "healthy", chinaHealthLatencyMs: 41, host: { isOnline: true } }), { tone: "healthy", note: "23ms", title: "转发正常，23ms；国内 41ms" });
  assert.equal(describeMemberLive(inUse, { healthStatus: "unhealthy", host: { isOnline: true } })?.tone, "down");
  assert.equal(describeMemberLive(inUse, { healthStatus: "unknown", host: { isOnline: true } })?.tone, "unknown");
  const china = describeMemberLive(inUse, { healthStatus: "healthy", lastLatencyMs: 30, chinaHealthStatus: "unhealthy", host: { isOnline: true } })!;
  assert.equal(china.tone, "degraded");
  assert.equal(china.note, "国内不通");
});

test("停用、时段外、主机离线优先；组停用不画点", () => {
  assert.equal(describeMemberLive(inUse, { isEnabled: false, healthStatus: "healthy" })?.tone, "off");
  assert.equal(describeMemberLive(inUse, { scheduleSuspended: 1, healthStatus: "healthy" })?.note, "时段外");
  assert.equal(describeMemberLive(inUse, { healthStatus: "healthy", host: { isOnline: false } })?.note, "离线");
  assert.equal(describeMemberLive({ ...inUse, isEnabled: false }, { healthStatus: "healthy" }), null);
});

test("出口组、没被用着的转发组：不拿旧的健康说事，只看主机在线；隧道成员没有点", () => {
  const exit = { groupMode: "exit", isEnabled: true };
  assert.equal(groupHasMemberProbes(exit), false);
  assert.deepEqual(describeMemberLive(exit, { healthStatus: "unhealthy", host: { isOnline: true } }), { tone: "healthy", note: null, title: "主机在线" });
  assert.equal(describeMemberLive(exit, { host: { isOnline: false } })?.tone, "down");
  assert.equal(describeMemberLive({ ...inUse, templateRuleCount: 0 }, { healthStatus: "unhealthy", host: { isOnline: true } })?.tone, "healthy");
  assert.equal(describeMemberLive(exit, { memberType: "tunnel", host: null }), null);
});

test("标题行的「N/M 正常」：停用的不数，等检测的写出来，单成员全好不说", () => {
  const members = [
    { healthStatus: "healthy", lastLatencyMs: 20, host: { isOnline: true } },
    { healthStatus: "unhealthy", host: { isOnline: true } },
    { healthStatus: "unknown", host: { isOnline: true } },
    { isEnabled: false },
  ];
  const summary = summarizeGroupLive(inUse, members)!;
  assert.equal(summary.text, "1/3 正常");
  assert.equal(summary.tone, "warn");
  assert.equal(summary.title, "启用的 3 个成员里：1 个不可用，1 个等检测");
  assert.equal(summarizeGroupLive(inUse, [members[0]]), null);
  assert.equal(summarizeGroupLive(inUse, [members[1]])?.tone, "down");
  assert.equal(summarizeGroupLive(inUse, [members[2]]), null, "全在等检测时不下结论");
  assert.equal(summarizeGroupLive(inUse, [members[0], members[0]])?.tone, "ok");
});
