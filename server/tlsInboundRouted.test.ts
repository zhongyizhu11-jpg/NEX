import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildAgentSniInbounds,
  getSentTlsInboundRevision,
  isTlsInboundTableConfirmed,
  planAgentSniInbounds,
  recordTlsInboundRuntimeStatus,
  sniRuleRuntimeView,
} from "./tlsInboundRuntime";
import type { TlsInboundRow } from "./repositories/tlsInboundRepository";
import { TLS_INBOUND_ROUTED_AGENT_VERSION } from "../shared/tlsInbound";

/*
  转送规则（经隧道 / 转发链 / 转发组走的 SNI 规则）的规划：哪台 Agent 拿到哪张分流表、老 Agent 怎么挡、
  表的版本号怎么下发和确认。
*/

const NEW = TLS_INBOUND_ROUTED_AGENT_VERSION;
const OLD = "2.2.252";

const inbound = (overrides: Partial<TlsInboundRow> = {}): TlsInboundRow => ({
  id: 1,
  hostId: 10,
  name: "共享 443",
  port: 443,
  isEnabled: true,
  allowedSni: [],
  rejectEmptySni: true,
  unknownSniAction: "reject",
  defaultRuleId: null,
  proxyProtocol: "off",
  maxHandshakes: 128,
  handshakeTimeoutSeconds: 5,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

const rule = (overrides: Record<string, unknown> = {}) => ({
  id: 100,
  hostId: 10,
  userId: 2,
  tlsInboundId: 1,
  sniNames: JSON.stringify(["direct.example.com"]),
  sourcePort: 45001,
  isEnabled: true,
  pendingDelete: false,
  protocol: "tcp",
  forwardType: "realm",
  proxyProtocolSend: false,
  proxyProtocolVersion: 1,
  ...overrides,
});

// 主机 10 上：一条直连、一条经隧道、一条转发组在这台成员上的子规则，都挂入站 1。
const directRule = rule();
const tunnelRule = rule({ id: 200, tunnelId: 7, forwardType: "gost", sniNames: JSON.stringify(["tunnel.example.com"]), sourcePort: 45002 });
const groupChildOn10 = rule({ id: 300, forwardGroupId: 5, forwardGroupRuleId: 299, sniNames: JSON.stringify(["group.example.com"]), sourcePort: 45003 });
// 同一个组在主机 11 上的子规则，挂主机 11 自己同端口的入站 2。
const groupChildOn11 = rule({ id: 301, hostId: 11, tlsInboundId: 2, forwardGroupId: 5, forwardGroupRuleId: 299, sniNames: JSON.stringify(["group.example.com"]), sourcePort: 45003 });
// 主机 12 没有 443 入站：子规则挂着锚点（入站 1，在主机 10 上）。
const groupChildOn12 = rule({ id: 302, hostId: 12, tlsInboundId: 1, forwardGroupId: 5, forwardGroupRuleId: 299, sniNames: JSON.stringify(["group.example.com"]), sourcePort: 45003 });
const inbounds = [inbound(), inbound({ id: 2, hostId: 11 })];
const inboundById = new Map(inbounds.map((item) => [item.id, item] as const));

function viewOn(hostId: number, agentVersion: string, rules: any[]) {
  return rules.map((item) => sniRuleRuntimeView(item, { hostId, agentVersion, inboundById }));
}

test("每台入口机只拿到自己身上的分流表：直连、隧道入口、组子规则的名字指向各自的回环端口", () => {
  const all = [directRule, tunnelRule, groupChildOn10, groupChildOn11, groupChildOn12];
  const on10 = buildAgentSniInbounds({ hostId: 10, agentVersion: NEW, inbounds, rules: viewOn(10, NEW, all) });
  assert.equal(on10.length, 1);
  assert.deepEqual(on10[0].routes.map((route) => [route.name, route.ruleId, route.backendPort, route.active]), [
    ["direct.example.com", 100, 45001, true],
    ["group.example.com", 300, 45003, true],
    ["tunnel.example.com", 200, 45002, true],
  ]);
  const on11 = buildAgentSniInbounds({ hostId: 11, agentVersion: NEW, inbounds, rules: viewOn(11, NEW, all) });
  assert.deepEqual(on11.map((spec) => spec.id), [2]);
  assert.deepEqual(on11[0].routes.map((route) => [route.name, route.ruleId]), [["group.example.com", 301]]);
  // 主机 12 没有入站：没有表；它上面的子规则按停用下发（不会对外开出回环端口）。
  assert.deepEqual(buildAgentSniInbounds({ hostId: 12, agentVersion: NEW, inbounds, rules: viewOn(12, NEW, all) }), []);
  const blocked = sniRuleRuntimeView(groupChildOn12, { hostId: 12, agentVersion: NEW, inboundById });
  assert.equal(blocked.isEnabled, false);
  assert.equal((blocked as any).sniRuntimeBlocked, true);
});

test("老 Agent：转送规则按停用下发（名字留着、标成不可用），直连规则照旧", () => {
  const views = viewOn(10, "2.2.240", [directRule, tunnelRule, groupChildOn10]);
  assert.equal(views[0].isEnabled, true);
  assert.equal(views[1].isEnabled, false);
  assert.equal(views[2].isEnabled, false);
  const specs = buildAgentSniInbounds({ hostId: 10, agentVersion: "2.2.240", inbounds, rules: views });
  assert.deepEqual(specs[0].routes.map((route) => [route.name, route.active]), [
    ["direct.example.com", true],
    ["group.example.com", false],
    ["tunnel.example.com", false],
  ]);
  // 老 Agent 不认 revision，也不发给它。
  assert.equal(specs[0].revision, undefined);
});

test("隧道出口机上看到的隧道 SNI 规则原样放过（同一个对象），出口那一半不受影响", () => {
  const onExit = sniRuleRuntimeView(tunnelRule, { hostId: 99, agentVersion: OLD, inboundById });
  assert.equal(onExit, tunnelRule);
});

test("经隧道的 SNI 规则在入口机上不带 PROXY 头：分流器不发，隧道入口不收", () => {
  const view = sniRuleRuntimeView({ ...tunnelRule, proxyProtocolSend: true, proxyProtocolExitSend: true }, { hostId: 10, agentVersion: NEW, inboundById }) as any;
  assert.equal(view.isEnabled, true);
  assert.equal(view.proxyProtocolReceive, false);
  assert.equal(view.proxyProtocolSend, false);
  assert.equal(view.proxyProtocolExitSend, false);
  const specs = buildAgentSniInbounds({ hostId: 10, agentVersion: NEW, inbounds, rules: [view] });
  assert.equal(specs[0].routes[0].proxyProtocolVersion, 0);
});

test("表的版本号：内容不变就不变，名字 / 端口 / 可用状态一变就变", () => {
  const base = buildAgentSniInbounds({ hostId: 10, agentVersion: NEW, inbounds, rules: [directRule] })[0];
  const again = buildAgentSniInbounds({ hostId: 10, agentVersion: NEW, inbounds, rules: [{ ...directRule }] })[0];
  assert.match(String(base.revision), /^[0-9a-f]{16}$/);
  assert.equal(again.revision, base.revision);
  for (const changed of [
    { ...directRule, sniNames: JSON.stringify(["other.example.com"]) },
    { ...directRule, sourcePort: 45009 },
    { ...directRule, isEnabled: false },
  ]) {
    const next = buildAgentSniInbounds({ hostId: 10, agentVersion: NEW, inbounds, rules: [changed] })[0];
    assert.notEqual(next.revision, base.revision);
  }
});

test("确认：Agent 报它在听、报回来的版本号就是最近下发的那张，才算确认", () => {
  const hostId = 4100;
  const local = [inbound({ id: 41, hostId })];
  const specs = planAgentSniInbounds({ hostId, agentVersion: NEW, inbounds: local, rules: [rule({ hostId, tlsInboundId: 41 })] });
  const sent = getSentTlsInboundRevision(hostId, 41);
  assert.equal(sent, specs[0].revision);
  assert.equal(isTlsInboundTableConfirmed(hostId, 41), false, "还没报回来");
  recordTlsInboundRuntimeStatus(hostId, [{ id: 41, port: 443, listening: true, revision: "stale" }]);
  assert.equal(isTlsInboundTableConfirmed(hostId, 41), false, "报回来的是旧表");
  recordTlsInboundRuntimeStatus(hostId, [{ id: 41, port: 443, listening: false, error: "in use", revision: sent }]);
  assert.equal(isTlsInboundTableConfirmed(hostId, 41), false, "收到了表但端口没听起来");
  recordTlsInboundRuntimeStatus(hostId, [{ id: 41, port: 443, listening: true, revision: sent, routes: 1, matched: 3, dropped: 1, backendErrors: 0 }]);
  assert.equal(isTlsInboundTableConfirmed(hostId, 41), true);
  // 表一换（规则改名），旧的确认就作废，等 Agent 报新版本号。
  planAgentSniInbounds({ hostId, agentVersion: NEW, inbounds: local, rules: [rule({ hostId, tlsInboundId: 41, sniNames: JSON.stringify(["x.example.com"]) })] });
  assert.equal(isTlsInboundTableConfirmed(hostId, 41), false);
});

test("老 Agent 永远确认不了（不下发版本号）", () => {
  const hostId = 4200;
  planAgentSniInbounds({ hostId, agentVersion: OLD, inbounds: [inbound({ id: 42, hostId })], rules: [] });
  recordTlsInboundRuntimeStatus(hostId, [{ id: 42, port: 443, listening: true }]);
  assert.equal(getSentTlsInboundRevision(hostId, 42), "");
  assert.equal(isTlsInboundTableConfirmed(hostId, 42), false);
});

test("心跳接上了：隧道入口（FXP / gost / nginx）在 SNI 规则上只听回环，内核直通不接 SNI 规则", () => {
  const route = fs.readFileSync(path.resolve(import.meta.dirname, "agentHeartbeatRoute.ts"), "utf8");
  const gost = fs.readFileSync(path.resolve(import.meta.dirname, "agentHeartbeatGostPlan.ts"), "utf8");
  const nginx = fs.readFileSync(path.resolve(import.meta.dirname, "agentHeartbeatNginxPlan.ts"), "utf8");
  assert.match(route, /isSniRuntimeRule\(rule\) \? \{ listenHost: "127\.0\.0\.1" \} : \{\}/);
  assert.match(route, /\/\/ 共享 TLS 入站上的规则：连接从本机回环进来，PREROUTING 的直通规则接不到。\n\s*if \(isSniRuntimeRule\(rule\)\) return false;/);
  assert.match(route, /const sniInbounds = planAgentSniInbounds\(\{/);
  assert.match(gost, /const loopbackOnly = \(useRuleGuard && !tunnel\) \|\| \(!!tunnel && isSniRuntimeRule\(r\)\);/);
  assert.match(gost, /addr: loopbackOnly \? `127\.0\.0\.1:\$\{serviceListenPort\}` : `:\$\{serviceListenPort\}`/);
  assert.match(nginx, /loopbackOnly: useRuleGuard \|\| isSniRuntimeRule\(rule\),/);
});
