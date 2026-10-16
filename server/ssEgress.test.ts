import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGostEgressChain,
  decryptSsEgressEndpoint,
  encryptSsEgressEndpoint,
  evaluateRuleEgress,
  gostEgressChainName,
  ruleEgressRuntime,
  ruleEgressRuntimeView,
  setSsEgressCipherSecretForTests,
  type EgressRuntimeContext,
} from "./ssEgress";

/**
 * Shadowsocks 出口的纯计算部分：链接的加密保存、规则在 Agent 上的运行视图（什么时候按停用下发）、
 * gost 出口链的形状。落库、接口、心跳整条链路在 ssEgressDb.test.ts。
 */

setSsEgressCipherSecretForTests("unit-test-secret");

const now = new Date();
const landingHost = { id: 20, name: "东京落地", ip: "203.0.113.20", ipv4: "203.0.113.20", isOnline: true, lastHeartbeat: now, userId: 1 };
const inbound = { id: 5, hostId: 20, name: "落地出口 SS", protocol: "shadowsocks", port: 28388, method: "aes-256-gcm", password: "landing-pass", isEnabled: true, userId: 1, landingEgress: true };

function context(overrides: { inbound?: any; host?: any } = {}): EgressRuntimeContext {
  const row = overrides.inbound === undefined ? inbound : overrides.inbound;
  const host = overrides.host === undefined ? landingHost : overrides.host;
  return {
    inboundById: new Map(row ? [[Number(row.id), row]] : []),
    hostById: new Map(host ? [[Number(host.id), host]] : []),
  };
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 7, hostId: 10, forwardType: "gost", protocol: "tcp", isEnabled: true, tunnelId: null,
    egressType: "ss_host", egressInboundId: 5, egressUdp: false, targetIp: "198.51.100.7", targetPort: 443,
    ...overrides,
  };
}

const entry = { entryHostId: 10, entryAgentVersion: "2.2.226", entryHostName: "香港入口" };

test("外部链接加密往返；换了面板密钥就解不开（不报错，回 null）", () => {
  const stored = encryptSsEgressEndpoint({ server: "203.0.113.9", port: 8388, method: "AES-256-GCM", password: "p@ss", name: "x" });
  assert.match(stored, /^enc:v1:/);
  assert.equal(stored.includes("p@ss"), false);
  assert.deepEqual(decryptSsEgressEndpoint(stored), { server: "203.0.113.9", port: 8388, method: "aes-256-gcm", password: "p@ss", name: "x" });
  // 同一份内容每次密文不同（随机 IV）。
  assert.notEqual(encryptSsEgressEndpoint({ server: "203.0.113.9", port: 8388, method: "aes-256-gcm", password: "p@ss" }), encryptSsEgressEndpoint({ server: "203.0.113.9", port: 8388, method: "aes-256-gcm", password: "p@ss" }));
  setSsEgressCipherSecretForTests("another-panel");
  assert.equal(decryptSsEgressEndpoint(stored), null);
  setSsEgressCipherSecretForTests("unit-test-secret");
  assert.equal(decryptSsEgressEndpoint("garbage"), null);
  assert.equal(decryptSsEgressEndpoint(null), null);
});

test("能跑：带上 egressRuntime（地址取落地主机的入口地址，凭据从入站现取）", () => {
  const view: any = ruleEgressRuntimeView(rule({ udpOverTcp: true }), { ...entry, context: context() });
  assert.equal(view.isEnabled, true);
  assert.deepEqual(ruleEgressRuntime(view), { server: "203.0.113.20", port: 28388, method: "aes-256-gcm", password: "landing-pass", udp: false });
  assert.equal(view.protocol, "tcp");
  assert.equal(view.udpOverTcp, false);
  // 库里的规则被改成了 TCP+UDP（保存时本来拦着）：不是「TCP 走出口、UDP 直连」，而是整条不下发。
  const both: any = ruleEgressRuntimeView(rule({ protocol: "both" }), { ...entry, context: context() });
  assert.equal(both.isEnabled, false);
  assert.equal(both.egressRuntimeBlocked, "shape_invalid");
  // 轮换了密码：下一次下发自动是新的。
  const rotated: any = ruleEgressRuntimeView(rule(), { ...entry, context: context({ inbound: { ...inbound, password: "rotated" } }) });
  assert.equal(rotated.egressRuntime.password, "rotated");
});

test("Agent 低于 2.2.226：按停用下发，状态是「需要升级 Agent」，绝不退回直连", () => {
  const view: any = ruleEgressRuntimeView(rule(), { ...entry, entryAgentVersion: "2.2.225", context: context() });
  assert.equal(view.isEnabled, false);
  assert.equal(view.egressRuntimeBlocked, "agent_upgrade");
  assert.equal(ruleEgressRuntime(view), null);
  const evaluation = evaluateRuleEgress(rule(), { ...entry, entryAgentVersion: "2.2.225", context: context() });
  assert.match(String(evaluation?.message), /香港入口.*2\.2\.226/);
});

test("出口失效的几种情况都按停用下发", () => {
  const cases: Array<[string, any, string]> = [
    ["入站被删", { context: context({ inbound: null }) }, "inbound_missing"],
    ["落地主机被删", { context: context({ host: null }) }, "inbound_missing"],
    ["入站停用", { context: context({ inbound: { ...inbound, isEnabled: false } }) }, "inbound_disabled"],
    ["入站改成 SS2022", { context: context({ inbound: { ...inbound, method: "2022-blake3-aes-128-gcm" } }) }, "method_unsupported"],
    ["入站改成别的协议", { context: context({ inbound: { ...inbound, protocol: "vless" } }) }, "method_unsupported"],
    ["落地就是入口", { entryHostId: 20, context: context() }, "self_loop"],
    ["落地没有地址", { context: context({ host: { ...landingHost, ip: "", ipv4: "" } }) }, "config_invalid"],
  ];
  for (const [name, options, state] of cases) {
    const view: any = ruleEgressRuntimeView(rule(), { ...entry, ...options });
    assert.equal(view.isEnabled, false, name);
    assert.equal(view.egressRuntimeBlocked, state, name);
  }
  // 规则形态不对（比如数据库里被改成 realm）同样不下发。
  const realm: any = ruleEgressRuntimeView(rule({ forwardType: "realm" }), { ...entry, context: context() });
  assert.equal(realm.egressRuntimeBlocked, "shape_invalid");
  const tunnel: any = ruleEgressRuntimeView(rule({ tunnelId: 3 }), { ...entry, context: context() });
  assert.equal(tunnel.egressRuntimeBlocked, "shape_invalid");
});

test("落地离线：照样下发（sing-box 可能还活着），状态标「落地离线」", () => {
  const offline = { ...landingHost, isOnline: false };
  const view: any = ruleEgressRuntimeView(rule(), { ...entry, context: context({ host: offline }) });
  assert.equal(view.isEnabled, true);
  assert.ok(ruleEgressRuntime(view));
  assert.equal(evaluateRuleEgress(rule(), { ...entry, context: context({ host: offline }) })?.state, "landing_offline");
  assert.equal(evaluateRuleEgress(rule({ isEnabled: false }), { ...entry, context: context() })?.state, "paused");
});

test("外部链接：解得开就下发，解不开（迁了面板）按停用并提示重新粘贴", () => {
  const stored = encryptSsEgressEndpoint({ server: "198.51.100.50", port: 443, method: "chacha20-ietf-poly1305", password: "ext" });
  const view: any = ruleEgressRuntimeView(rule({ egressType: "ss_link", egressInboundId: null, egressConfigJson: stored }), { ...entry, context: context() });
  assert.deepEqual(view.egressRuntime, { server: "198.51.100.50", port: 443, method: "chacha20-ietf-poly1305", password: "ext", udp: false });
  const broken: any = ruleEgressRuntimeView(rule({ egressType: "ss_link", egressConfigJson: "enc:v1:AAAA" }), { ...entry, context: context() });
  assert.equal(broken.egressRuntimeBlocked, "config_invalid");
});

test("没有出口的规则原样返回（同一个对象）", () => {
  const plain = { id: 1, hostId: 10, forwardType: "realm", egressType: "none" };
  assert.equal(ruleEgressRuntimeView(plain, { ...entry, context: context() }), plain);
  const legacy = { id: 2, hostId: 10, forwardType: "gost" };
  assert.equal(ruleEgressRuntimeView(legacy, { ...entry, context: context() }), legacy);
});

test("gost 出口链：TCP 是 ss 连接器 + tcp 拨号器 + nodelay；UDP 是 ssu + udp；IPv6 地址加方括号", () => {
  const runtime = { server: "203.0.113.20", port: 28388, method: "AES-256-GCM", password: "pw", udp: true };
  assert.deepEqual(buildGostEgressChain(7, "tcp", runtime), {
    name: "chain-egress-7-tcp",
    hops: [{
      name: "hop-egress-7-tcp",
      nodes: [{
        name: "egress-7-tcp",
        addr: "203.0.113.20:28388",
        connector: { type: "ss", auth: { username: "aes-256-gcm", password: "pw" }, metadata: { nodelay: true } },
        dialer: { type: "tcp" },
      }],
    }],
  });
  const udp = buildGostEgressChain(7, "udp", runtime);
  assert.equal(udp.name, gostEgressChainName(7, "udp"));
  assert.deepEqual(udp.hops[0].nodes[0].connector, { type: "ssu", auth: { username: "aes-256-gcm", password: "pw" } });
  assert.deepEqual(udp.hops[0].nodes[0].dialer, { type: "udp" });
  // SS2022 的方法和 key 原样带过去（面板现在不放行，链的生成本身不挑）。
  const ss2022 = buildGostEgressChain(8, "tcp", { ...runtime, method: "2022-blake3-aes-128-gcm", password: Buffer.alloc(16, 2).toString("base64") });
  assert.equal(ss2022.hops[0].nodes[0].connector.auth.username, "2022-blake3-aes-128-gcm");
  assert.equal(buildGostEgressChain(9, "tcp", { ...runtime, server: "2001:db8::20" }).hops[0].nodes[0].addr, "[2001:db8::20]:28388");
});
