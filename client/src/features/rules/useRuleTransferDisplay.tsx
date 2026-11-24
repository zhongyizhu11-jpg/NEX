/*
  从 client/src/pages/Rules.tsx 第 6562-6659 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { formatAddressWithPort, formatRuleEntryAddress, getForwardGroupRouteLabel, getRuleCategory, isForwardChainGroup, type EntryAddress } from "../../pages/Rules";
import { filterRuleEntryAddressesForDisplay } from "@/lib/ruleEntryDisplay";
import { getTunnelExitNames, getTunnelHopIds, getTunnelLoadBalanceExitNames, tunnelHopHostName } from "@/lib/tunnelDisplay";
import { formatRuleTargetPort } from "@shared/portRange";
import { routeGroupOf, routeStrategyLabel } from "@shared/routeGroup";
import { parseSniNameJson } from "@shared/tlsInbound";

export type UseRuleTransferDisplayContext = {
  tlsInboundById: Map<number, any>;
  forwardGroupById: Map<number, any>;
  entryDomainForForwardGroup: (group: any | null | undefined) => string;
  getForwardChainEntryAddresses: (group: any | null | undefined) => EntryAddress[];
  getForwardGroupEntryAddresses: (group: any | null | undefined) => EntryAddress[];
  getRuleEntries: (rule: any) => EntryAddress[];
  tunnelById: Map<number, any>;
  hosts: Array<any> | undefined;
  trafficByRule: any;
  hostById: Map<number, any>;
};

export type UseRuleTransferDisplayResult = {
  getRuleTransferDisplay: (rule: any) => { entryAddresses: Array<{ text: string; copyable: boolean; label: string; value: any; }>; entryAddress: string; targetAddress: string; entryTitle: string; failoverCount: number; failoverEnabled: boolean; routeLabel: string; };
  getRuleHopNames: (rule: any) => string[];
};

export function useRuleTransferDisplay(ctx: UseRuleTransferDisplayContext): UseRuleTransferDisplayResult {
  const { tlsInboundById, forwardGroupById, entryDomainForForwardGroup, getForwardChainEntryAddresses, getForwardGroupEntryAddresses, getRuleEntries, tunnelById, hosts, trafficByRule, hostById } = ctx;
  const getRuleTransferDisplay = (rule: any) => {
    if (Number(rule?.tlsInboundId || 0) > 0) {
      // 共享 TLS 入站：入口是用户自己的域名 + 入站端口；sourcePort 只是本机回环端口，不给人看。
      const inbound = tlsInboundById.get(Number(rule.tlsInboundId));
      const names = parseSniNameJson(rule.sniNames);
      const port = Number(inbound?.port || 0);
      const sniEntries = names.map((name) => ({
        label: "SNI",
        value: name,
        text: port > 0 ? formatAddressWithPort(name, port) : name,
        copyable: port > 0,
      }));
      const entryAddresses = sniEntries.length > 0 ? sniEntries : [{ label: "SNI", value: "", text: "SNI 未配置", copyable: false }];
      return {
        entryAddresses,
        entryAddress: sniEntries.map((entry) => entry.text).join(" / "),
        targetAddress: `${rule.targetIp}:${rule.targetPort}`,
        entryTitle: `复制入口地址: ${sniEntries.map((entry) => entry.text).join(" / ")}`,
        failoverCount: 0,
        failoverEnabled: false,
        routeLabel: "",
      };
    }
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const groupRouteLabel = getForwardGroupRouteLabel(group);
    const groupEntry = isForwardChainGroup(group)
      ? (entryDomainForForwardGroup(group) || group?.members?.[0]?.entryAddress || "")
      : (group?.domain || group?.members?.[0]?.entryAddress || "");
    const chainEntryItems = isForwardChainGroup(group) ? getForwardChainEntryAddresses(group) : [];
    const groupEntryItems = rule.forwardGroupId && !isForwardChainGroup(group) ? getForwardGroupEntryAddresses(group) : [];
    const entryItems = rule.forwardGroupId
      ? (isForwardChainGroup(group) ? (chainEntryItems.length > 0 ? chainEntryItems : [{ label: "转发链", value: groupEntry }]) : (groupEntryItems.length > 0 ? groupEntryItems : [{ label: groupRouteLabel, value: groupEntry }]))
      : (getRuleEntries(rule).length > 0
        ? getRuleEntries(rule)
        : [{ label: "入口", value: "" }]);
    const resolvedEntryAddresses = filterRuleEntryAddressesForDisplay(entryItems)
      .filter((entry) => String(entry.value || "").trim())
      .map((entry) => ({
        ...entry,
        text: formatRuleEntryAddress(entry.value, rule),
        copyable: true,
      }));
    const entryAddresses = resolvedEntryAddresses.length > 0
      ? resolvedEntryAddresses
      : [{ label: "入口", value: "", text: "入口地址暂不可用", copyable: false }];
    const entryAddress = resolvedEntryAddresses.map((entry) => entry.text).join(" / ");
    const targetAddress = `${rule.targetIp}:${formatRuleTargetPort(rule)}`;
    const entryTitle = rule.forwardGroupId
      ? `复制${groupRouteLabel}入口: ${entryAddress}`
      : `复制入口地址: ${entryAddress}`;
    const routeGroup = routeGroupOf(rule);
    return {
      entryAddresses,
      entryAddress,
      targetAddress,
      entryTitle,
      failoverCount: routeGroup ? routeGroup.paths.length : 0,
      failoverEnabled: !!routeGroup,
      routeLabel: routeGroup ? routeStrategyLabel(routeGroup.policy, true) : "",
    };
  };

  /**
   * 这条规则中间经过哪些节点。直连返回空数组。
   *
   * 隧道取它的跳点名，转发链取链上的主机名，转发组取组名 —— 组内部谁在跑是
   * 组自己的事，规则这一层只需要说明「走的是这个组」。
   */

  const getRuleHopNames = (rule: any): string[] => {
    const category = getRuleCategory(rule, forwardGroupById);
    if (category === "tunnel") {
      const tunnel = tunnelById.get(Number(rule?.tunnelId || 0));
      if (!tunnel) return [];
      // 第一跳是入口机，卡片上已经是入口地址那一行了，「经」只列它后面经过的（中转和出口）。
      const names = getTunnelHopIds(tunnel)
        .slice(1)
        .map((hostId: number) => String(tunnelHopHostName(tunnel, hostId, hosts) || "").trim())
        .filter(Boolean);
      /*
        负载均衡的链路：出口那一段写入口报上来的在用出口（只走一台写名字，分给几台写「N 台出口」）；
        还没报的写一共几台，不再只写主出口的名字（看着像只走它）。
      */
      const via = trafficByRule.get(Number(rule?.id))?.exitTargetVia;
      const balanced = getTunnelLoadBalanceExitNames(tunnel, hosts).length > 0 ? getTunnelExitNames(tunnel, hosts).length : 0;
      const exitText = via && via.length === 1 ? via[0] : via && via.length > 1 ? `${via.length} 台出口` : balanced > 1 ? `${balanced} 台出口` : null;
      if (exitText && names.length > 0) return [...names.slice(0, -1), exitText];
      return names;
    }
    const group = forwardGroupById.get(Number(rule?.forwardGroupId || 0));
    if (!group) return [];
    if (category === "chain") {
      return (Array.isArray(group.members) ? group.members : [])
        .map((member: any) => String(hostById.get(Number(member?.hostId || 0))?.name || "").trim())
        .filter(Boolean);
    }
    return [String(group.name || "").trim()].filter(Boolean);
  };
  return { getRuleTransferDisplay, getRuleHopNames };
}
