import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CAPABILITY_SS_EGRESS_2022,
  AGENT_CAPABILITY_SS_EGRESS_UDP,
  hostSsEgressCapabilities,
  isSsEgressAgentSupported,
  parseAgentCapabilities,
  ruleEgressWantsUdp,
  SS_EGRESS_CAPABILITY_AGENT_VERSION,
  SS_EGRESS_RUNTIME_MIN_NEX_BUILD,
  ssEgressHostCapabilityError,
  maskSsEgressEndpoint,
  normalizeSsMethod,
  parseSsEgressLink,
  ruleEgressColumnsOf,
  ruleEgressShapeError,
  ruleEgressSwitchesForwardType,
  ruleEgressStateBlocksDelivery,
  ruleEgressSummaryText,
  canonicalSsEgressPassword,
  ssEgressEndpointError,
  ssEgressMethodError,
  SS_EGRESS_AGENT_VERSION,
  SS_EGRESS_METHODS,
  SS_EGRESS_UDP_SUPPORTED,
} from "./ssEgress";
import { AGENT_VERSION } from "./versions";

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

test("出口方法：经典 AEAD + gost 认得的两种 SS2022（都和 sing-box 实测互通），别名规整", () => {
  assert.deepEqual([...SS_EGRESS_METHODS].sort(), ["2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305"]);
  for (const method of SS_EGRESS_METHODS) assert.equal(ssEgressMethodError(method), null);
  assert.equal(normalizeSsMethod("AEAD_AES_256_GCM"), "aes-256-gcm");
  assert.equal(normalizeSsMethod("AEAD_CHACHA20_POLY1305"), "chacha20-ietf-poly1305");
  assert.equal(ssEgressMethodError("AES-128-GCM"), null);
  // SS2022：方法本身放行（入口机的能力另外查）；gost 不认得的 chacha20 版本说清楚。
  assert.equal(ssEgressMethodError("2022-blake3-aes-128-gcm"), null);
  assert.equal(ssEgressMethodError("2022-blake3-aes-256-gcm"), null);
  assert.match(String(ssEgressMethodError("2022-blake3-chacha20-poly1305")), /gost 运行时不认得/);
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
    [`ss://${b64url("2022-blake3-aes-128-gcm:" + Buffer.alloc(32, 1).toString("base64"))}@203.0.113.9:8388`, /16 字节/],
    [`ss://${b64url("2022-blake3-aes-256-gcm:not-a-key")}@203.0.113.9:8388`, /32 字节/],
    [`ss://${b64url("2022-blake3-aes-128-gcm:" + Buffer.alloc(16, 1).toString("base64") + ":" + Buffer.alloc(16, 2).toString("base64"))}@203.0.113.9:8388`, /多用户/],
    [`ss://${b64url("2022-blake3-chacha20-poly1305:" + Buffer.alloc(32, 1).toString("base64"))}@203.0.113.9:8388`, /不认得/],
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

test("ss:// 链接：SS2022 单用户密钥收下", () => {
  const key = Buffer.alloc(16, 7).toString("base64");
  const parsed = parseSsEgressLink(`ss://${b64url("2022-blake3-aes-128-gcm:" + key)}@203.0.113.9:8388`);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.endpoint.password, key);
  // 不带 = 填充的 base64 也认（有的客户端导出时会去掉）。
  const raw = Buffer.alloc(32, 9).toString("base64").replace(/=+$/, "");
  assert.equal(parseSsEgressLink(`ss://${b64url("2022-blake3-aes-256-gcm:" + raw)}@203.0.113.9:8388`).ok, true);
  // 补齐和长度对不上的（21 个字符 + 一个「=」解不开）不能收下：补成「===」以后 Agent 会拒掉，规则永远起不来。
  const endpoint = { server: "203.0.113.9", port: 8388, method: "2022-blake3-aes-128-gcm" };
  assert.match(String(ssEgressEndpointError({ ...endpoint, password: "AAAAAAAAAAAAAAAAAAAAA=" })), /16 字节/);
  assert.match(String(ssEgressEndpointError({ ...endpoint, password: "AAAAAAAAAAAAAAAAAAAAAAA=" })), /16 字节/);
  assert.match(String(ssEgressEndpointError({ ...endpoint, password: "AAAAAAAAAAAAAAAAAAAAA" })), /16 字节/);
  assert.equal(ssEgressEndpointError({ ...endpoint, password: "AAAAAAAAAAAAAAAAAAAAAA==" }), null);
  assert.equal(ssEgressEndpointError({ ...endpoint, password: "AAAAAAAAAAAAAAAAAAAAAA" }), null);
  // 收下的密钥，补齐以后 Go 的 StdEncoding 一定解得开、而且正好 16 / 32 字节。
  for (const value of [key, key.replace(/=+$/, ""), raw]) {
    const method = value === raw ? "2022-blake3-aes-256-gcm" : "2022-blake3-aes-128-gcm";
    const canonical = canonicalSsEgressPassword(method, value);
    assert.match(canonical, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(canonical.length % 4, 0);
    assert.equal(Buffer.from(canonical, "base64").length, value === raw ? 32 : 16);
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
  // 不会 Shadowsocks 的转发工具也能开出口：下发时这一条换成 gost 跑（ruleEgressSwitchesForwardType）。
  assert.equal(ruleEgressShapeError({ ...base, forwardType: "realm" }), null);
  assert.equal(ruleEgressShapeError({ ...base, forwardType: "iptables" }), null);
  assert.equal(ruleEgressSwitchesForwardType("ss_host", "nftables"), true);
  assert.equal(ruleEgressSwitchesForwardType("ss_link", "gost"), false);
  assert.equal(ruleEgressSwitchesForwardType("none", "nftables"), false);
  assert.match(String(ruleEgressShapeError({ ...base, tunnelId: 3 })), /隧道/);
  assert.match(String(ruleEgressShapeError({ ...base, forwardGroupMode: "chain" })), /转发链/);
  assert.match(String(ruleEgressShapeError({ ...base, forwardGroupMode: "failover" })), /转发组/);
  assert.match(String(ruleEgressShapeError({ ...base, failoverEnabled: 1 })), /线路组/);
  assert.match(String(ruleEgressShapeError({ ...base, tlsInboundId: 7 })), /共享 TLS 入站/);
});

test("UDP 一致性：协议里有 UDP 就必须勾「UDP 也走出口」（UDP 绝不绕过出口直连），只有 TCP 时不能勾", () => {
  assert.equal(SS_EGRESS_UDP_SUPPORTED, true);
  const base = { egressType: "ss_link", forwardType: "gost" };
  assert.equal(ruleEgressShapeError({ ...base, protocol: "tcp" }), null);
  assert.equal(ruleEgressShapeError({ ...base, protocol: "both", egressUdp: true }), null);
  assert.equal(ruleEgressShapeError({ ...base, protocol: "udp", egressUdp: true }), null);
  assert.match(String(ruleEgressShapeError({ ...base, protocol: "both" })), /绕过出口直连/);
  assert.match(String(ruleEgressShapeError({ ...base, protocol: "udp" })), /必须开启/);
  assert.match(String(ruleEgressShapeError({ ...base, protocol: "tcp", egressUdp: true })), /不需要/);
  assert.equal(ruleEgressWantsUdp({ protocol: "both", egressUdp: 1 }), true);
  assert.equal(ruleEgressWantsUdp({ protocol: "udp", egressUdp: true }), true);
  assert.equal(ruleEgressWantsUdp({ protocol: "tcp", egressUdp: true }), false);
  assert.equal(ruleEgressWantsUdp({ protocol: "both", egressUdp: false }), false);
});

test("入口机能力：Agent ≥ 2.2.227 并且上报了 ssEgressUdp / ssEgress2022 才算", () => {
  assert.equal(SS_EGRESS_CAPABILITY_AGENT_VERSION, "2.2.227");
  assert.equal(SS_EGRESS_RUNTIME_MIN_NEX_BUILD, 3);
  const caps = JSON.stringify([AGENT_CAPABILITY_SS_EGRESS_UDP, AGENT_CAPABILITY_SS_EGRESS_2022]);
  assert.deepEqual(hostSsEgressCapabilities({ agentVersion: "2.2.227", agentCapabilities: caps }), { udp: true, ss2022: true });
  assert.deepEqual(hostSsEgressCapabilities({ agentVersion: AGENT_VERSION, agentCapabilities: caps }), { udp: true, ss2022: true });
  // 旧 Agent（含降级回去的）就算库里留着能力也不认。
  assert.deepEqual(hostSsEgressCapabilities({ agentVersion: "2.2.226", agentCapabilities: caps }), { udp: false, ss2022: false });
  // 新 Agent 但运行时没升上去 / 回滚了：能力列表是空的。
  assert.deepEqual(hostSsEgressCapabilities({ agentVersion: "2.2.227", agentCapabilities: "[]" }), { udp: false, ss2022: false });
  assert.deepEqual(hostSsEgressCapabilities({ agentVersion: "2.2.227", agentCapabilities: null }), { udp: false, ss2022: false });
  assert.deepEqual(hostSsEgressCapabilities({ agentVersion: "2.2.227", agentCapabilities: JSON.stringify(["ssEgressUdp"]) }), { udp: true, ss2022: false });
  assert.deepEqual(hostSsEgressCapabilities(null), { udp: false, ss2022: false });
  // 解析：数组、JSON、逗号分隔都认，去重排序，丢掉怪东西。
  assert.deepEqual(parseAgentCapabilities(["ssEgressUdp", "ssEgressUdp", " ssEgress2022 ", "bad value!", 3]), ["3", "ssEgress2022", "ssEgressUdp"]);
  assert.deepEqual(parseAgentCapabilities("ssEgressUdp,ssEgress2022"), ["ssEgress2022", "ssEgressUdp"]);
  assert.deepEqual(parseAgentCapabilities("{not json"), []);

  const host = { name: "香港入口", agentVersion: "2.2.227", runtimeVersion: "3.2.6-nex2", agentCapabilities: "[]" };
  assert.match(String(ssEgressHostCapabilityError(host, { udp: true, method: "aes-256-gcm" })), /香港入口.*UDP.*2\.2\.227.*3\.2\.6-nex3.*当前 Agent 2\.2\.227，运行时 3\.2\.6-nex2/);
  assert.match(String(ssEgressHostCapabilityError(host, { udp: false, method: "2022-blake3-aes-128-gcm" })), /SS2022.*aes-256-gcm/);
  assert.equal(ssEgressHostCapabilityError(host, { udp: false, method: "aes-256-gcm" }), null, "经典 AEAD 只走 TCP 不看能力");
  assert.equal(ssEgressHostCapabilityError({ ...host, agentCapabilities: caps }, { udp: true, method: "2022-blake3-aes-256-gcm" }), null);
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
  // 只有 UDP 确实下发了才写「含 UDP」。
  assert.equal(ruleEgressSummaryText({ type: "ss_host", landingHostName: "东京", udp: true }), "经 落地主机 东京 出口（含 UDP）");
  // 外部 SS 服务器的 UDP 中继面板验证不了，写明要对端支持。
  assert.equal(ruleEgressSummaryText({ type: "ss_link", udp: true }), "经 外部 SS 出口（含 UDP，需对端支持 UDP）");
  assert.equal(ruleEgressSummaryText({ type: "ss_link", udp: false }), "经 外部 SS 出口");
  assert.equal(ruleEgressStateBlocksDelivery("udp_runtime_upgrade"), true);
  assert.equal(ruleEgressStateBlocksDelivery("ss2022_runtime_upgrade"), true);
  assert.equal(ruleEgressSummaryText({ type: "none" }), "");
});
