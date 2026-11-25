/*
  从 client/src/pages/Rules.tsx 第 2791-2869 行抽出（scripts/extract-block.mjs），行为不变。
*/
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";
import { getForwardGroupRuleForwardType, type RuleFormData, type RulePageUser, type RuleResourceRow, type RuleRouteMode } from "../../pages/Rules";
import { FORWARD_TYPES, type ForwardProtocolKey, type ForwardType } from "@shared/forwardTypes";
import { sniInboundChoices, type SniInboundChoice, type SniRuleRouteKind } from "@shared/tlsInbound";
import { useMemo } from "react";

export type UseRuleCreateCapabilitiesContext = {
  form: RuleFormData;
  isForwardGroupRouteMode: boolean;
  selectedForwardGroup: RuleResourceRow;
  user: RulePageUser;
  isProtocolEnabled: (key: ForwardProtocolKey | null | undefined) => boolean;
  trafficBilling: inferRouterOutputs<AppRouter>["trafficBilling"]["status"] | undefined;
  hosts: Array<RuleResourceRow> | undefined;
  availablePortForwardGroups: Array<RuleResourceRow>;
  hasTrafficBillingBalance: boolean;
  tlsInboundOptions: Array<{ id: number; hostId: number; hostName: string; name: string; port: number; isEnabled: boolean; allowedSni: Array<string>; agentVersion: string; agentSupported: boolean; routedAgentSupported: boolean; usable: boolean; tunnelIds: Array<number>; forwardGroupIds: Array<number>; }>;
  availableTunnels: Array<RuleResourceRow>;
  availableForwardChainGroups: Array<RuleResourceRow>;
  availableFailoverForwardGroups: Array<RuleResourceRow>;
  tlsInboundById: Map<number, RuleResourceRow>;
  supportedTunnels: Array<RuleResourceRow>;
};

export type UseRuleCreateCapabilitiesResult = {
  canUseLocalForward: boolean;
  canUseGost: boolean;
  canUseSavedLocalForward: boolean;
  availableTrafficBillingHosts: Array<RuleResourceRow>;
  usableForwardTypes: Array<"iptables" | "nftables" | "realm" | "socat" | "gost" | "nginx">;
  canUseBillingHostLocalForward: boolean;
  canUseForwardChain: boolean;
  canUseFailoverGroup: boolean;
  canUseSniInbound: boolean;
  usableTlsInbounds: Array<RuleResourceRow>;
  effectiveRouteForwardType: "iptables" | "nftables" | "realm" | "socat" | "gost" | "nginx";
  isSniEntryMode: boolean;
  /** 共享 TLS 入站行在页面里还是宽类型，所以选项的 inbound 用 RuleResourceRow */
  sniChoices: Array<SniInboundChoice<RuleResourceRow>>;
  selectedTlsInbound: RuleResourceRow | null;
  sniRouteKind: SniRuleRouteKind;
  trafficBillingHostIds: Set<number>;
  trafficBillingTunnelIds: Set<number>;
  trafficBillingForwardGroupIds: Set<number>;
  sniAvailableForTab: (mode: RuleRouteMode) => boolean;
  canCreateRule: boolean;
};

export function useRuleCreateCapabilities(ctx: UseRuleCreateCapabilitiesContext): UseRuleCreateCapabilitiesResult {
  const { form, isForwardGroupRouteMode, selectedForwardGroup, user, isProtocolEnabled, trafficBilling, hosts, availablePortForwardGroups, hasTrafficBillingBalance, tlsInboundOptions, availableTunnels, availableForwardChainGroups, availableFailoverForwardGroups, tlsInboundById, supportedTunnels } = ctx;
  const effectiveRouteForwardType = useMemo<ForwardType>(() => {
    if (form.routeMode === "tunnel") return "gost";
    if (isForwardGroupRouteMode) {
      return getForwardGroupRuleForwardType(selectedForwardGroup, form.forwardType);
    }
    return form.forwardType;
  // form.forwardGroupId 不在函数体里读，但换了转发组就要重算（selectedForwardGroup 是 any，lint 看不出依赖），搬过来时原样保留
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.forwardGroupId, form.forwardType, form.routeMode, isForwardGroupRouteMode, selectedForwardGroup]);
  /**
   * 当前用户被允许使用的转发方式。
   * - 管理员：不受限制（返回全部）
   * - 普通用户：读 (user as any).allowedForwardTypes，空表示全部
   */
  const allowedForwardTypes: ForwardType[] = useMemo(() => {
    const all = [...FORWARD_TYPES];
    if (!user || user.role === "admin") return all;
    const raw = (user as unknown as { allowedForwardTypes?: string | null }).allowedForwardTypes;
    if (!raw || !raw.trim()) return all;
    const set = new Set(raw.split(",").map((s: string) => s.trim()));
    const filtered = all.filter(t => set.has(t));
    return filtered.length > 0 ? filtered : all;
  }, [user]);
  const usableForwardTypes = useMemo(
    () => allowedForwardTypes.filter((t) => isProtocolEnabled(t)),
    [allowedForwardTypes, isProtocolEnabled]
  );
  const trafficBillingHostIds = useMemo(() => {
    const ids = (trafficBilling?.usableResourceIds?.hostIds || []) as Array<number | string>;
    return new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0));
  }, [trafficBilling?.usableResourceIds]);
  const trafficBillingTunnelIds = useMemo(() => {
    const ids = (trafficBilling?.usableResourceIds?.tunnelIds || []) as Array<number | string>;
    return new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0));
  }, [trafficBilling?.usableResourceIds]);
  const trafficBillingForwardGroupIds = useMemo(() => {
    const ids = (trafficBilling?.usableResourceIds?.forwardGroupIds || []) as Array<number | string>;
    return new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0));
  }, [trafficBilling?.usableResourceIds]);
  const availableTrafficBillingHosts = useMemo(
    () => (hosts || []).filter((host: RuleResourceRow) => trafficBillingHostIds.has(Number(host.id))),
    [hosts, trafficBillingHostIds]
  );
  const canUseSavedLocalForward = availablePortForwardGroups.length > 0;
  const canUseBillingHostLocalForward = user?.role !== "admin" && hasTrafficBillingBalance && availableTrafficBillingHosts.length > 0 && usableForwardTypes.length > 0;
  const usableTlsInbounds = useMemo(
    () => (tlsInboundOptions as RuleResourceRow[]).filter((inbound: RuleResourceRow) => inbound.usable && inbound.isEnabled),
    [tlsInboundOptions],
  );
  const canUseSniInbound = usableTlsInbounds.length > 0 && usableForwardTypes.length > 0;
  const isSniEntryMode = form.entryMode === "sni";
  /** SNI 规则怎么走：端口转发页签是直连（选了端口转发资源就是经资源），其余页签经隧道 / 转发资源。 */
  const sniRouteKind: SniRuleRouteKind = form.routeMode === "tunnel"
    ? "tunnel"
    : form.routeMode === "chain" || form.routeMode === "group" || Number(form.forwardGroupId || 0) > 0
    ? "group"
    : "direct";
  const sniChoices = useMemo(() => {
    const keep = { inboundId: form.tlsInboundId, forwardGroupId: form.routeMode === "local" ? form.forwardGroupId : null };
    if (form.routeMode === "tunnel") return sniInboundChoices(tlsInboundOptions, { kind: "tunnel", tunnelId: form.tunnelId }, keep);
    if (form.routeMode === "chain" || form.routeMode === "group") {
      return sniInboundChoices(tlsInboundOptions, { kind: "group", forwardGroupId: form.forwardGroupId }, { ...keep, forwardGroupId: form.forwardGroupId });
    }
    return sniInboundChoices(tlsInboundOptions, { kind: "direct", portGroupIds: availablePortForwardGroups.map((group) => Number(group.id)) }, keep);
  }, [tlsInboundOptions, form.routeMode, form.tunnelId, form.forwardGroupId, form.tlsInboundId, availablePortForwardGroups]);
  /** 某个页签有没有能经它用的共享 TLS 入站（决定要不要显示「入口方式」那一行）。 */
  const sniAvailableForTab = (mode: RuleRouteMode) => {
    const options = tlsInboundOptions;
    const viaTunnel = (tunnelId: number) => options.some((inbound) => inbound.isEnabled && (inbound.tunnelIds || []).includes(tunnelId));
    const viaGroup = (groupId: number) => options.some((inbound) => inbound.isEnabled && (inbound.forwardGroupIds || []).includes(groupId));
    if (mode === "tunnel") return availableTunnels.some((tunnel) => viaTunnel(Number(tunnel.id)));
    if (mode === "chain") return availableForwardChainGroups.some((group) => viaGroup(Number(group.id)));
    if (mode === "group") return availableFailoverForwardGroups.some((group) => viaGroup(Number(group.id)));
    return canUseSniInbound || availablePortForwardGroups.some((group) => viaGroup(Number(group.id)));
  };
  const selectedTlsInbound = isSniEntryMode && form.tlsInboundId ? tlsInboundById.get(Number(form.tlsInboundId)) || null : null;
  const canUseLocalForward = canUseSavedLocalForward || canUseBillingHostLocalForward || canUseSniInbound;
  const canUseGost = allowedForwardTypes.includes("gost") && supportedTunnels.length > 0;
  const canUseForwardChain = availableForwardChainGroups.length > 0;
  const canUseFailoverGroup = availableFailoverForwardGroups.length > 0;
  const canCreateRule = canUseLocalForward || canUseGost || canUseForwardChain || canUseFailoverGroup;
  return { canUseLocalForward, canUseGost, canUseSavedLocalForward, availableTrafficBillingHosts, usableForwardTypes, canUseBillingHostLocalForward, canUseForwardChain, canUseFailoverGroup, canUseSniInbound, usableTlsInbounds, effectiveRouteForwardType, isSniEntryMode, sniChoices, selectedTlsInbound, sniRouteKind, trafficBillingHostIds, trafficBillingTunnelIds, trafficBillingForwardGroupIds, sniAvailableForTab, canCreateRule };
}
