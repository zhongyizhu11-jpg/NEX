/*
  从 server/agentHeartbeatRoute.ts 第 787-857 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { runtimeBool } from "../agentHeartbeatRuntime";
import * as db from "../db";
import { groupRuleTrafficBlocked, planTunnelTrafficParticipation } from "../hostTrafficRuntimePlan";
import { isTunnelRuntimeHostReady } from "../tunnelRuntimeStatus";
import { isForwardXV3Tunnel } from "@shared/forwardXV3";
import { isTunnelRelayFailover } from "@shared/tunnelRelay";

export type BlockRulesForTrafficExcludedHostsContext = {
  trafficExcludedHosts: ReadonlySet<number>;
  agentHostRules: Array<any>;
  agentAllRules: Array<unknown>;
  tunnelById: Map<any, any>;
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  hostTunnels: any;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  tunnelEntryHostIdsByTunnelId: Map<number, Array<number>>;
  host: any;
  actions: Array<any>;
  tunnelExitRowsByRuleId: Map<number, Array<any>>;
};

export async function blockRulesForTrafficExcludedHosts(ctx: BlockRulesForTrafficExcludedHostsContext) {
  const { trafficExcludedHosts, agentHostRules, agentAllRules, tunnelById, tunnelHopsByTunnelId, hostTunnels, tunnelExitNodesByTunnelId, tunnelEntryHostIdsByTunnelId, host, actions, tunnelExitRowsByRuleId } = ctx;
  if (trafficExcludedHosts.size > 0) {
    const blockForTraffic = (rule: any) => {
      rule.isEnabled = false;
      rule.resourceAccessDenied = true;
      rule.hostTrafficExcluded = true;
    };
    const groupById = new Map<number, any>();
    for (const rule of [...agentHostRules, ...agentAllRules] as any[]) {
      const groupId = Number(rule.forwardGroupId || 0);
      if (groupId > 0 && !groupById.has(groupId)) groupById.set(groupId, await db.getForwardGroupById(groupId));
      const group = groupById.get(groupId);
      const chainHostIds = String(group?.groupMode) === "chain"
        ? (group.members || []).filter((member: any) => runtimeBool(member.isEnabled, true)).map((member: any) => Number(member.hostId))
        : [];
      if (groupRuleTrafficBlocked(rule, trafficExcludedHosts, chainHostIds)) blockForTraffic(rule);
      // 组成员用的是固定出口 / 链式中转的隧道：出口或中转被暂停，这条子规则也走不通。
      const memberTunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      const memberHops = memberTunnel ? tunnelHopsByTunnelId.get(Number(memberTunnel.id)) || [] : [];
      const blockedFixedExit = memberTunnel && !Number(memberTunnel.exitGroupId) && !runtimeBool(memberTunnel.loadBalanceEnabled)
        && trafficExcludedHosts.has(Number(memberTunnel.exitHostId));
      const blockedTransit = memberTunnel && !isTunnelRelayFailover(memberTunnel, memberHops)
        && memberHops.slice(1, -1).some((hop: any) => trafficExcludedHosts.has(Number(hop.hostId)));
      if (groupId > 0 && (blockedFixedExit || blockedTransit)) blockForTraffic(rule);
    }
    for (const tunnel of hostTunnels as any[]) {
      const tunnelId = Number(tunnel.id);
      const originalHops = tunnelHopsByTunnelId.get(tunnelId) || [];
      const originalExits = tunnelExitNodesByTunnelId.get(tunnelId) || [];
      const plan = planTunnelTrafficParticipation(tunnel, originalHops, originalExits,
        tunnelEntryHostIdsByTunnelId.get(tunnelId) || [], trafficExcludedHosts);
      if (Number(tunnel.entryGroupId) > 0 && trafficExcludedHosts.has(Number(host.id))) {
        // 入口组隧道的规则存着原主人的 hostId、却装在每个入口上：按「当前这台 Agent」拦，
        // 不按存着的 hostId；全局的出口规则留给别的入口用。
        for (const rule of agentHostRules as any[]) {
          if (Number(rule.tunnelId) === tunnelId) blockForTraffic(rule);
        }
      }
      // 出口组 / 多出口的 NEX 隧道：这台被暂停时明确撤掉它原来的出口监听（只改主出口的运行时
      // 副本，老 Agent 上那个监听会一直留着）。
      if (String(tunnel.mode) === "forwardx" && (Number(tunnel.exitGroupId) > 0 || runtimeBool(tunnel.loadBalanceEnabled)) && trafficExcludedHosts.has(Number(host.id))) {
        const localExit = Number(tunnel.exitHostId) === Number(host.id) ? tunnel
          : originalExits.find((node: any) => Number(node.hostId) === Number(host.id));
        if (localExit && Number(localExit.listenPort) > 0 && isTunnelRuntimeHostReady(tunnelId, Number(host.id))) {
          actions.push({
            tunnelId, ruleId: 0, statusType: "tunnel", op: "remove", forwardType: "forwardx-tunnel",
            sourcePort: Number(localExit.listenPort), targetIp: host.ip, targetPort: Number(localExit.listenPort), protocol: "both", commands: [],
            // V3 的出口进程身份带着 v3（Agent 的 fxpServerID），撤的时候要说清楚是哪个版本。
            fxp: { role: "exit", tunnelId, ruleId: 0, listenPort: Number(localExit.listenPort), ...(isForwardXV3Tunnel(tunnel) ? { transportVersion: "v3" } : {}) },
          } as any);
        }
      }
      if (plan.promotedExit) {
        // GOST 在每个出口上给每条规则分的端口不一样：提上来的出口要用它自己的那组映射，不能沿用原主出口的端口。
        for (const rule of [...agentHostRules, ...agentAllRules] as any[]) {
          if (Number(rule.tunnelId) !== tunnelId) continue;
          const mapping = (tunnelExitRowsByRuleId.get(Number(rule.id)) || [])
            .find((row: any) => Number(row.exitNodeId) === Number(plan.promotedExit.id));
          if (mapping) rule.tunnelExitPort = Number(mapping.tunnelExitPort);
        }
      }
      Object.assign(tunnel, plan.tunnel);
      tunnelHopsByTunnelId.set(tunnelId, plan.hops);
      tunnelExitNodesByTunnelId.set(tunnelId, plan.exits);
      tunnelEntryHostIdsByTunnelId.set(tunnelId, plan.entryHostIds);
      if (!runtimeBool(tunnel.isEnabled)) {
        for (const rule of [...agentHostRules, ...agentAllRules] as any[]) {
          if (Number(rule.tunnelId) === tunnelId) blockForTraffic(rule);
        }
      }
    }
  }
}
