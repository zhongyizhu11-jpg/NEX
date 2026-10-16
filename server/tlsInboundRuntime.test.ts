import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildAgentSniInbounds, recordTlsInboundRuntimeStatus, getTlsInboundRuntimeStatus, sniRuleRuntimeView } from "./tlsInboundRuntime";
import type { TlsInboundRow } from "./repositories/tlsInboundRepository";

const inbound = (overrides: Partial<TlsInboundRow> = {}): TlsInboundRow => ({
  id: 1,
  hostId: 10,
  name: "共享 443",
  port: 443,
  isEnabled: true,
  allowedSni: ["example.com"],
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

const sniRule = (overrides: Record<string, unknown> = {}) => ({
  id: 100,
  hostId: 10,
  userId: 2,
  tlsInboundId: 1,
  sniNames: JSON.stringify(["a.example.com", "b.example.com"]),
  sourcePort: 45001,
  isEnabled: true,
  pendingDelete: false,
  protocol: "tcp",
  forwardType: "realm",
  proxyProtocolSend: false,
  proxyProtocolVersion: 1,
  ...overrides,
});

test("心跳 sniInbounds 的形状：每个启用的入站一份路由表，名字指向规则的回环端口", () => {
  const sections = buildAgentSniInbounds({
    hostId: 10,
    agentVersion: "2.2.224",
    inbounds: [inbound(), inbound({ id: 2, port: 8443, isEnabled: false })],
    rules: [sniRule(), { id: 7, hostId: 10, sourcePort: 8080, isEnabled: true }],
  });
  assert.deepEqual(sections, [{
    id: 1,
    port: 443,
    proxyProtocol: "off",
    rejectEmptySni: true,
    unknownSniAction: "reject",
    maxHandshakes: 128,
    maxHandshakesPerIp: 16,
    handshakeTimeoutSeconds: 5,
    allowedSni: ["example.com"],
    defaultBackend: null,
    routes: [
      { name: "a.example.com", ruleId: 100, backendPort: 45001, active: true, proxyProtocolVersion: 0 },
      { name: "b.example.com", ruleId: 100, backendPort: 45001, active: true, proxyProtocolVersion: 0 },
    ],
  }]);
});

test("老 Agent 拿到空数组，规则按停用下发", () => {
  assert.deepEqual(buildAgentSniInbounds({ hostId: 10, agentVersion: "2.2.223", inbounds: [inbound()], rules: [sniRule()] }), []);
  const view = sniRuleRuntimeView(sniRule(), { hostId: 10, agentVersion: "2.2.223", inboundById: new Map([[1, inbound()]]) });
  assert.equal(view.isEnabled, false);
});

test("入站停用 / 不在 / 不在这台机器上：规则按停用下发", () => {
  for (const map of [new Map([[1, inbound({ isEnabled: false })]]), new Map(), new Map([[1, inbound({ hostId: 11 })]])]) {
    const view = sniRuleRuntimeView(sniRule(), { hostId: 10, agentVersion: "2.2.224", inboundById: map as any });
    assert.equal(view.isEnabled, false);
  }
  const ok = sniRuleRuntimeView(sniRule(), { hostId: 10, agentVersion: "2.2.224", inboundById: new Map([[1, inbound()]]) });
  assert.equal(ok.isEnabled, true);
  // 普通规则原样通过（同一个对象）。
  const plain = { id: 1, hostId: 10, isEnabled: true };
  assert.equal(sniRuleRuntimeView(plain, { hostId: 10, agentVersion: "2.2.224", inboundById: new Map() }), plain);
});

test("规则要发 PROXY 头时，守卫先收入站给的头；协议固定 TCP、不开协议封禁", () => {
  const view = sniRuleRuntimeView(sniRule({ proxyProtocolSend: true, protocol: "both", blockTls: true }), {
    hostId: 10, agentVersion: "2.2.224", inboundById: new Map([[1, inbound()]]),
  });
  assert.equal((view as any).proxyProtocolReceive, true);
  assert.equal(view.protocol, "tcp");
  assert.equal((view as any).blockTls, false);
  const sections = buildAgentSniInbounds({ hostId: 10, agentVersion: "2.2.224", inbounds: [inbound()], rules: [{ ...view, proxyProtocolVersion: 2 }] });
  assert.equal(sections[0].routes[0].proxyProtocolVersion, 2);
});

test("暂停的规则保留名字但标成不可用；待删的规则不出现", () => {
  const sections = buildAgentSniInbounds({
    hostId: 10,
    agentVersion: "2.2.224",
    inbounds: [inbound()],
    rules: [
      sniRule({ isEnabled: false }),
      sniRule({ id: 101, sniNames: JSON.stringify(["gone.example.com"]), pendingDelete: true }),
    ],
  });
  assert.deepEqual(sections[0].routes.map((route) => [route.name, route.active]), [["a.example.com", false], ["b.example.com", false]]);
});

test("默认规则只在启用着时下发", () => {
  const withDefault = inbound({ unknownSniAction: "default_rule", defaultRuleId: 100, rejectEmptySni: false });
  let sections = buildAgentSniInbounds({ hostId: 10, agentVersion: "2.2.224", inbounds: [withDefault], rules: [sniRule()] });
  assert.deepEqual(sections[0].defaultBackend, { ruleId: 100, backendPort: 45001, proxyProtocolVersion: 0 });
  sections = buildAgentSniInbounds({ hostId: 10, agentVersion: "2.2.224", inbounds: [withDefault], rules: [sniRule({ isEnabled: false })] });
  assert.equal(sections[0].defaultBackend, null);
});

test("Agent 报上来的监听状态只存内存", () => {
  recordTlsInboundRuntimeStatus(10, [{ id: 1, port: 443, listening: false, error: "address already in use" }]);
  assert.equal(getTlsInboundRuntimeStatus(10, 1)?.listening, false);
  assert.match(String(getTlsInboundRuntimeStatus(10, 1)?.error), /in use/);
  recordTlsInboundRuntimeStatus(10, [{ id: 1, port: 443, listening: true }]);
  assert.equal(getTlsInboundRuntimeStatus(10, 1)?.listening, true);
});

test("心跳接上了：sniInbounds 是一个状态段，SNI 规则一律走守卫并只听回环", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "agentHeartbeatRoute.ts"), "utf8");
  const sectionNames = /const AGENT_STATE_SECTION_NAMES = \[([\s\S]*?)\] as const;/.exec(source)?.[1] || "";
  assert.match(sectionNames, /"sniInbounds"/);
  assert.match(source, /if \(isSniRuntimeRule\(rule\)\) return true;/);
  assert.equal((source.match(/isSniRuntimeRule\(rule\) \? \{ bindAddress: "127\.0\.0\.1" \} : \{\}/g) || []).length, 2);
  assert.match(source, /sniInbounds,\n\s*\}, agentStateSignatures\);/);
  // 没有新的上报路径：状态随心跳带上来。
  assert.match(source, /recordTlsInboundRuntimeStatus\(Number\(host\.id\), req\.body\.sniInbounds\)/);
});
