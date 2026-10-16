import assert from "node:assert/strict";
import test from "node:test";

import {
  isSsEgressAgentSupported,
  maskSsEgressEndpoint,
  normalizeSsMethod,
  parseSsEgressLink,
  ruleEgressColumnsOf,
  ruleEgressShapeError,
  ruleEgressStateBlocksDelivery,
  ruleEgressSummaryText,
  ssEgressEndpointError,
  ssEgressMethodError,
  SS_EGRESS_AGENT_VERSION,
  SS_EGRESS_METHODS,
  SS_EGRESS_UDP_SUPPORTED,
} from "./ssEgress";
import { AGENT_VERSION } from "./versions";

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

test("出口方法：只放行和 sing-box 实测互通的经典 AEAD，别名规整", () => {
  assert.deepEqual([...SS_EGRESS_METHODS].sort(), ["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305"]);
  for (const method of SS_EGRESS_METHODS) assert.equal(ssEgressMethodError(method), null);
  assert.equal(normalizeSsMethod("AEAD_AES_256_GCM"), "aes-256-gcm");
  assert.equal(normalizeSsMethod("AEAD_CHACHA20_POLY1305"), "chacha20-ietf-poly1305");
  assert.equal(ssEgressMethodError("AES-128-GCM"), null);
  // SS2022：gost 运行时能跑，但和 sing-box 不互通 —— 要说清楚为什么不行、该换什么。
  assert.match(String(ssEgressMethodError("2022-blake3-aes-128-gcm")), /SS2022.*不互通.*aes-256-gcm/);
  assert.match(String(ssEgressMethodError("2022-blake3-chacha20-poly1305")), /SS2022/);
  assert.match(String(ssEgressMethodError("rc4-md5")), /不安全/);
  assert.match(String(ssEgressMethodError("aes-256-cfb")), /不安全/);
  assert.match(String(ssEgressMethodError("xchacha20-ietf-poly1305")), /不支持的加密方式/);
  assert.match(String(ssEgressMethodError("")), /缺少/);
});

test("ss:// 链接：SIP002 和老的整段 base64 都认，结果相同", () => {
  const sip002 = parseSsEgressLink(`ss://${b64url("aes-256-gcm:p@ss:w0rd")}@203.0.113.9:8388#%E8%90%BD%E5%9C%B0`);
  assert.equal(sip002.ok, true);
  if (!sip002.ok) return;
  assert.deepEqual(sip002.endpoint, { server: "203.0.113.9", port: 8388, method: "aes-256-gcm", password: "p@ss:w0rd", name: "落地" });
  const legacy = parseSsEgressLink(`ss://${b64("chacha20-ietf-poly1305:secret@landing.example.com:443")}#x`);
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.deepEqual({ ...legacy.endpoint, name: undefined }, { server: "landing.example.com", port: 443, method: "chacha20-ietf-poly1305", password: "secret", name: undefined });
  // IPv6 落地。
  const v6 = parseSsEgressLink(`ss://${b64url("aes-128-gcm:k")}@[2001:db8::9]:8388`);
  assert.equal(v6.ok && v6.endpoint.server, "2001:db8::9");
  // 别名方法在链接里也规整。
  const alias = parseSsEgressLink(`ss://${b64url("AEAD_AES_128_GCM:k")}@203.0.113.9:1`);
  assert.equal(alias.ok && alias.endpoint.method, "aes-128-gcm");
});

test("ss:// 链接：不收的那些都给出能看懂的原因", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /请粘贴/],
    ["vmess://abc", /只支持 ss:\/\//],
    [`ss://${b64url("aes-256-gcm:k")}@203.0.113.9:8388/?plugin=obfs-local%3Bobfs%3Dhttp`, /插件/],
    [`ss://${b64url("2022-blake3-aes-128-gcm:" + Buffer.alloc(16, 1).toString("base64"))}@203.0.113.9:8388`, /SS2022/],
    [`ss://${b64url("rc4-md5:k")}@203.0.113.9:8388`, /不安全/],
    [`ss://${b64url("aes-256-gcm:k")}@127.0.0.1:8388`, /本机/],
    [`ss://${b64url("aes-256-gcm:k")}@localhost:8388`, /本机/],
    ["ss://garbage", /无法识别|格式/],
  ];
  for (const [link, pattern] of cases) {
    const result = parseSsEgressLink(link);
    assert.equal(result.ok, false, link);
    if (!result.ok) assert.match(result.error, pattern, link);
  }
});

test("打码：密码永远不出现在界面上", () => {
  const masked = maskSsEgressEndpoint({ server: "2001:db8::9", port: 8388, method: "AES-256-GCM" });
  assert.equal(masked, "ss://aes-256-gcm:******@[2001:db8::9]:8388");
  const parsed = parseSsEgressLink(`ss://${b64url("aes-256-gcm:topsecret")}@203.0.113.9:8388`);
  assert.ok(parsed.ok);
  if (parsed.ok) assert.equal(maskSsEgressEndpoint(parsed.endpoint).includes("topsecret"), false);
});

test("出口配置本身的校验", () => {
  const good = { server: "203.0.113.9", port: 8388, method: "aes-256-gcm", password: "k" };
  assert.equal(ssEgressEndpointError(good), null);
  assert.match(String(ssEgressEndpointError({ ...good, port: 0 })), /端口/);
  assert.match(String(ssEgressEndpointError({ ...good, password: "" })), /密码/);
  assert.match(String(ssEgressEndpointError({ ...good, password: "a\nb" })), /换行/);
  assert.match(String(ssEgressEndpointError({ ...good, server: "bad host!" })), /地址无效/);
  assert.match(String(ssEgressEndpointError({ ...good, server: "::1" })), /本机/);
});

test("规则形态：出口只挂在 gost 的直连 / 端口转发规则上", () => {
  const base = { egressType: "ss_host", forwardType: "gost", protocol: "tcp" };
  assert.equal(ruleEgressShapeError(base), null);
  assert.equal(ruleEgressShapeError({ ...base, forwardGroupMode: "port" }), null);
  assert.equal(ruleEgressShapeError({ ...base, egressType: "none", forwardType: "realm" }), null);
  assert.match(String(ruleEgressShapeError({ ...base, forwardType: "realm" })), /必须用 gost/);
  assert.match(String(ruleEgressShapeError({ ...base, forwardType: "iptables" })), /必须用 gost/);
  assert.match(String(ruleEgressShapeError({ ...base, tunnelId: 3 })), /隧道/);
  assert.match(String(ruleEgressShapeError({ ...base, forwardGroupMode: "chain" })), /转发链/);
  assert.match(String(ruleEgressShapeError({ ...base, forwardGroupMode: "failover" })), /转发组/);
  assert.match(String(ruleEgressShapeError({ ...base, failoverEnabled: 1 })), /线路组/);
  assert.match(String(ruleEgressShapeError({ ...base, tlsInboundId: 7 })), /共享 TLS 入站/);
});

test("UDP 一致性：当前运行时 UDP 不互通，协议必须是 TCP、也不能勾 UDP", () => {
  assert.equal(SS_EGRESS_UDP_SUPPORTED, false);
  const base = { egressType: "ss_link", forwardType: "gost" };
  assert.equal(ruleEgressShapeError({ ...base, protocol: "tcp" }), null);
  assert.match(String(ruleEgressShapeError({ ...base, protocol: "both" })), /UDP.*不互通/);
  assert.match(String(ruleEgressShapeError({ ...base, protocol: "udp" })), /UDP.*不互通/);
  assert.match(String(ruleEgressShapeError({ ...base, protocol: "tcp", egressUdp: true })), /UDP.*不互通/);
});

test("Agent 版本门槛：2.2.226 起；面板这一版带的 Agent 够", () => {
  assert.equal(SS_EGRESS_AGENT_VERSION, "2.2.226");
  assert.equal(isSsEgressAgentSupported("2.2.226"), true);
  assert.equal(isSsEgressAgentSupported("2.3.0"), true);
  assert.equal(isSsEgressAgentSupported("2.2.225"), false);
  assert.equal(isSsEgressAgentSupported("2.2.224"), false);
  assert.equal(isSsEgressAgentSupported(""), false);
  assert.equal(isSsEgressAgentSupported(AGENT_VERSION), true);
});

test("出口那几列的规整（转发组子规则照抄模板用）", () => {
  assert.deepEqual(ruleEgressColumnsOf({}), { egressType: "none", egressInboundId: null, egressConfigJson: null, egressUdp: false });
  assert.deepEqual(ruleEgressColumnsOf({ egressType: "ss_host", egressInboundId: "5", egressConfigJson: "x", egressUdp: 1 }), { egressType: "ss_host", egressInboundId: 5, egressConfigJson: null, egressUdp: true });
  assert.deepEqual(ruleEgressColumnsOf({ egressType: "ss_link", egressInboundId: 5, egressConfigJson: "enc:v1:x" }), { egressType: "ss_link", egressInboundId: null, egressConfigJson: "enc:v1:x", egressUdp: false });
  assert.deepEqual(ruleEgressColumnsOf({ egressType: "weird" }).egressType, "none");
});

test("状态：哪些按停用下发、卡片上那一句", () => {
  assert.equal(ruleEgressStateBlocksDelivery("running"), false);
  assert.equal(ruleEgressStateBlocksDelivery("landing_offline"), false);
  assert.equal(ruleEgressStateBlocksDelivery("agent_upgrade"), true);
  assert.equal(ruleEgressStateBlocksDelivery("inbound_missing"), true);
  assert.equal(ruleEgressStateBlocksDelivery("config_invalid"), true);
  assert.equal(ruleEgressSummaryText({ type: "ss_host", landingHostName: "东京" }), "经 落地主机 东京 出口");
  assert.equal(ruleEgressSummaryText({ type: "ss_link" }), "经 外部 SS 出口");
  assert.equal(ruleEgressSummaryText({ type: "none" }), "");
});
