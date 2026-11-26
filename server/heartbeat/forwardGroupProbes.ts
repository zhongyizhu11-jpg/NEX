/*
  从 server/agentHeartbeatRoute.ts 第 4481-4671 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { normalizeForwardGroupHealthCheckMethod } from "../../shared/forwardGroupHealthCheck";
import type { TunnelEgressHelper } from "../agentHeartbeatContext";
import { runtimeBool } from "../agentHeartbeatRuntime";
import * as db from "../db";
import { exitTargetProbeSpec, tunnelBalanceDetect, tunnelBalancesExits } from "../exitTargetHealth";
import { isRuleProtocolEnabled, isTunnelProtocolEnabled } from "../forwardProtocolSettings";
import { forwardGroupProbeTopologyKey } from "../probeTopology";
import { buildRouteHopFastProbes, type RouteHopProbeSpec } from "../routeGroups";
import { buildTunnelRuleLatencyProbe, tunnelRuleProbeExitHostIds } from "../ruleLatency";
import { FXP_BALANCE_REPORT_VERSION } from "@shared/loadBalance";
import { isAgentVersionAtLeast } from "@shared/version";

export type BuildForwardGroupProbesContext = {
  forwardGroupProbeTopology: db.ForwardGroupProbeTopologyForHost;
  host: any;
  forwardGroupProbeMap: Map<string, any>;
  agentAllRules: Array<any>;
  tunnelById: Map<any, any>;
  forwardProtocolSettings: any /* 原类型 ForwardProtocolSettings… 引用了拿不到的 ForwardProtocolSettings，手动收拾 */;
  tunnelEgressHelpers: Map<number, TunnelEgressHelper>;
  processTarget: any /* 原类型 (rule: any) => any… 引用了拿不到的 rule，手动收拾 */;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  forwardGroupHealthByRuleId: Map<number, any>;
};

export type BuildForwardGroupProbesResult = {
  ruleLatencyProbes: any /* 原类型 Array<{ forwardGroupHealth: any; ruleId: number; tunnelId: number; targetIp: str… 引用了拿不到的 RuleLatencyProbeMethod，手动收拾 */;
  forwardGroupProbes: Array<any>;
};

export async function buildForwardGroupProbes(ctx: BuildForwardGroupProbesContext): Promise<BuildForwardGroupProbesResult> {
  const { forwardGroupProbeTopology, host, forwardGroupProbeMap, agentAllRules, tunnelById, forwardProtocolSettings, tunnelEgressHelpers, processTarget, tunnelExitNodesByTunnelId, forwardGroupHealthByRuleId } = ctx;
  for (const group of forwardGroupProbeTopology.chainGroups as any[]) {
    const probes = group.probes as any[];
    const topologyKey = forwardGroupProbeTopologyKey(Number(group.groupId), probes);
    for (const probe of probes) {
      if (Number(probe.fromHostId) !== Number(host.id)) continue;
      const key = `${probe.groupId}:${probe.hopIndex}:${probe.targetIp}:${probe.targetPort}:${probe.method}`;
      forwardGroupProbeMap.set(key, {
        groupId: probe.groupId,
        targetIp: probe.targetIp,
        targetPort: probe.targetPort,
        method: probe.method,
        hopIndex: probe.hopIndex,
        hopCount: probe.hopCount,
        probeKey: `forward-group:${Number(probe.groupId)}:host:${Number(host.id)}:hop:${Number(probe.hopIndex)}/${Number(probe.hopCount)}:${String(probe.targetIp).toLowerCase()}:${Number(probe.targetPort) || 0}:${String(probe.method || "tcp").toLowerCase()}`,
        topologyKey,
      });
    }
  }
  for (const probe of forwardGroupProbeTopology.chinaHealthProbes as any[]) {
    const key = `china:${probe.groupId}:${probe.memberId}:${probe.targetIp}:${probe.targetPort}`;
    forwardGroupProbeMap.set(key, {
      groupId: probe.groupId,
      memberId: probe.memberId,
      probeType: "china",
      targetIp: probe.targetIp,
      targetPort: probe.targetPort,
      // 按组里选的方法探（tcp / ping / udp）。
      method: normalizeForwardGroupHealthCheckMethod(probe.method),
      hopIndex: 0,
      hopCount: 1,
      probeKey: `forward-group:${Number(probe.groupId)}:host:${Number(host.id)}:china:${Number(probe.memberId)}:${String(probe.targetIp).toLowerCase()}:${Number(probe.targetPort) || 0}`,
      topologyKey: `forward-group:${Number(probe.groupId)}:china:${Number(probe.memberId)}`,
      failoverSeconds: Math.max(10, Number(probe.failoverSeconds || 60)),
      recoverSeconds: Math.max(10, Number(probe.recoverSeconds || 120)),
    });
  }
  for (const probe of forwardGroupProbeTopology.entryHealthProbes as any[]) {
    const key = `entry:${probe.groupId}:${probe.memberId}`;
    forwardGroupProbeMap.set(key, {
      groupId: probe.groupId,
      memberId: probe.memberId,
      probeType: "entry",
      targetIp: "",
      targetPort: 0,
      method: "self",
      hopIndex: 0,
      hopCount: 1,
      probeKey: `forward-group:${Number(probe.groupId)}:host:${Number(host.id)}:entry:${Number(probe.memberId)}`,
      topologyKey: `forward-group:${Number(probe.groupId)}:entry:${Number(probe.memberId)}`,
      failoverSeconds: Math.max(10, Number(probe.failoverSeconds || 60)),
      recoverSeconds: Math.max(10, Number(probe.recoverSeconds || 120)),
    });
  }
  // 外部观察：这台机器替面板去探别的成员对外的入口端口（memberId = 0 是参照目标）。结果按原始通断报，面板自己判。
  for (const probe of forwardGroupProbeTopology.peerHealthProbes) {
    const key = `peer:${probe.groupId}:${probe.memberId}:${probe.targetIp}:${probe.targetPort}:${probe.method}`;
    forwardGroupProbeMap.set(key, {
      groupId: probe.groupId,
      memberId: probe.memberId,
      probeType: "peer",
      targetIp: probe.targetIp,
      targetPort: probe.targetPort,
      method: normalizeForwardGroupHealthCheckMethod(probe.method),
      hopIndex: 0,
      hopCount: 1,
      probeKey: `forward-group:${Number(probe.groupId)}:host:${Number(host.id)}:peer:${Number(probe.memberId)}:${String(probe.targetIp).toLowerCase()}:${Number(probe.targetPort) || 0}:${String(probe.method)}`,
      topologyKey: `forward-group:${Number(probe.groupId)}:peer:${Number(probe.memberId)}`,
      failoverSeconds: Math.max(10, Number(probe.failoverSeconds || 60)),
      recoverSeconds: Math.max(10, Number(probe.recoverSeconds || 120)),
    });
  }
  const forwardGroupProbes = Array.from(forwardGroupProbeMap.values());
  const ruleLatencyProbes = (agentAllRules as any[])
    .filter((rule: any) => {
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || !runtimeBool(rule.isRunning)) return false;
      const tunnelId = Number(rule.tunnelId || 0);
      if (tunnelId <= 0) return false;
      const tunnel = tunnelById.get(tunnelId) as any;
      return !!tunnel
        && runtimeBool(tunnel.isEnabled)
        && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
        && isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel);
    })
    .map((rule: any) => {
      // 接了 Shadowsocks 出口：出口机拨的是本机的 SS 客户端，测它没有意义 —— 测出口机到 SS 落地这一段。
      const egressHelper = tunnelEgressHelpers.get(Number(rule.id));
      // 负载均衡链路：每台出口都探（2.3.544，规则卡 / 诊断 / 弹窗要的是在用那台「出口到目标」的 TCPing）
      const probeTunnel = tunnelById.get(Number(rule.tunnelId || 0));
      const probe = buildTunnelRuleLatencyProbe({
        hostId: host.id,
        rule: egressHelper ? { ...rule, targetPort: egressHelper.runtime.port } : rule,
        tunnel: probeTunnel,
        targetIp: egressHelper ? egressHelper.runtime.server : processTarget(rule),
        exitHostIds: tunnelRuleProbeExitHostIds(probeTunnel, tunnelExitNodesByTunnelId.get(Number(rule.tunnelId || 0)) || []),
      });
      return probe ? {
        ...probe,
        forwardGroupHealth: forwardGroupHealthByRuleId.get(Number(rule.id)),
      } : null;
    })
    .filter(Boolean)
    .sort((left: any, right: any) => Number(left.ruleId) - Number(right.ruleId));
  /*
    线路组「下一跳」的快速探测（Agent 2.2.258 起）：隧道段的中继已经在上面这份里，挂上 routeHop 规格；
    gost 中继另加一条。老 Agent 不认 routeHop，gost 那几条（tunnelId 为 0）它也不会当探测跑。
  */
  const routeHopFast = await buildRouteHopFastProbes({ hostId: Number(host.id), rules: agentAllRules, tunnelById });
  if (routeHopFast.specByRuleId.size > 0) {
    const hopProbes = ruleLatencyProbes as Array<{ ruleId: number; routeHop?: RouteHopProbeSpec }>;
    for (const probe of hopProbes) {
      const spec = routeHopFast.specByRuleId.get(Number(probe.ruleId));
      if (spec) probe.routeHop = spec;
    }
    hopProbes.push(...routeHopFast.gostProbes);
    hopProbes.sort((left, right) => Number(left.ruleId) - Number(right.ruleId));
  }
  /*
    负载均衡链路：这台机器是出口之一时，按链路的「检测与切换」节奏探规则的目标（server/exitTargetHealth.ts）。
    主出口上面已经有这条规则的普通探测，挂上快速规格；其余出口另加一条 fastOnly（Agent 2.2.259 起不进
    一分钟一轮的普通探测；老 Agent 照样探，面板只收主出口的普通结果，多出来的那几条会被丢掉）。
  */
  {
    type ExitTargetProbe = { ruleId: number; tunnelId?: number; targetIp?: string; targetPort?: number; method?: string; probeKey?: string; routeHop?: RouteHopProbeSpec; fastOnly?: boolean };
    const exitProbes = ruleLatencyProbes as ExitTargetProbe[];
    const probeByRule = new Map(exitProbes.map((probe) => [Number(probe.ruleId), probe]));
    let added = false;
    type BalanceRule = { id: number; tunnelId?: number | null; pendingDelete?: unknown; isEnabled?: unknown; isRunning?: unknown; routeParentRuleId?: number | null; protocol?: string | null; targetPort?: number | null };
    type BalanceTunnel = { id: number; isEnabled?: unknown; exitHostId?: number | null; entryHostId?: number | null; entryGroupId?: number | null; mode?: string | null; loadBalanceEnabled?: unknown; loadBalanceStrategy?: string | null; balanceDetect?: string | null };
    /*
      2.3.539：入口自己报真实状态的链路（NEX 隧道、入口机 FXP ≥ 2.2.145）不用出口再另外测目标 —— 入口的 FXP
      本来就经每台出口测着（出口回报连目标的结果 + 主动探），面板直接用它报的。少一套探测，高防目标也少被当扫描。
    */
    const balanceTunnelIds = new Set<number>();
    for (const rule of agentAllRules as unknown as BalanceRule[]) {
      const tunnel = tunnelById.get(Number(rule?.tunnelId || 0)) as BalanceTunnel | undefined;
      if (tunnel && tunnelBalancesExits(tunnel)) balanceTunnelIds.add(Number(tunnel.id));
    }
    const entryReportsLive = new Set<number>();
    if (balanceTunnelIds.size > 0) {
      const entryIds = Array.from(balanceTunnelIds)
        .map((id) => tunnelById.get(id) as BalanceTunnel | undefined)
        .filter((tunnel): tunnel is BalanceTunnel => !!tunnel && String(tunnel.mode || "").toLowerCase() === "forwardx" && !(Number(tunnel.entryGroupId || 0) > 0))
        .map((tunnel) => Number(tunnel.entryHostId || 0))
        .filter((id) => id > 0);
      const entryRows = entryIds.length > 0 ? await db.getHostsByIds(Array.from(new Set(entryIds))).catch(() => []) as Array<{ id: number; fxpVersion?: string | null }> : [];
      const fxpNew = new Set(entryRows.filter((row) => isAgentVersionAtLeast(String(row.fxpVersion || ""), FXP_BALANCE_REPORT_VERSION)).map((row) => Number(row.id)));
      for (const id of balanceTunnelIds) {
        const tunnel = tunnelById.get(id) as BalanceTunnel | undefined;
        if (tunnel && String(tunnel.mode || "").toLowerCase() === "forwardx" && !(Number(tunnel.entryGroupId || 0) > 0) && fxpNew.has(Number(tunnel.entryHostId || 0))) {
          entryReportsLive.add(id);
        }
      }
    }
    for (const rule of agentAllRules as unknown as BalanceRule[]) {
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || !runtimeBool(rule.isRunning)) continue;
      if (Number(rule.routeParentRuleId || 0) > 0 || String(rule.protocol || "").toLowerCase() === "udp") continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId || 0)) as BalanceTunnel | undefined;
      if (!tunnel || !runtimeBool(tunnel.isEnabled) || !tunnelBalancesExits(tunnel)) continue;
      if (entryReportsLive.has(Number(tunnel.id))) continue;
      const extraExitNodes = (tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || []) as Array<{ hostId?: number | null; isEnabled?: unknown }>;
      const exitHostIds = [
        Number(tunnel.exitHostId || 0),
        ...extraExitNodes
          .filter((node) => runtimeBool(node?.isEnabled, true))
          .map((node) => Number(node.hostId)),
      ];
      if (exitHostIds.length < 2 || !exitHostIds.includes(Number(host.id))) continue;
      const detect = tunnelBalanceDetect(tunnel);
      // 负载均衡「只看隧道」（2.3.556）：不派「出口 → 目标」的快速探测
      if (detect.scope === "tunnel") continue;
      const spec = exitTargetProbeSpec(detect);
      const existing = probeByRule.get(Number(rule.id));
      if (existing) {
        if (!existing.routeHop) existing.routeHop = spec;
        continue;
      }
      const egressHelper = tunnelEgressHelpers.get(Number(rule.id));
      const targetIp = String(egressHelper ? egressHelper.runtime.server : processTarget(rule) || "").trim();
      const targetPort = Number(egressHelper ? egressHelper.runtime.port : rule.targetPort);
      if (!targetIp || !(targetPort > 0 && targetPort <= 65535)) continue;
      exitProbes.push({
        ruleId: Number(rule.id),
        tunnelId: Number(tunnel.id),
        targetIp,
        targetPort,
        method: "tcping",
        probeKey: `exit-target:${Number(rule.id)}:${Number(host.id)}`,
        routeHop: spec,
        fastOnly: true,
      });
      added = true;
    }
    if (added) exitProbes.sort((left, right) => Number(left.ruleId) - Number(right.ruleId));
  }
  return { ruleLatencyProbes, forwardGroupProbes };
}
