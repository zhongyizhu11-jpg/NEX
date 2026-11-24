/*
  从 server/agentHeartbeatRoute.ts 第 3055-3230 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { PROXY_INBOUND_TRAFFIC_FORWARD_TYPE, proxyInboundTrafficProtocol, proxyInboundTrafficRuleId } from "../../shared/proxyInboundTraffic";
import { ruleRuntimeIdentityKey, ruleRuntimePortIdentityKey, runtimePortProtocolKey } from "../agentHeartbeatDispatch";
import { shouldUseProtocolGuard } from "../agentHeartbeatProtocolGuard";
import { isGostTunnelMode, runtimeBool } from "../agentHeartbeatRuntime";
import { isRuleProtocolEnabled, isTunnelProtocolEnabled } from "../forwardProtocolSettings";
import { getEnabledProxyInboundsWithUsersByHost } from "../repositories/proxyInboundRepository";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { tunnelRelayUsesParallelRelays } from "@shared/tunnelRelay";

export type CollectHeartbeatRunningRulesContext = {
  tunnelExitRules: Array<any>;
  tunnelById: Map<any, any>;
  tunnelProtocolPolicy: any;
  emptyProtocolPolicy: { blockHttp: boolean; blockSocks: boolean; blockTls: boolean; };
  tunnelProxyProtocolPlan: any /* 原类型 (rule: any) => GostTunnelProxyProtocolPlan… 引用了拿不到的 GostTunnelProxyProtocolPlan，手动收拾 */;
  isForwardXTunnel: any /* 原类型 (tunnel: any) => boolean… 引用了拿不到的 tunnel，手动收拾 */;
  failoverTargetEndpoint: any /* 原类型 (rule: any, proxyDirection?: "send" | "exitSend") => { targetIp: any; targetPort… 引用了拿不到的 proxyDirection，手动收拾 */;
  guardRules: Array<any>;
  guardListenPort: any;
  proxyProtocolVersion: (rule: any) => 2 | 1;
  nginxTunnelExitRules: Array<any>;
  currentHostTunnelExitPortsForRule: any /* 原类型 (rule: any, tunnel: any) => Array<number>… 引用了拿不到的 tunnel，手动收拾 */;
  protectActiveRulePort: any /* 原类型 (rule: any, port?: number) => void… 引用了拿不到的 port，手动收拾 */;
  addRunningRule: (rule: { ruleId: number; tunnelId?: number; sourcePort: number; sourcePortEnd?: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any; forwardGroupHealth?: any; schedulerOnly?: boolean; }) => void;
  failoverForCurrentHost: any /* 类型太长或引用了别的模块，手动收拾 */;
  failoverProxyPort: (rule: any) => number;
  agentAllRules: Array<unknown>;
  forwardProtocolSettings: any;
  forwardXSchedulerFailover: any /* 类型太长或引用了别的模块，手动收拾 */;
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  host: any;
  getHopDialAddress: any /* 原类型 (hop: any, tunnel?: any) => Promise<string>… 引用了拿不到的 tunnel，手动收拾 */;
  runningRules: Array<{ ruleId: number; tunnelId?: number; sourcePort: number; sourcePortEnd?: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any; forwardGroupHealth?: any; schedulerOnly?: boolean; }>;
  expectedRulePorts: Set<string>;
  expectedRuleIdentityKeys: Set<string>;
  expectedRulePortIdentityKeys: Set<string>;
};

export type CollectHeartbeatRunningRulesResult = {
  hostProxyInbounds: Awaited<ReturnType<typeof getEnabledProxyInboundsWithUsersByHost>>;
};

export async function collectHeartbeatRunningRules(ctx: CollectHeartbeatRunningRulesContext): Promise<CollectHeartbeatRunningRulesResult> {
  const { tunnelExitRules, tunnelById, tunnelProtocolPolicy, emptyProtocolPolicy, tunnelProxyProtocolPlan, isForwardXTunnel, failoverTargetEndpoint, guardRules, guardListenPort, proxyProtocolVersion, nginxTunnelExitRules, currentHostTunnelExitPortsForRule, protectActiveRulePort, addRunningRule, failoverForCurrentHost, failoverProxyPort, agentAllRules, forwardProtocolSettings, forwardXSchedulerFailover, tunnelHopsByTunnelId, host, getHopDialAddress, runningRules, expectedRulePorts, expectedRuleIdentityKeys, expectedRulePortIdentityKeys } = ctx;
  for (const rule of tunnelExitRules) {
    const tunnel = tunnelById.get((rule as any).tunnelId) as any;
    const policy = tunnel ? await tunnelProtocolPolicy(tunnel) : emptyProtocolPolicy;
    const tunnelProxyPlan = tunnelProxyProtocolPlan(rule);
    const useExitBridge = shouldUseProtocolGuard(rule, policy) || !!tunnelProxyPlan.exitBridgeReceive || !!tunnelProxyPlan.exitBridgeSend;
    if (tunnel && !isForwardXTunnel(tunnel) && useExitBridge) {
      const target = failoverTargetEndpoint(rule, "exitSend");
      guardRules.push({
        ruleId: rule.id,
        tunnelId: tunnel.id,
        listenPort: guardListenPort(rule),
        bindAddress: "127.0.0.1",
        targetIp: target.targetIp,
        targetPort: target.targetPort,
        protocol: normalizeForwardRuleProtocol(rule.protocol),
        policy,
        proxyProtocolReceive: !!tunnelProxyPlan.exitBridgeReceive,
        proxyProtocolSend: !!tunnelProxyPlan.exitBridgeSend,
        proxyProtocolVersion: proxyProtocolVersion(rule),
      });
    }
  }
  for (const rule of nginxTunnelExitRules) {
    const tunnel = tunnelById.get((rule as any).tunnelId) as any;
    if (!tunnel) continue;
    const policy = await tunnelProtocolPolicy(tunnel);
    if (shouldUseProtocolGuard(rule, policy)) {
      const target = failoverTargetEndpoint(rule);
      guardRules.push({
        ruleId: rule.id,
        tunnelId: tunnel.id,
        listenPort: guardListenPort(rule),
        bindAddress: "127.0.0.1",
        targetIp: target.targetIp,
        targetPort: target.targetPort,
        protocol: normalizeForwardRuleProtocol(rule.protocol),
        policy,
        proxyProtocolReceive: false,
        proxyProtocolSend: false,
        proxyProtocolVersion: proxyProtocolVersion(rule),
      });
    }
  }

  for (const rule of tunnelExitRules) {
    if (!runtimeBool(rule.isEnabled)) continue;
    const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
    for (const trafficPort of currentHostTunnelExitPortsForRule(rule, tunnel)) {
      if (!trafficPort) continue;
      protectActiveRulePort(rule, trafficPort);
      addRunningRule({
        ruleId: rule.id,
        tunnelId: tunnel ? Number(tunnel.id) : 0,
        sourcePort: trafficPort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        forwardType: tunnel && isForwardXTunnel(tunnel) ? "forwardx-tunnel-exit" : "gost-tunnel-exit",
        failover: failoverForCurrentHost(rule, tunnel, { listenPort: failoverProxyPort(rule) }),
      });
    }
  }
  for (const rule of nginxTunnelExitRules) {
    if (!runtimeBool(rule.isEnabled)) continue;
    const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
    for (const trafficPort of currentHostTunnelExitPortsForRule(rule, tunnel)) {
      if (!trafficPort) continue;
      protectActiveRulePort(rule, trafficPort);
      addRunningRule({
        ruleId: rule.id,
        tunnelId: tunnel ? Number(tunnel.id) : 0,
        sourcePort: trafficPort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        forwardType: "nginx-tunnel-exit",
        failover: failoverForCurrentHost(rule, tunnel, { listenPort: failoverProxyPort(rule) }),
      });
    }
  }
  /*
    NEX 隧道的线路组：出口机上只跑调度器（schedulerOnly，见 shared/routeGroup 的
    routeGroupIsForwardXTunnel）。这台机器上没有这条规则的端口：sourcePort 填调度器自己的监听端口，
    只给 Agent 当认调度器的标识；Agent 不给它写端口状态、不装计数链，流量照旧在入口计。
  */
  for (const rule of agentAllRules as any[]) {
    if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || !rule.failoverEnabled) continue;
    if (rule.forwardType !== "gost" || !rule.tunnelId) continue;
    const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
    if (!tunnel || !isForwardXTunnel(tunnel) || !runtimeBool(tunnel.isEnabled)) continue;
    if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) continue;
    const failover = forwardXSchedulerFailover(rule, tunnel);
    if (!failover || Number(failover.listenPort || 0) <= 0) continue;
    addRunningRule({
      ruleId: Number(rule.id),
      tunnelId: Number(tunnel.id),
      sourcePort: Number(failover.listenPort),
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
      protocol: rule.protocol,
      forwardType: "route-scheduler",
      schedulerOnly: true,
      failover,
    });
  }

  const gostMultiHopRelayRules = await Promise.all(agentAllRules
    .filter((rule: any) => {
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || !runtimeBool(rule.isRunning)) return false;
      if (rule.forwardType !== "gost" || !rule.tunnelId) return false;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      if (!tunnel || !isGostTunnelMode(tunnel) || !runtimeBool(tunnel.isEnabled)) return false;
      if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return false;
      if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return false;
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      return Array.isArray(hops) && hops.length >= 3;
    })
    .map(async (rule: any) => {
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id)) || [];
      const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
      if (hostIdx <= 0 || hostIdx >= hops.length - 1) return null;
      const currentHop = hops[hostIdx] as any;
      const nextHop = tunnelRelayUsesParallelRelays(tunnel, hops) ? hops[hops.length - 1] : hops[hostIdx + 1] as any;
      const nextHost = await getHopDialAddress(nextHop, tunnel);
      const sourcePort = Number(currentHop.listenPort) || 0;
      const targetPort = Number(nextHop.listenPort) || 0;
      if (!sourcePort || !targetPort || !nextHost) return null;
      return {
        ruleId: Number(rule.id),
        tunnelId: Number(tunnel.id),
        sourcePort,
        targetIp: nextHost,
        targetPort,
        protocol: "tcp",
        forwardType: "gost-tunnel-hop",
      };
    }));
  for (const runningRule of gostMultiHopRelayRules) {
    if (runningRule) addRunningRule(runningRule);
  }

  /**
   * 落地入站的端口也要进 runningRules —— 但只为了计数，不为了转发。
   *
   * 这条路能走通靠两个既有事实：runningRules 只驱动「写状态 + 装计数链」，
   * 转发器是 actions 启动的；而非 iptables/nftables/forwardx 的方式走
   * countingRuleProcess 模式，装计数链只需要监听端口和协议，不需要目标地址。
   * 所以放进来但不发 apply 动作，就只会计数。已装的 Agent 不必升级。
   *
   * 必须放在下面那个 expectedRulePorts 循环之前：那里算的是「这台机器上应该
   * 存在哪些端口」，漏掉的话 Agent 会把落地端口的计数链当孤儿清掉。
   */
  const hostProxyInbounds = await getEnabledProxyInboundsWithUsersByHost(Number(host.id));
  for (const row of hostProxyInbounds) {
    // Mieru 由 mita 按用户计数（server/mitaTraffic.ts）：mita 的用户不分端口，按端口计会记错人。
    if (row.protocol === "mieru") continue;
    addRunningRule({
      ruleId: proxyInboundTrafficRuleId(row.id),
      sourcePort: row.port,
      // 只计数，没有转发目标。
      targetIp: "",
      targetPort: 0,
      protocol: proxyInboundTrafficProtocol(row.protocol),
      forwardType: PROXY_INBOUND_TRAFFIC_FORWARD_TYPE,
    });
  }

  for (const runningRule of runningRules) {
    // 只跑调度器的那种不占端口（上面 NEX 隧道出口那段），不算这台机器上「应该有」的端口。
    if (runningRule.schedulerOnly) continue;
    const port = Number(runningRule.sourcePort || 0);
    if (port > 0) expectedRulePorts.add(runtimePortProtocolKey(port, runningRule.protocol));
    if (port > 0) expectedRuleIdentityKeys.add(ruleRuntimeIdentityKey(runningRule.ruleId, port, runningRule.protocol));
    if (port > 0) expectedRulePortIdentityKeys.add(ruleRuntimePortIdentityKey(runningRule.ruleId, port));
  }
  return { hostProxyInbounds };
}
