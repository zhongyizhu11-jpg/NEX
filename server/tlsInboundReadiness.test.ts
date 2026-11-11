import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluateSniMemberReadiness, filterSniReadyCandidates } from "./tlsInboundReadiness";
import { TLS_INBOUND_ROUTED_AGENT_VERSION } from "../shared/tlsInbound";

/*
  转发组 / 入口组的 DDNS 只切到（加进）SNI 配置已确认的成员。这里测「就绪」怎么判、候选怎么筛。
*/

const template = { id: 299, name: "shop", isEnabled: true, tlsInboundId: 1 };
const child = (overrides: Record<string, unknown> = {}) => ({
  id: 301,
  hostId: 11,
  forwardGroupRuleId: 299,
  tlsInboundId: 2,
  isEnabled: true,
  isRunning: true,
  pendingDelete: false,
  ...overrides,
});
const inboundById = new Map([
  [1, { id: 1, hostId: 10, port: 443, isEnabled: true }],
  [2, { id: 2, hostId: 11, port: 443, isEnabled: true }],
]);
const base = {
  hostId: 11,
  agentVersion: TLS_INBOUND_ROUTED_AGENT_VERSION,
  templates: [template],
  children: [child()],
  inboundById,
  confirmed: (hostId: number, inboundId: number) => hostId === 11 && inboundId === 2,
};

test("全部满足：Agent 够新、挂着自己的入站、子规则在跑、路由表已确认", () => {
  assert.deepEqual(evaluateSniMemberReadiness(base), { ready: true, reason: null });
});

test("没有 SNI 规则的组不受影响（永远就绪）", () => {
  assert.equal(evaluateSniMemberReadiness({ ...base, templates: [{ id: 1, isEnabled: true, tlsInboundId: null }] }).ready, true);
  assert.equal(evaluateSniMemberReadiness({ ...base, templates: [{ ...template, isEnabled: false }], agentVersion: "1.0.0" }).ready, true);
  assert.equal(evaluateSniMemberReadiness({ ...base, templates: [{ ...template, pendingDelete: true }], agentVersion: "1.0.0" }).ready, true);
});

test("每一种没就绪都说清原因", () => {
  const cases: Array<[Partial<typeof base>, RegExp]> = [
    [{ agentVersion: "2.2.252" }, new RegExp(TLS_INBOUND_ROUTED_AGENT_VERSION.replace(/\./g, "\\."))],
    [{ children: [] }, /还没有子规则/],
    [{ children: [child({ pendingDelete: true })] }, /还没有子规则/],
    // 子规则挂着锚点（入站在别的机器上）= 这台没有同端口的入站。
    [{ children: [child({ tlsInboundId: 1 })] }, /没有规则「shop」要用的共享 TLS 入站/],
    [{ inboundById: new Map([[2, { id: 2, hostId: 11, port: 443, isEnabled: false }]]) }, /已停用/],
    [{ children: [child({ isEnabled: false })] }, /子规则已停用/],
    [{ children: [child({ isRunning: false })] }, /还没跑起来/],
    [{ confirmed: () => false }, /还没被 Agent 确认/],
  ];
  for (const [overrides, reason] of cases) {
    const result = evaluateSniMemberReadiness({ ...base, ...overrides } as any);
    assert.equal(result.ready, false, String(reason));
    assert.match(String(result.reason), reason);
  }
});

test("DDNS 候选：没就绪的成员不切过去，但当前在用的那台不因此被撤掉", async () => {
  const members = [{ id: 1, hostId: 10 }, { id: 2, hostId: 11 }, { id: 3, hostId: 12 }];
  const readyHosts = new Set([11]);
  const result = await filterSniReadyCandidates({
    candidates: members,
    keepMemberId: 1,
    templates: [template],
    hostIdOf: (member) => member.hostId,
    load: async (hostId) => (readyHosts.has(hostId) ? { ready: true, reason: null } : { ready: false, reason: `host ${hostId} not ready` }),
  });
  assert.deepEqual(result.ready.map((member) => member.id), [1, 2]);
  assert.deepEqual(result.blocked.map((item) => [item.member.id, item.reason]), [[3, "host 12 not ready"]]);
  // 组里没有 SNI 规则：一个都不筛，也不去查。
  const untouched = await filterSniReadyCandidates({
    candidates: members,
    templates: [],
    hostIdOf: (member) => member.hostId,
    load: async () => { throw new Error("must not load"); },
  });
  assert.equal(untouched.ready.length, 3);
});

test("接上了：转发组故障转移和入口组 DDNS 都过这道筛", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "repositories/forwardGroupRepository.ts"), "utf8");
  // 故障转移：健康成员再按 SNI 就绪筛一遍，firstHealthy / 回切候选都从筛过的里挑。
  assert.match(source, /const healthyMembers = \(await sniReadyGroupCandidates\(group, templates, evaluated/);
  // 入口组：还没解析到的成员 SNI 没确认就先不加进来。
  assert.match(source, /if \(!previouslyIncluded && sniTemplates\.length > 0\n\s*&& \(await sniReadyGroupCandidates\(/);
});
