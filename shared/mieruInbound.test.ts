import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMitaHostPlan,
  isMieruAgentSupported,
  MIERU_AGENT_VERSION,
  mieruAgentUpgradeMessage,
  mieruInboundPorts,
  mieruPortBindings,
} from "./mieruInbound";
import {
  buildSingboxConfig,
  createEmptyProxyInbound,
  proxyInboundSecurities,
  proxyInboundSupportsMultiUser,
  proxyInboundUserCredentialKinds,
  proxyNodesFromInbound,
  validateProxyInbound,
  type ProxyInbound,
} from "./proxyInbound";
import { formatProxyNodeLink, parseProxyNodeLink, proxyNodeOnlyUdp, relayProxyNode } from "./proxyNode";

function mieruInbound(patch: Partial<ProxyInbound> = {}): ProxyInbound {
  return {
    ...createEmptyProxyInbound(),
    protocol: "mieru",
    name: "HK Mieru",
    port: 27001,
    transport: "tcp",
    security: "none",
    mieruTransport: "TCP",
    users: [
      { id: 11, name: "小王", uuid: "nexaaaa0001", password: "pw-a" },
      { id: 12, name: "小李", uuid: "nexbbbb0002", password: "pw-b" },
    ],
    ...patch,
  };
}

test("Mieru：多用户、凭据是用户名 + 密码、没有 TLS 层", () => {
  assert.equal(proxyInboundSupportsMultiUser("mieru"), true);
  assert.deepEqual(proxyInboundUserCredentialKinds("mieru"), ["uuid", "password"]);
  assert.deepEqual(proxyInboundSecurities("mieru"), ["none"]);
  assert.equal(validateProxyInbound(mieruInbound()), "");
});

test("Mieru 入站校验：承载、端口段、用户名字符集", () => {
  assert.match(validateProxyInbound(mieruInbound({ mieruTransport: "QUIC" })), /不支持的 Mieru 承载/);
  assert.match(validateProxyInbound(mieruInbound({ portRangeEnd: 27000 })), /终点要比起点大/);
  assert.match(validateProxyInbound(mieruInbound({ portRangeEnd: 27200 })), /最多 100 个端口/);
  assert.equal(validateProxyInbound(mieruInbound({ portRangeEnd: 27010, mieruTransport: "BOTH" })), "");
  assert.match(
    validateProxyInbound(mieruInbound({ users: [{ id: 1, name: "坏", uuid: "has space", password: "x" }] })),
    /Mieru 用户名只能是/,
  );
  assert.match(validateProxyInbound(mieruInbound({ users: [] })), /至少要有一个用户/);
  assert.match(validateProxyInbound(mieruInbound({ users: [{ id: 1, name: "a", uuid: "nexa", password: "" }] })), /缺少密码/);
  assert.match(validateProxyInbound(mieruInbound({ security: "tls" })), /安全层只能选「无」/);
  // 端口段只有 Mieru 支持
  assert.match(
    validateProxyInbound({ ...createEmptyProxyInbound(), protocol: "socks5", security: "none", port: 1080, portRangeEnd: 1090, users: [{ id: 0, name: "a", uuid: "u", password: "p" }] }),
    /端口段只有 Mieru 支持/,
  );
});

test("端口段展开：冲突检查按段里每个端口算", () => {
  assert.deepEqual(mieruInboundPorts(27001, 0), [27001]);
  assert.deepEqual(mieruInboundPorts(27001, 27003), [27001, 27002, 27003]);
  assert.deepEqual(mieruInboundPorts(27001, 26000), [27001]);
  assert.deepEqual(mieruPortBindings(mieruInbound({ portRangeEnd: 27003, mieruTransport: "BOTH" })), [
    { portRange: "27001-27003", protocol: "TCP" },
    { portRange: "27001-27003", protocol: "UDP" },
  ]);
});

test("一台机器上的 Mieru 合成一份 mita 配置：只放面板给的端口和用户", () => {
  const plan = buildMitaHostPlan([
    { id: 7, inbound: mieruInbound({ port: 28000, mieruTransport: "UDP", users: [{ id: 21, name: "c", uuid: "nexcccc", password: "pw-c" }] }) },
    { id: 3, inbound: mieruInbound() },
    { id: 9, inbound: { ...createEmptyProxyInbound(), protocol: "vless", port: 443 } },
  ]);
  assert.ok(plan.config);
  assert.deepEqual(plan.config!.portBindings, [
    { port: 27001, protocol: "TCP" },
    { port: 28000, protocol: "UDP" },
  ]);
  assert.deepEqual(plan.config!.users.map((user) => user.name), ["nexaaaa0001", "nexbbbb0002", "nexcccc"]);
  assert.equal(plan.config!.loggingLevel, "INFO");
  assert.equal(plan.config!.mtu, 1400);
  assert.deepEqual(plan.inboundIds, [3, 7]);
  assert.deepEqual(plan.users.find((user) => user.name === "nexcccc"), { name: "nexcccc", inboundId: 7, inboundUserId: 21 });
  // 同样的输入逐字节一样：Agent 只在配置变了时才重启 mita
  assert.equal(JSON.stringify(plan), JSON.stringify(buildMitaHostPlan([
    { id: 3, inbound: mieruInbound() },
    { id: 7, inbound: mieruInbound({ port: 28000, mieruTransport: "UDP", users: [{ id: 21, name: "c", uuid: "nexcccc", password: "pw-c" }] }) },
  ])));
});

test("会让 mita 整个起不来的入站 / 用户单独跳过，不拖累别人", () => {
  const plan = buildMitaHostPlan([
    { id: 1, inbound: mieruInbound({ portRangeEnd: 27005 }) },
    // 端口落在 1 号那一段里（同为 TCP）：整个跳过
    { id: 2, inbound: mieruInbound({ port: 27003, users: [{ id: 31, name: "x", uuid: "nexdddd", password: "p" }] }) },
    // 同一端口只开 UDP：不冲突
    { id: 3, inbound: mieruInbound({ port: 27003, mieruTransport: "UDP", users: [{ id: 32, name: "y", uuid: "nexeeee", password: "p" }] }) },
    // 用户名和 1 号重了：只跳过那一个用户
    { id: 4, inbound: mieruInbound({ port: 29000, users: [{ id: 41, name: "dup", uuid: "nexaaaa0001", password: "z" }, { id: 42, name: "ok", uuid: "nexffff", password: "z" }] }) },
    // 一个能用的用户都没有：不开端口
    { id: 5, inbound: mieruInbound({ port: 29500, users: [{ id: 51, name: "dup2", uuid: "nexbbbb0002", password: "z" }] }) },
  ]);
  assert.deepEqual(plan.inboundIds, [1, 3, 4]);
  assert.ok(plan.skipped.some((item) => item.inboundId === 2 && /已被这台机器上别的 Mieru 入站占用/.test(item.reason)));
  assert.ok(plan.skipped.some((item) => item.inboundId === 4 && item.inboundUserId === 41));
  assert.ok(plan.skipped.some((item) => item.inboundId === 5 && !item.inboundUserId));
  assert.deepEqual(plan.config!.users.map((user) => user.name), ["nexaaaa0001", "nexbbbb0002", "nexeeee", "nexffff"]);
  assert.equal(buildMitaHostPlan([]).config, null);
});

test("Agent 版本门槛：低于 2.2.255 不下发，提示需要升级 Agent", () => {
  assert.equal(MIERU_AGENT_VERSION, "2.2.255");
  assert.equal(isMieruAgentSupported("2.2.252"), false);
  assert.equal(isMieruAgentSupported(""), false);
  assert.equal(isMieruAgentSupported("2.2.255"), true);
  assert.equal(isMieruAgentSupported("2.3.0"), true);
  assert.match(mieruAgentUpgradeMessage("2.2.251"), /需要升级 Agent.*2\.2\.255.*2\.2\.251/);
});

test("派生节点：用户名在 username 上，承载和端口段带过去；sing-box 配置里没有 Mieru", () => {
  const inbound = mieruInbound({ portRangeEnd: 27009, mieruTransport: "BOTH" });
  const nodes = proxyNodesFromInbound(inbound, { address: "203.0.113.9" });
  assert.equal(nodes.length, 2);
  const node = nodes[0].node;
  assert.equal(node.protocol, "mieru");
  assert.equal(node.username, "nexaaaa0001");
  assert.equal(node.uuid, "");
  assert.equal(node.password, "pw-a");
  assert.equal(node.portRangeEnd, 27009);
  assert.equal(node.mieruTransport, "BOTH");
  assert.equal(node.tls, false);
  assert.equal(node.name, "HK Mieru · 小王");

  const config = JSON.parse(buildSingboxConfig([
    { inbound, tag: "inbound-3" },
    { inbound: { ...createEmptyProxyInbound(), protocol: "socks5", security: "none", port: 1080, users: [{ id: 1, name: "a", uuid: "u", password: "p" }] }, tag: "inbound-4" },
  ]));
  assert.deepEqual(config.inbounds.map((item: any) => item.tag), ["inbound-4"]);
});

test("mierus:// 简单分享链接：生成与解析", () => {
  const node = proxyNodesFromInbound(mieruInbound({ portRangeEnd: 27009, mieruTransport: "BOTH" }), { address: "203.0.113.9" })[0].node;
  const link = formatProxyNodeLink(node);
  assert.equal(
    link,
    "mierus://nexaaaa0001:pw-a@203.0.113.9?profile=HK+Mieru+%C2%B7+%E5%B0%8F%E7%8E%8B&port=27001-27009&protocol=TCP&port=27001-27009&protocol=UDP",
  );
  const parsed = parseProxyNodeLink(link);
  assert.equal(parsed.ok, true);
  const back = (parsed as any).node;
  assert.equal(back.protocol, "mieru");
  assert.equal(back.username, "nexaaaa0001");
  assert.equal(back.password, "pw-a");
  assert.equal(back.port, 27001);
  assert.equal(back.portRangeEnd, 27009);
  assert.equal(back.mieruTransport, "BOTH");
  assert.equal(back.name, "HK Mieru · 小王");

  const udp = parseProxyNodeLink("mierus://u1:p%40ss@[2001:db8::2]?profile=x&port=6666&protocol=UDP&mtu=1400");
  assert.equal(udp.ok, true);
  assert.equal((udp as any).node.address, "2001:db8::2");
  assert.equal((udp as any).node.password, "p@ss");
  assert.equal((udp as any).node.mieruTransport, "UDP");
  assert.equal(proxyNodeOnlyUdp((udp as any).node), true);
  assert.equal(parseProxyNodeLink("mierus://u1:p@host?profile=x").ok, false);
});

test("经中转：端口段清掉，只连中转的那一个端口", () => {
  const node = proxyNodesFromInbound(mieruInbound({ portRangeEnd: 27009 }), { address: "203.0.113.9" })[0].node;
  const relayed = relayProxyNode(node, { address: "198.51.100.1", port: 40001, name: "经中转" });
  assert.equal(relayed.port, 40001);
  assert.equal(relayed.portRangeEnd, 0);
  assert.equal(node.portRangeEnd, 27009);
});
