/*
  从 client/src/pages/Rules.tsx 第 5716-5968 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { enabledHostMembers, formatAddressWithPort, isForwardChainGroup, normalizeAddressKey, ruleGlobeRouteHostIds, type RuleTargetGeo } from "../../pages/Rules";
import { type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { addHostNodeMeta, addNodeMetaAliases, findHostByAddress, hostDisplayName, hostNodeMeta, targetGeoNodeMeta } from "@/lib/linkTestNodeMeta";
import { tunnelHopHostName } from "@/lib/tunnelDisplay";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { useMemo } from "react";

export type UseSelfTestLinkTestNodeDataContext = {
  selfTestRuleDetail: any;
  selfTestRule: { id: number; name: string; isForwardChain?: boolean; chainKernel?: boolean; probeMethod?: "tcping" | "ping"; tab?: string; } | null;
  hosts: Array<any> | undefined;
  tunnelById: Map<number, any>;
  forwardGroupById: Map<number, any>;
  trafficByRule: any /* 类型太长或引用了别的模块，手动收拾 */;
  getRuleEntryHost: (rule: any) => any;
  targetGeoByAddress: Map<string, RuleTargetGeo>;
  getRuleEntryHostName: (rule: any) => any;
};

export type UseSelfTestLinkTestNodeDataResult = {
  selfTestLinkTestNodeData: { nodeMeta: Record<string, any>; sourceLabel: any; targetLabel: string; plannedSegments: Array<LinkTestPlannedSegment>; };
};

export function useSelfTestLinkTestNodeData(ctx: UseSelfTestLinkTestNodeDataContext): UseSelfTestLinkTestNodeDataResult {
  const { selfTestRuleDetail, selfTestRule, hosts, tunnelById, forwardGroupById, trafficByRule, getRuleEntryHost, targetGeoByAddress, getRuleEntryHostName } = ctx;
  const selfTestLinkTestNodeData = useMemo(() => {
    const meta: Record<string, any> = {};
    const rule = selfTestRuleDetail;
    if (!rule) {
      return { nodeMeta: meta, sourceLabel: selfTestRule?.name || "源节点", targetLabel: selfTestRule?.name || "目标", plannedSegments: [] as LinkTestPlannedSegment[] };
    }

    const hostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    const tunnelHostById = new Map<number, any>();
    if (tunnel) {
      [
        ...(Array.isArray((tunnel as any).hopHosts) ? (tunnel as any).hopHosts : []),
        (tunnel as any).entryHost,
        (tunnel as any).exitHost,
        ...(Array.isArray((tunnel as any).loadBalanceExits) ? (tunnel as any).loadBalanceExits.map((exit: any) => exit?.host) : []),
      ].forEach((host: any) => {
        const id = Number(host?.id || 0);
        if (id > 0) tunnelHostById.set(id, host);
      });
    }
    const hostForRouteId = (hostId: number) => hostById.get(Number(hostId)) || tunnelHostById.get(Number(hostId));
    const chainGroup = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const chainEntryGroup = chainGroup && isForwardChainGroup(chainGroup) && Number(chainGroup.entryGroupId || 0) > 0
      ? forwardGroupById.get(Number(chainGroup.entryGroupId))
      : null;
    const chainEntryMembers = chainEntryGroup && forwardGroupModeOf(chainEntryGroup) === "entry" ? enabledHostMembers(chainEntryGroup) : [];
    const tunnelEntryGroup = tunnel && Number((tunnel as any).entryGroupId || 0) > 0
      ? forwardGroupById.get(Number((tunnel as any).entryGroupId)) || (tunnel as any).entryGroup
      : null;
    const tunnelEntryMembers = tunnelEntryGroup && forwardGroupModeOf(tunnelEntryGroup) === "entry" ? enabledHostMembers(tunnelEntryGroup) : [];
    const tunnelEntryMemberByHostId = new Map<number, any>();
    tunnelEntryMembers.forEach((member: any) => {
      const hostId = Number(member?.hostId || 0);
      if (hostId > 0) tunnelEntryMemberByHostId.set(hostId, member);
    });
    const labelForRouteHostId = (hostId: number) => {
      const host = hostForRouteId(hostId);
      const member = tunnelEntryMemberByHostId.get(Number(hostId));
      return hostDisplayName(host)
        || String(member?.name || member?.remark || "").trim()
        || (tunnel ? tunnelHopHostName(tunnel, hostId, hosts) : "")
        || `主机 #${hostId}`;
    };
    const configuredRouteHostIds = ruleGlobeRouteHostIds(rule, tunnelById, forwardGroupById);
    /*
      负载均衡链路：诊断的路径画扛流量最多的那台出口（入口真实上报，和卡上的延迟、「经」同一台），诊断也是从它测的
      （rules.selfTest）。它就是主出口时照旧（链路自己的延迟可以拿来填入口到出口那一段）。
    */
    const viaExitCandidate = tunnel ? Number(trafficByRule.get(Number(rule.id))?.exitTargetViaHostIds?.[0] || 0) : 0;
    const viaExitHostId = viaExitCandidate > 0 && viaExitCandidate !== Number(configuredRouteHostIds[configuredRouteHostIds.length - 1] || 0) ? viaExitCandidate : 0;
    const routeHostIds = viaExitHostId > 0 && configuredRouteHostIds.length >= 2
      ? [...configuredRouteHostIds.slice(0, -1), viaExitHostId]
      : configuredRouteHostIds;
    routeHostIds.forEach((hostId: number, index: number) => {
      const host = hostForRouteId(Number(hostId));
      addHostNodeMeta(meta, host, [
        index === 0 ? "入口" : "",
        index === routeHostIds.length - 1 ? "出口" : "",
        tunnel ? labelForRouteHostId(hostId) : "",
        tunnel ? tunnelHopHostName(tunnel, hostId, hosts) : "",
        `主机${hostId}`,
        `主机 #${hostId}`,
      ]);
    });

    const sourceHost = hostForRouteId(Number(routeHostIds[0] || rule.hostId || 0)) || getRuleEntryHost(rule);
    const exitHost = hostForRouteId(Number(routeHostIds[routeHostIds.length - 1] || 0));
    if (sourceHost) addHostNodeMeta(meta, sourceHost, ["入口", "源节点"]);
    chainEntryMembers.forEach((entryMember: any) => {
      const entryHost = hostForRouteId(Number(entryMember.hostId || 0));
      addHostNodeMeta(meta, entryHost, [
        "入口",
        "源节点",
        `主机${entryMember.hostId || ""}`,
        `主机 #${entryMember.hostId || ""}`,
      ]);
    });
    tunnelEntryMembers.forEach((entryMember: any) => {
      const entryHostId = Number(entryMember.hostId || 0);
      const entryHost = hostForRouteId(entryHostId);
      addHostNodeMeta(meta, entryHost, [
        "入口",
        "源节点",
        labelForRouteHostId(entryHostId),
        entryMember.entryAddress,
        `主机${entryHostId || ""}`,
        `主机 #${entryHostId || ""}`,
      ]);
    });
    if (exitHost) addHostNodeMeta(meta, exitHost, ["出口"]);

    const targetIp = String(rule.targetIp || "").trim();
    const targetText = formatAddressWithPort(targetIp || "-", Number(rule.targetPort || 0) || "-") || "目标";
    const ruleLabel = String(rule.name || selfTestRule?.name || `规则 #${rule.id || "-"}`).trim();
    const targetHost = findHostByAddress(hosts, targetIp);
    if (targetHost) {
      addHostNodeMeta(meta, targetHost);
      const hostMeta = {
        ...hostNodeMeta(targetHost),
        label: ruleLabel,
      };
      addNodeMetaAliases(meta, [
        ruleLabel,
        targetIp,
        targetText,
        `目标 ${targetText}`,
        `目标 ${targetIp}:${rule.targetPort || "-"}`,
        "目标",
        "目的节点",
      ], hostMeta);
    } else {
      const targetGeo = targetGeoByAddress.get(normalizeAddressKey(targetIp));
      const targetMeta = targetGeoNodeMeta(ruleLabel, targetIp || targetText, targetGeo);
      addNodeMetaAliases(meta, [
        ruleLabel,
        targetIp,
        targetText,
        `目标 ${targetText}`,
        `目标 ${targetIp}:${rule.targetPort || "-"}`,
        "目标",
        "目的节点",
      ], targetMeta);
    }

    const routeHosts = routeHostIds
      .map((hostId: number) => hostForRouteId(Number(hostId)))
      .filter(Boolean);
    const plannedSegments: LinkTestPlannedSegment[] = [];
    const isChainRule = !!chainGroup && isForwardChainGroup(chainGroup);
    const routeHopCount = Math.max(0, routeHostIds.length - 1);
    const pathHopCount = isChainRule
      ? (chainEntryMembers.length > 0 ? 1 : 0) + routeHopCount + 1
      : routeHopCount;
    if (chainEntryMembers.length > 0 && routeHosts[0]) {
      const firstChainHost = routeHosts[0];
      const firstChainHostId = Number(routeHostIds[0] || 0);
      chainEntryMembers.forEach((entryMember: any) => {
        const entryHostId = Number(entryMember.hostId || 0);
        const entryHost = hostForRouteId(entryHostId);
        plannedSegments.push({
          from: hostDisplayName(entryHost) || `入口主机 #${entryMember.hostId || "-"}`,
          to: hostDisplayName(firstChainHost),
          fromHostId: entryHostId || null,
          toHostId: firstChainHostId || null,
          hopIndex: 0,
          hopCount: pathHopCount,
          fromMeta: meta[hostDisplayName(entryHost)] || meta[String(entryMember.hostId || "")],
          toMeta: meta[hostDisplayName(firstChainHost)],
        });
      });
    }
    const tunnelLatencyMs = typeof (tunnel as any)?.latestLatencyMs === "number" && Number.isFinite((tunnel as any).latestLatencyMs)
      ? Number((tunnel as any).latestLatencyMs)
      : typeof (tunnel as any)?.lastLatencyMs === "number" && Number.isFinite((tunnel as any).lastLatencyMs)
        ? Number((tunnel as any).lastLatencyMs)
        : null;
    const tunnelLatencyIsTimeout = !!(tunnel as any)?.latestLatencyIsTimeout || ((tunnel as any)?.lastTestStatus === "failed" && tunnelLatencyMs === null);
    const nodeMetaForHostId = (hostId: number) => {
      const host = hostForRouteId(hostId);
      return meta[hostDisplayName(host)] || meta[labelForRouteHostId(hostId)] || meta[String(hostId)] || undefined;
    };
    const createTunnelPlannedSegment = (
      fromHostId: number,
      toHostId: number,
      useTunnelLatencyFallback: boolean,
      hopIndex: number,
    ): LinkTestPlannedSegment => ({
      from: labelForRouteHostId(fromHostId),
      to: labelForRouteHostId(toHostId),
      fromHostId: fromHostId || null,
      toHostId: toHostId || null,
      hopIndex,
      hopCount: pathHopCount,
      fromMeta: nodeMetaForHostId(fromHostId),
      toMeta: nodeMetaForHostId(toHostId),
      success: tunnelLatencyMs !== null && useTunnelLatencyFallback
        ? true
        : tunnelLatencyIsTimeout && useTunnelLatencyFallback
          ? false
          : undefined,
      latencyMs: tunnelLatencyMs !== null && useTunnelLatencyFallback ? tunnelLatencyMs : null,
      message: tunnelLatencyIsTimeout && useTunnelLatencyFallback ? "隧道段失败" : null,
      method: null,
      pending: false,
    });
    const tunnelEntryHostIds = tunnel
      ? Array.from(new Set([
        Number(routeHostIds[0] || (tunnel as any).entryHostId || 0),
        ...tunnelEntryMembers.map((member: any) => Number(member?.hostId || 0)),
      ].filter((hostId: number) => Number.isFinite(hostId) && hostId > 0)))
      : [];
    const hasTunnelMultiEntry = !!tunnel && tunnelEntryHostIds.length > 1;
    if (hasTunnelMultiEntry) {
      const lastHostId = Number(routeHostIds[routeHostIds.length - 1] || (tunnel as any).exitHostId || 0);
      const restRouteHostIds = routeHostIds.filter((hostId: number) => !tunnelEntryHostIds.includes(Number(hostId)));
      const nextHostId = Number(restRouteHostIds[0] || lastHostId || (tunnel as any).exitHostId || 0);
      if (nextHostId > 0) {
        tunnelEntryHostIds.forEach((entryHostId) => {
          if (entryHostId !== nextHostId) {
            plannedSegments.push(createTunnelPlannedSegment(entryHostId, nextHostId, false, 0));
          }
        });
      }
      for (let index = 0; index < restRouteHostIds.length - 1; index += 1) {
        plannedSegments.push(createTunnelPlannedSegment(
          Number(restRouteHostIds[index]),
          Number(restRouteHostIds[index + 1]),
          false,
          index + 1,
        ));
      }
    } else {
      for (let index = 0; index < routeHostIds.length - 1; index += 1) {
        // 换成在用的出口时，链路自己的延迟（入口到主出口量的）不能拿来填这一段
        const singleTunnelSegment = routeHostIds.length - 1 === 1 && !(viaExitHostId > 0);
        plannedSegments.push(createTunnelPlannedSegment(
          Number(routeHostIds[index]),
          Number(routeHostIds[index + 1]),
          singleTunnelSegment,
          index + (chainEntryMembers.length > 0 ? 1 : 0),
        ));
      }
    }
    const exitHostForTarget = routeHosts[routeHosts.length - 1] || sourceHost;
    if (exitHostForTarget) {
      const exitHostId = Number(exitHostForTarget.id || routeHostIds[routeHostIds.length - 1] || 0);
      plannedSegments.push({
        from: hostDisplayName(exitHostForTarget),
        to: ruleLabel,
        fromHostId: exitHostId || null,
        toHostId: Number(targetHost?.id || 0) || null,
        hopIndex: isChainRule ? Math.max(0, pathHopCount - 1) : null,
        hopCount: isChainRule ? pathHopCount : null,
        fromMeta: meta[hostDisplayName(exitHostForTarget)],
        toMeta: meta[ruleLabel] || meta[targetText] || meta[targetIp],
      });
    }

    return {
      nodeMeta: meta,
      sourceLabel: chainEntryMembers.length > 0
        ? chainEntryMembers
          .map((member: any) => hostDisplayName(hostForRouteId(Number(member.hostId || 0))) || `入口主机 #${member.hostId || "-"}`)
          .filter(Boolean)
          .join(" / ")
        : tunnelEntryHostIds.length > 1
          ? tunnelEntryHostIds.map((hostId) => labelForRouteHostId(hostId)).filter(Boolean).join(" / ")
          : hostDisplayName(sourceHost) || getRuleEntryHostName(rule),
      targetLabel: ruleLabel,
      plannedSegments,
    };
  }, [forwardGroupById, getRuleEntryHost, hosts, selfTestRule?.name, selfTestRuleDetail, targetGeoByAddress, tunnelById]);
  return { selfTestLinkTestNodeData };
}
