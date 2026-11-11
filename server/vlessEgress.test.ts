import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGostEgressChain,
  evaluateRuleEgress,
  gostEgressChainName,
  ruleEgressRuntime,
  ruleEgressRuntimeView,
  type EgressRuntimeContext,
} from "./ssEgress";
import {
  buildVlessEgressBridgeConfig,
  buildVlessEgressBridgePlan,
  collectVlessEgressBridges,
  createVlessEgressBridgePortAllocator,
  decryptVlessEgressEndpoint,
  encryptVlessEgressEndpoint,
  pickVlessEgressInboundUuid,
  setVlessEgressCipherSecretForTests,
  vlessEgressBridgeCredentials,
  VLESS_EGRESS_BRIDGE_CONFIG_PATH,
  VLESS_EGRESS_BRIDGE_PORT_MIN,
  VLESS_EGRESS_BRIDGE_SERVICE_NAME,
} from "./vlessEgress";
import { setSsEgressCipherSecretForTests } from "./ssEgress";
import { encryptSsEgressEndpoint } from "./ssEgress";

/**
 * VLESS Reality 出口的下发：运行视图（什么时候按停用下发、旧 Agent 怎么办）、gost 出口链（本机 socks5）、
 * 入口机上 sing-box 桥接的配置和下发计划、桥接端口怎么挑。
 */

setVlessEgressCipherSecretForTests("unit-test-secret");
setSsEgressCipherSecretForTests("unit-test-secret");

const PBK = "TiSmUw53M68pgep1_Cc7AXzh1QpUzeBM74jRZbWHj3Q";
const UUID = "0b9c2f7e-8a36-4a6e-9a51-3c2b1f2d4e5f";
const now = new Date();
const landingHost = { id: 20, name: "东京落地", ip: "203.0.113.20", ipv4: "203.0.113.20", isOnline: true, lastHeartbeat: now, userId: 1 };
const inbound = {
  id: 6, hostId: 20, name: "东京 REALITY", protocol: "vless", transport: "tcp", security: "reality", flow: "xtls-rprx-vision",
  port: 443, serverName: "dl.google.com", realityPublicKey: PBK, realityShortId: "A1B2", isEnabled: true, userId: 1,
};

function context(overrides: { inbound?: any; users?: any[] } = {}): EgressRuntimeContext {
  const row = overrides.inbound === undefined ? inbound : overrides.inbound;
  return {
    inboundById: new Map(row ? [[Number(row.id), row]] : []),
    hostById: new Map([[landingHost.id, landingHost]]),
    usersByInboundId: new Map([[inbound.id, overrides.users ?? [{ uuid: "11111111-2222-4333-8444-555555555555", sharedUserId: 9 }, { uuid: UUID, sharedUserId: 0 }]]]),
  };
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 7, hostId: 10, forwardType: "gost", protocol: "tcp", isEnabled: true, tunnelId: null,
    egressType: "vless_host", egressInboundId: 6, egressUdp: false, targetIp: "198.51.100.7", targetPort: 443,
    ...overrides,
  };
}

const entry = { entryHostId: 10, entryAgentVersion: "2.2.253", entryHostName: "香港入口" };

test("落地入站：取主人自己的 UUID（分享出去的凭据会被收回），带上桥接端口和凭据", () => {
  const ports = createVlessEgressBridgePortAllocator([], [7]);
  const view: any = ruleEgressRuntimeView(rule(), { ...entry, context: context(), vlessBridgePorts: ports });
  assert.equal(view.isEnabled, true);
  const runtime: any = ruleEgressRuntime(view);
  assert.equal(runtime.kind, "vless");
  assert.equal(runtime.server, "203.0.113.20");
  assert.equal(runtime.port, 443);
  assert.equal(runtime.uuid, UUID);
  assert.equal(runtime.serverName, "dl.google.com");
  assert.equal(runtime.publicKey, PBK);
  assert.equal(runtime.shortId, "a1b2");
  assert.equal(runtime.fingerprint, "chrome");
  assert.equal(runtime.udp, false);
  assert.equal(runtime.bridgePort, VLESS_EGRESS_BRIDGE_PORT_MIN + 7);
  assert.deepEqual({ username: runtime.bridgeUsername, password: runtime.bridgePassword }, vlessEgressBridgeCredentials(7, UUID));
  assert.equal(view.protocol, "tcp");
  assert.equal(pickVlessEgressInboundUuid([{ uuid: "a", sharedUserId: 3 }]), "a");
  assert.equal(pickVlessEgressInboundUuid([]), "");
});

test("旧 Agent（低于 2.2.253）：按停用下发，卡片显示「需要升级 Agent」，绝不退回直连", () => {
  const ports = createVlessEgressBridgePortAllocator([], [7]);
  for (const version of ["2.2.252", "2.2.226", ""]) {
    const view: any = ruleEgressRuntimeView(rule(), { ...entry, entryAgentVersion: version, context: context(), vlessBridgePorts: ports });
    assert.equal(view.isEnabled, false, version);
    assert.equal(view.egressRuntimeBlocked, "agent_upgrade", version);
    assert.equal(ruleEgressRuntime(view), null, version);
  }
  const evaluation = evaluateRuleEgress(rule(), { ...entry, entryAgentVersion: "2.2.252", context: context() });
  assert.match(String(evaluation?.message), /香港入口.*2\.2\.253.*VLESS/);
  // 桥接只收能跑的规则：旧 Agent 上一条都没有。
  const blocked = ruleEgressRuntimeView(rule(), { ...entry, entryAgentVersion: "2.2.252", context: context(), vlessBridgePorts: ports });
  assert.deepEqual(collectVlessEgressBridges([blocked], 10), []);
});

test("出口失效的几种情况都按停用下发", () => {
  const ports = createVlessEgressBridgePortAllocator([]);
  const cases: Array<[string, any, Record<string, unknown>, string]> = [
    ["入站被删", { context: context({ inbound: null }) }, {}, "inbound_missing"],
    ["入站改成 ws", { context: context({ inbound: { ...inbound, transport: "ws" } }) }, {}, "inbound_unsupported"],
    ["入站去掉 Vision", { context: context({ inbound: { ...inbound, flow: "" } }) }, {}, "inbound_unsupported"],
    ["入站停用", { context: context({ inbound: { ...inbound, isEnabled: false } }) }, {}, "inbound_disabled"],
    ["入站没有用户", { context: context({ users: [] }) }, {}, "config_invalid"],
    ["落地就是入口", { entryHostId: 20, context: context() }, {}, "self_loop"],
    ["协议改成 TCP+UDP", { context: context() }, { protocol: "both" }, "shape_invalid"],
    ["外部链接解不开", { context: context() }, { egressType: "vless_link", egressConfigJson: "garbage" }, "config_invalid"],
  ];
  for (const [name, options, ruleOverrides, state] of cases) {
    const view: any = ruleEgressRuntimeView(rule(ruleOverrides), { ...entry, vlessBridgePorts: ports, ...options });
    assert.equal(view.isEnabled, false, name);
    assert.equal(view.egressRuntimeBlocked, state, name);
  }
  // 走隧道：入口一侧照常跑隧道，出口机那一侧按形态判成不下发（VLESS 不接隧道）。
  assert.equal(evaluateRuleEgress(rule({ tunnelId: 3 }), { ...entry, tunnelMode: "forwardx", context: context() })?.state, "shape_invalid");
  // 端口一个都分不出来：按停用，不让 gost 链指向 127.0.0.1:0。
  const full = { portFor: () => 0, ports: () => [] };
  const noPort: any = ruleEgressRuntimeView(rule(), { ...entry, context: context(), vlessBridgePorts: full });
  assert.equal(noPort.egressRuntimeBlocked, "config_invalid");
});

test("外部 vless:// 链接：加密往返、换面板密钥解不开；SS 链接的密文不会被当成 VLESS", () => {
  const endpoint = { server: "198.51.100.30", port: 8443, uuid: UUID, serverName: "www.amd.com", publicKey: PBK, shortId: "", fingerprint: "firefox" };
  const stored = encryptVlessEgressEndpoint(endpoint);
  assert.equal(stored.includes(UUID), false);
  assert.deepEqual(decryptVlessEgressEndpoint(stored), endpoint);
  const view: any = ruleEgressRuntimeView(rule({ egressType: "vless_link", egressInboundId: null, egressConfigJson: stored }), {
    ...entry, context: context(), vlessBridgePorts: createVlessEgressBridgePortAllocator([]),
  });
  assert.equal(view.isEnabled, true);
  assert.equal(view.egressRuntime.server, "198.51.100.30");
  assert.equal(view.egressRuntime.fingerprint, "firefox");
  assert.equal(decryptVlessEgressEndpoint(encryptSsEgressEndpoint({ server: "1.2.3.4", port: 1, method: "aes-256-gcm", password: "x" })), null);
  setVlessEgressCipherSecretForTests("another-panel");
  assert.equal(decryptVlessEgressEndpoint(stored), null);
  setVlessEgressCipherSecretForTests("unit-test-secret");
});

test("gost 出口链：一跳本机 socks5（带凭据、关掉 gost 自己的 TLS 方法），只有 TCP；SS 出口的链不变", () => {
  const view: any = ruleEgressRuntimeView(rule(), { ...entry, context: context(), vlessBridgePorts: createVlessEgressBridgePortAllocator([], [7]) });
  const runtime = ruleEgressRuntime(view)!;
  const credentials = vlessEgressBridgeCredentials(7, UUID);
  assert.deepEqual(buildGostEgressChain(7, "tcp", runtime), {
    name: gostEgressChainName(7, "tcp"),
    hops: [{
      name: "hop-egress-7-tcp",
      nodes: [{
        name: "egress-7-tcp",
        addr: `127.0.0.1:${VLESS_EGRESS_BRIDGE_PORT_MIN + 7}`,
        connector: { type: "socks5", auth: credentials, metadata: { notls: true } },
        dialer: { type: "tcp" },
      }],
    }],
  });
  const ss = buildGostEgressChain(8, "tcp", { server: "203.0.113.9", port: 8388, method: "aes-256-gcm", password: "p", udp: false });
  assert.equal((ss.hops[0].nodes[0].connector as any).type, "ss");
});

test("桥接配置：每条规则一对 socks（只听 127.0.0.1、带凭据）→ vless（REALITY + Vision），没有 direct 出站", () => {
  const ports = createVlessEgressBridgePortAllocator([], [7, 9]);
  const rules = [
    ruleEgressRuntimeView(rule(), { ...entry, context: context(), vlessBridgePorts: ports }),
    ruleEgressRuntimeView(rule({ id: 9 }), { ...entry, context: context(), vlessBridgePorts: ports }),
    // 停用的、别的主机的、SS 出口的都不进桥接。
    ruleEgressRuntimeView(rule({ id: 11, isEnabled: false }), { ...entry, context: context(), vlessBridgePorts: ports }),
    { ...ruleEgressRuntimeView(rule({ id: 12 }), { ...entry, context: context(), vlessBridgePorts: ports }), hostId: 99 },
    { id: 13, hostId: 10, isEnabled: true, egressRuntime: { server: "1.2.3.4", port: 1, method: "aes-256-gcm", password: "x", udp: false } },
  ];
  const bridges = collectVlessEgressBridges(rules, 10);
  assert.deepEqual(bridges.map((bridge) => bridge.ruleId), [7, 9]);
  const config = JSON.parse(buildVlessEgressBridgeConfig(bridges));
  assert.deepEqual(config.inbounds[0], {
    type: "socks",
    tag: "bridge-7",
    listen: "127.0.0.1",
    listen_port: VLESS_EGRESS_BRIDGE_PORT_MIN + 7,
    users: [vlessEgressBridgeCredentials(7, UUID)],
  });
  assert.deepEqual(config.outbounds[0], {
    type: "vless",
    tag: "egress-7",
    server: "203.0.113.20",
    server_port: 443,
    uuid: UUID,
    flow: "xtls-rprx-vision",
    tls: {
      enabled: true,
      server_name: "dl.google.com",
      utls: { enabled: true, fingerprint: "chrome" },
      reality: { enabled: true, public_key: PBK, short_id: "a1b2" },
    },
  });
  assert.equal(config.outbounds.some((outbound: any) => outbound.type === "direct"), false);
  assert.deepEqual(config.route.rules, [
    { inbound: ["bridge-7"], outbound: "egress-7" },
    { inbound: ["bridge-9"], outbound: "egress-9" },
  ]);
  // 同样的输入，配置逐字节一样（配置不变就不重启 sing-box）。
  assert.equal(buildVlessEgressBridgeConfig([...bridges].reverse()), buildVlessEgressBridgeConfig(bridges));
});

test("下发计划：单独的 forwardx-singbox-egress 服务，配置只给 root 读，配置没变不重启；没有桥接时收尾", () => {
  const ports = createVlessEgressBridgePortAllocator([], [7]);
  const bridges = collectVlessEgressBridges([ruleEgressRuntimeView(rule(), { ...entry, context: context(), vlessBridgePorts: ports })], 10);
  const plan = buildVlessEgressBridgePlan({ bridges });
  assert.equal(plan.active, true);
  assert.equal(plan.managedConfigs.length, 1);
  assert.equal(plan.managedConfigs[0].path, VLESS_EGRESS_BRIDGE_CONFIG_PATH);
  assert.equal(plan.managedConfigs[0].serviceName, VLESS_EGRESS_BRIDGE_SERVICE_NAME);
  assert.equal(plan.managedConfigs[0].mode, 0o600);
  assert.match(plan.managedConfigs[0].validateCommand, /forwardx-singbox check -c \{\{path\}\}/);
  assert.match(plan.preCommands[0], /sing-box/);
  assert.match(plan.commands.join("\n"), /forwardx-singbox-egress/);
  assert.match(plan.commands.join("\n"), /config unchanged/);
  // 落地入站那个 forwardx-singbox 服务这里不碰。
  assert.equal(/forwardx-singbox\.service/.test(plan.commands.join("\n")), false);
  const retire = buildVlessEgressBridgePlan({ bridges: [] });
  assert.equal(retire.active, false);
  assert.deepEqual(retire.managedConfigs, []);
  assert.match(retire.commands.join("\n"), /egress\.json/);
});

test("桥接端口：按规则号确定性地挑，避开已占用的端口；同一条规则总是同一个", () => {
  const used = [VLESS_EGRESS_BRIDGE_PORT_MIN + 7, VLESS_EGRESS_BRIDGE_PORT_MIN + 8];
  const ports = createVlessEgressBridgePortAllocator(used, [9, 7]);
  // 先按规则号从小到大分：7 的 +7、+8 都被占了，拿到 +9；9 的 +9 已经给了 7，顺延到 +10。
  assert.equal(ports.portFor(7), VLESS_EGRESS_BRIDGE_PORT_MIN + 9);
  assert.equal(ports.portFor(9), VLESS_EGRESS_BRIDGE_PORT_MIN + 10);
  assert.equal(ports.portFor(7), VLESS_EGRESS_BRIDGE_PORT_MIN + 9);
  assert.deepEqual(ports.ports().sort(), [VLESS_EGRESS_BRIDGE_PORT_MIN + 9, VLESS_EGRESS_BRIDGE_PORT_MIN + 10]);
  assert.equal(ports.portFor(0), 0);
  // 规则的凭据只跟规则号和 UUID 有关：换了 UUID 凭据跟着换。
  assert.notDeepEqual(vlessEgressBridgeCredentials(7, UUID), vlessEgressBridgeCredentials(7, "11111111-2222-4333-8444-555555555555"));
  assert.deepEqual(vlessEgressBridgeCredentials(7, UUID), vlessEgressBridgeCredentials(7, UUID));
});
