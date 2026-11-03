import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  心跳处理函数里拆出去的几段（agentHeartbeatNginxPlan / GostPlan / RuleRemoval / WireGuardPlan /
  ForwardXHop / LocalMatch），在处理函数之外直接调一遍：给一个很小的请求上下文和几个桩函数，
  看产出的东西对不对。整条心跳走下来的覆盖在 *Heartbeat*.test.ts 那些集成测试里，这里只盯接缝本身。

  这几段会写面板日志，所以先把日志目录指到临时目录，再按需 import（静态 import 会先于这里执行）。
*/
process.env.FORWARDX_LOG_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "fwx-heartbeat-seams-"));

const { normalizeForwardProtocolSettings } = await import("../shared/forwardTypes");
// nginx 默认是关的，这里打开，其余用默认。
const settings = normalizeForwardProtocolSettings({ nginx: true });

function ctxFor(overrides: Record<string, unknown> = {}) {
  return {
    host: { id: 5, name: "edge-5", agentVersion: "9.9.9" },
    hostTunnels: [],
    agentHostRules: [],
    agentAllRules: [],
    forwardProtocolSettings: settings,
    tunnelById: new Map(),
    tunnelHopsByTunnelId: new Map(),
    tunnelExitNodesByTunnelId: new Map(),
    tunnelExitEndpointById: new Map(),
    ...overrides,
  } as any;
}

const unused = (name: string) => () => { throw new Error(`${name} 不该被调用`); };

test("nginx 同步计划：本机一条 nginx 规则拼出 upstream / server，并写进受管配置", async () => {
  const { createNginxRuntimeSyncPlanBuilder } = await import("./agentHeartbeatNginxPlan");
  const { NGINX_CONFIG_PATH } = await import("./agentHeartbeatNginx");
  const rule = { id: 7, forwardType: "nginx", isEnabled: true, pendingDelete: false, sourcePort: 20007, targetIp: "10.0.0.9", targetPort: 80, protocol: "tcp" };
  const accessLimitRules: number[] = [];
  const { buildNginxRuntimeSyncPlan } = createNginxRuntimeSyncPlanBuilder(ctxFor({ agentHostRules: [rule] }), {
    anyTunnelDnsRefresh: () => false,
    buildRuleAccessLimitCmds: (r: any) => { accessLimitRules.push(Number(r.id)); return ["# access-limit"]; },
    currentHostTunnelExitPortsForRule: () => [],
    dnsRuntimeRefreshCmd: unused("dnsRuntimeRefreshCmd"),
    exitWeightsForHostIds: async () => null,
    failoverTargetEndpoint: (r: any) => ({ targetIp: r.targetIp, targetPort: Number(r.targetPort) }),
    getExtraExitDialAddress: unused("getExtraExitDialAddress"),
    guardBackendPort: unused("guardBackendPort"),
    isCurrentHostTunnelEntry: () => false,
    nginxTunnelExitRules: [],
    shouldUseRuleGuard: async () => false,
    tunnelExitEndpointsForRule: () => [],
    tunnelExitHostAddress: unused("tunnelExitHostAddress"),
    tunnelExtraExitNodes: () => [],
  });
  const plan = await buildNginxRuntimeSyncPlan() as any;
  const managed = plan.managedConfigs.find((item: any) => item.path === NGINX_CONFIG_PATH);
  assert.ok(managed, "有服务时要把 nginx.conf 作为受管配置下发");
  const config = Buffer.from(managed.contentBase64, "base64").toString("utf8");
  assert.match(config, /upstream fwx_rule_7_tcp \{/);
  assert.match(config, /server 10\.0\.0\.9:80 /);
  assert.match(config, /listen \[::\]:20007 /);
  assert.deepEqual(accessLimitRules, [7]);
  assert.ok(plan.commands.includes("# access-limit"));
  assert.ok(plan.preCommands.length > 0);
});

test("nginx 同步计划：本机没有 nginx 要跑时给退役计划", async () => {
  const { createNginxRuntimeSyncPlanBuilder } = await import("./agentHeartbeatNginxPlan");
  const { buildNginxRuntimeRetirementPlan } = await import("./agentHeartbeatNginx");
  const { buildNginxRuntimeSyncPlan } = createNginxRuntimeSyncPlanBuilder(ctxFor(), {
    anyTunnelDnsRefresh: () => false,
    buildRuleAccessLimitCmds: () => [],
    currentHostTunnelExitPortsForRule: () => [],
    dnsRuntimeRefreshCmd: unused("dnsRuntimeRefreshCmd"),
    exitWeightsForHostIds: async () => null,
    failoverTargetEndpoint: unused("failoverTargetEndpoint") as any,
    getExtraExitDialAddress: unused("getExtraExitDialAddress"),
    guardBackendPort: unused("guardBackendPort"),
    isCurrentHostTunnelEntry: () => false,
    nginxTunnelExitRules: [],
    shouldUseRuleGuard: async () => false,
    tunnelExitEndpointsForRule: () => [],
    tunnelExitHostAddress: unused("tunnelExitHostAddress"),
    tunnelExtraExitNodes: () => [],
  });
  assert.deepEqual(await buildNginxRuntimeSyncPlan(), buildNginxRuntimeRetirementPlan());
});

test("gost 运行时：直连规则一条 service，重载命令写 gost.json 并同步共享运行时", async () => {
  const { createGostRuntimePlan } = await import("./agentHeartbeatGostPlan");
  const { RUNTIME_CONFIG_PATH } = await import("./agentHeartbeatRuntime");
  const rule = { id: 3, forwardType: "gost", isEnabled: true, sourcePort: 20003, targetIp: "1.2.3.4", targetPort: 443, protocol: "tcp" };
  const plan = await createGostRuntimePlan(ctxFor({ agentHostRules: [rule] }), {
    VERBOSE_AGENT_ACTIONS: false,
    anyTunnelDnsRefresh: () => false,
    applyGostLimiter: (service: any) => service,
    buildLoadBalancedExitNodes: unused("buildLoadBalancedExitNodes") as any,
    buildProxyRuleDebugCmd: unused("buildProxyRuleDebugCmd"),
    currentHostTunnelExitPortsForRule: () => [],
    dnsRuntimeRefreshCmd: unused("dnsRuntimeRefreshCmd"),
    failoverTargetAddr: (r: any) => `${r.targetIp}:${r.targetPort}`,
    getHopDialAddress: unused("getHopDialAddress") as any,
    gostRateLimiters: [],
    gostRelayFailoverHopMetadata: { strategy: "fifo", maxFails: 1, failTimeout: "10s" },
    gostRules: [rule],
    gostRuntimeApiSection: () => ({}),
    gostRuntimeExecStart: (service: string, configPath: string) => `run ${service} ${configPath}`,
    gostRuntimeSyncCmd: (service: string, configPath: string) => `sync ${service} ${configPath}`,
    gostServiceName: "forwardx-runtime",
    gostServiceUnit: "[Unit]",
    gostTunnelExitTargetAddr: unused("gostTunnelExitTargetAddr") as any,
    guardBackendPort: unused("guardBackendPort"),
    isCurrentHostTunnelEntry: () => false,
    isForwardXTunnel: () => false,
    maybeProxyProtocolMetadata: () => undefined,
    proxyProtocolEnabled: () => false,
    proxyProtocolVersion: () => 1,
    routeHeaderStripRuleIds: new Set<number>(),
    shouldUseRuleGuard: async () => false,
    tunnelEgressHelpers: new Map(),
    tunnelExitEndpointsForRule: () => [],
    tunnelExitRules: [],
    tunnelForwardProtos: () => ["tcp"],
    tunnelProxyProtocolPlan: unused("tunnelProxyProtocolPlan") as any,
  });
  assert.equal(plan.gostServiceConfig.length, 1);
  const service = plan.gostServiceConfig[0] as any;
  assert.equal(service.name, "fwx-3-tcp");
  assert.equal(service.addr, ":20003");
  assert.equal(service.forwarder.nodes[0].addr, "1.2.3.4:443");
  assert.deepEqual(plan.gostTunnelProbePlans, []);
  assert.equal(plan.gostManagedConfigs.length, 0, "配置要等真正拼重载命令时才放进受管配置");
  const cmds = plan.buildGostReloadCmds();
  assert.equal(cmds[cmds.length - 1], `sync forwardx-runtime ${RUNTIME_CONFIG_PATH}`);
  assert.equal(plan.gostManagedConfigs.length, 1);
  const written = JSON.parse(Buffer.from(plan.gostManagedConfigs[0].contentBase64, "base64").toString("utf8"));
  assert.deepEqual(written.services.map((item: any) => item.name), ["fwx-3-tcp"]);
  assert.ok(Array.isArray(await plan.buildTunnelReloadCmds()));
});

test("停用规则的 remove：iptables 规则带上计数链和连接数限制的清理", async () => {
  const { createDisabledRuleRemovalBuilder } = await import("./agentHeartbeatRuleRemoval");
  const { buildDisabledRuleRemovalAction } = createDisabledRuleRemovalBuilder(ctxFor(), {
    accessScopeForRule: () => "u1_h5",
    buildNginxPortCleanupCmds: unused("buildNginxPortCleanupCmds"),
    forwardXEntryRoute: unused("forwardXEntryRoute") as any,
    isForwardXTunnel: () => false,
  });
  const action = await buildDisabledRuleRemovalAction({
    id: 11, forwardType: "iptables", sourcePort: 20011, targetIp: "10.0.0.11", targetPort: 22, protocol: "tcp",
  }) as any;
  assert.equal(action.op, "remove");
  assert.equal(action.ruleId, 11);
  assert.equal(action.forwardType, "iptables");
  assert.equal(action.sourcePort, 20011);
  assert.ok(action.commands.some((cmd: string) => cmd.includes("FWX_LIMIT_u1_h5")), "要拆掉这条规则的连接数限制链");
});

test("WireGuard 计划：单入口单出口的 V2 隧道，两端互为对端，同一请求内只算一次", async () => {
  const { createForwardXWireGuardPlanner } = await import("./agentHeartbeatWireGuardPlan");
  let exitLookups = 0;
  const planner = createForwardXWireGuardPlanner(ctxFor(), {
    getExtraExitDialAddress: unused("getExtraExitDialAddress"),
    getHopDialAddress: unused("getHopDialAddress"),
    tunnelDnsGeneration: () => 0,
    tunnelEntryHostIds: () => [5],
    tunnelExitHostAddress: async () => { exitLookups += 1; return "203.0.113.6"; },
    tunnelNeedsMimic: () => false,
  });
  const tunnel = { id: 21, mode: "forwardx", forwardxVersion: "v2", secret: "seam-test-secret", entryHostId: 5, exitHostId: 6, mimicPort: 51820 };
  const plans = await planner.getForwardXWireGuardPlans(tunnel);
  assert.deepEqual(Array.from(plans.keys()).sort(), [5, 6]);
  const entryPeer = plans.get(5)!.peers.find((peer) => peer.hostId === 6);
  assert.equal(entryPeer?.endpointHost, "203.0.113.6");
  assert.equal(entryPeer?.endpointPort, 51820);
  assert.equal(await planner.getForwardXWireGuardPlans(tunnel), plans);
  assert.equal(exitLookups, 1);
  assert.equal(await planner.getCurrentHostForwardXWireGuardPlan(tunnel), plans.get(5));
  assert.equal(await planner.getCurrentHostForwardXWireGuardPlan({ ...tunnel, forwardxVersion: "v1" }), null);
});

test("FXP 中转规格：relay 指向下一跳，带 mimic 过滤，最后交给 applyForwardXTransport", async () => {
  const { createForwardXHopSpecBuilder } = await import("./agentHeartbeatForwardXHop");
  const filters: string[] = [];
  const { buildForwardXHopSpec } = createForwardXHopSpecBuilder({
    addMimicFilter: (filter: string) => { filters.push(filter); },
    applyForwardXTransport: async (spec: any) => ({ ...spec, transportApplied: true }),
    exitCapacitiesForHostIds: async () => null,
    exitWeightsForHostIds: async () => null,
    forwardXExtraExitRoutes: async () => [],
    getHopDialAddress: async (hop: any) => `198.51.100.${hop.hostId}`,
    hostInterface: "eth0",
    tunnelDnsGeneration: () => 4,
    tunnelNeedsMimic: () => true,
  });
  const tunnel = { id: 31, mode: "forwardx", forwardxVersion: "v1", secret: "seam-test-secret" };
  const hops = [
    { hostId: 1, seq: 0, listenPort: 30001, mimicPort: 40001 },
    { hostId: 2, seq: 1, listenPort: 30002, mimicPort: 40002 },
    { hostId: 3, seq: 2, listenPort: 30003, mimicPort: 40003 },
  ];
  const spec = await buildForwardXHopSpec(tunnel, hops, 1, "apply") as any;
  assert.equal(spec.role, "relay");
  assert.equal(spec.listenPort, 30002);
  assert.equal(spec.udpListenPort, 40002);
  assert.equal(spec.relayExitHost, "198.51.100.3");
  assert.equal(spec.relayExitPort, 30003);
  assert.equal(spec.udpRelayExitPort, 40003);
  assert.equal(spec.dnsGeneration, 4);
  assert.equal(spec.transportApplied, true);
  assert.deepEqual(filters, ["remote=198.51.100.3:40003"]);
  const exitSpec = await buildForwardXHopSpec(tunnel, hops, 2, "apply") as any;
  assert.equal(exitSpec.role, "exit");
  assert.equal(exitSpec.relayExitHost, undefined);
});

test("本地运行态比对：认得已在跑的规则，保护端口，多出来的本地规则给 remove", async () => {
  const { createLocalRuntimeMatchers } = await import("./agentHeartbeatLocalMatch");
  const local = { port: 20041, ruleId: 41, forwardType: "realm", targetIp: "10.0.0.41", targetPort: 8080, protocol: "tcp", ready: true };
  const protectedKeys = new Set<string>();
  const matchers = createLocalRuntimeMatchers(ctxFor(), {
    buildNginxPortCleanupCmds: unused("buildNginxPortCleanupCmds"),
    hasReportedRuntimeState: true,
    localRulesByPort: new Map([[local.port, local as any]]),
    localTunnelsByPort: new Map(),
    processTarget: (rule: any) => rule._originalTargetIp || rule.targetIp,
    protectedRuleRemoveActionKeys: protectedKeys,
    reportedLocalRules: [local as any],
  });
  const rule = { id: 41, sourcePort: 20041, targetIp: "10.0.0.41", targetPort: 8080, protocol: "tcp" };
  assert.equal(matchers.localRuleMatches(rule, "realm", 20041), true);
  assert.equal(matchers.localRuleMatches({ ...rule, targetPort: 9090 }, "realm", 20041), false, "目标端口变了就不算在跑");
  assert.equal(matchers.localRuleMatches({ ...rule, id: 42 }, "realm", 20041), false);
  matchers.protectActiveRulePort(rule);
  assert.ok(protectedKeys.size > 0);
  const removal = matchers.buildGenericLocalRuleRemovalAction(local as any) as any;
  assert.equal(removal.op, "remove");
  assert.equal(removal.ruleId, 41);
  assert.equal(removal.sourcePort, 20041);
  assert.equal(removal.forwardType, "realm");
  assert.equal(removal.fxp, undefined);
  assert.equal(matchers.localTunnelMatches(99, "gost-tunnel", 20099), false, "本地没有这条隧道");
});
