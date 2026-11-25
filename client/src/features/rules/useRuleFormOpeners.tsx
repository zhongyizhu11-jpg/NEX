/*
  从 client/src/pages/Rules.tsx 第 2949-3185 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { defaultForm, getForwardGroupRuleForwardType, isForwardChainGroup, normalizeRuleProtocol, type RuleCardRule, type RuleFormData, type RuleProtocol, type RuleResourceRow, type RuleRouteMode } from "../../pages/Rules";
import { DEFAULT_RULE_EGRESS_FORM } from "@/components/rules/RuleEgressSection";
import { newRuleLimitsForm } from "@/components/rules/RuleLimitsForm";
import { type RuleRouteTab } from "@/features/rules/routeModeHints";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { formatPortSpan, isPortRangeRule, ruleSourcePortEnd } from "@shared/portRange";
import { routeGroupOf } from "@shared/routeGroup";
import { routeLinesForEditor } from "@shared/routeLines";
import { normalizeRuleEgressType } from "@shared/ssEgress";
import { parseSniNameJson } from "@shared/tlsInbound";
import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";

export type UseRuleFormOpenersContext = {
  form: RuleFormData;
  setInlineLinkOpen: Dispatch<SetStateAction<boolean>>;
  canUseLocalForward: boolean;
  canUseGost: boolean;
  canUseSavedLocalForward: boolean;
  availablePortForwardGroups: Array<RuleResourceRow>;
  availableForwardChainGroups: Array<RuleResourceRow>;
  availableFailoverForwardGroups: Array<RuleResourceRow>;
  aggregateTunnels: Array<RuleResourceRow>;
  plainTunnels: Array<RuleResourceRow>;
  selectedTunnel: RuleResourceRow;
  availableTrafficBillingHosts: Array<RuleResourceRow>;
  selectedForwardGroup: RuleResourceRow;
  usableForwardTypes: Array<"iptables" | "nftables" | "realm" | "socat" | "gost" | "nginx">;
  latestPortCheckRef: RefObject<number>;
  setPortStatus: Dispatch<SetStateAction<"used" | "idle" | "checking" | "available">>;
  setPortRangeError: Dispatch<SetStateAction<string | null>>;
  setForm: Dispatch<SetStateAction<RuleFormData>>;
  selectedTunnelIsAggregate: boolean;
  setEditingId: Dispatch<SetStateAction<number | null>>;
  setEditingLimitBaseline: Dispatch<SetStateAction<RuleCardRule | null>>;
  setEditingOriginalProtocol: Dispatch<SetStateAction<RuleProtocol | null>>;
  setLegacyLocalRuleEditId: Dispatch<SetStateAction<number | null>>;
  canUseBillingHostLocalForward: boolean;
  supportedTunnels: Array<RuleResourceRow>;
  canUseForwardChain: boolean;
  canUseFailoverGroup: boolean;
  setShowDialog: Dispatch<SetStateAction<boolean>>;
  canUseSniInbound: boolean;
  usableTlsInbounds: Array<RuleResourceRow>;
  forwardGroups: Array<RuleResourceRow> | undefined;
  setShowAdvanced: Dispatch<SetStateAction<boolean>>;
  setShowEgress: Dispatch<SetStateAction<boolean>>;
  setShowRouteGroup: Dispatch<SetStateAction<boolean>>;
};

export type UseRuleFormOpenersResult = {
  resetForm: () => void;
  openCreate: (preferredRouteMode?: RuleRouteMode) => void;
  openEdit: (rule: RuleCardRule) => void;
  setRouteMode: (mode: RuleRouteMode, aggregate?: boolean) => void;
  selectRouteTab: (tab: RuleRouteTab) => void;
};

export function useRuleFormOpeners(ctx: UseRuleFormOpenersContext): UseRuleFormOpenersResult {
  const { form, setInlineLinkOpen, canUseLocalForward, canUseGost, canUseSavedLocalForward, availablePortForwardGroups, availableForwardChainGroups, availableFailoverForwardGroups, aggregateTunnels, plainTunnels, selectedTunnel, availableTrafficBillingHosts, selectedForwardGroup, usableForwardTypes, latestPortCheckRef, setPortStatus, setPortRangeError, setForm, selectedTunnelIsAggregate, setEditingId, setEditingLimitBaseline, setEditingOriginalProtocol, setLegacyLocalRuleEditId, canUseBillingHostLocalForward, supportedTunnels, canUseForwardChain, canUseFailoverGroup, setShowDialog, canUseSniInbound, usableTlsInbounds, forwardGroups, setShowAdvanced, setShowEgress, setShowRouteGroup } = ctx;
  const setRouteMode = (mode: RuleRouteMode, aggregate = false) => {
    if (mode === form.routeMode) return;
    /*
      换了走法，展开着的建线路表单就不再对应了（隧道的表单在「转发链」下
      毫无意义）。直接收起来，而不是让它留在那儿显示上一种线路的字段。
    */
    setInlineLinkOpen(false);
    if (mode === "local" && !canUseLocalForward) return;
    if (mode === "tunnel" && !canUseGost) return;
    const localUsesSavedForward = mode === "local" && canUseSavedLocalForward;
    const nextGroups = localUsesSavedForward
      ? availablePortForwardGroups
      : mode === "chain"
      ? availableForwardChainGroups
      : mode === "group"
      ? availableFailoverForwardGroups
      : [];
    // 「隧道转发」「叠加」各从自己那一类隧道里挑。
    const tunnelPool = aggregate ? aggregateTunnels : plainTunnels;
    const nextTunnel = mode === "tunnel"
      ? ((selectedTunnel && tunnelPool.includes(selectedTunnel) ? selectedTunnel : tunnelPool[0]) || null)
      : null;
    const usesForwardGroup = mode === "chain" || mode === "group" || localUsesSavedForward;
    const nextBillingHost = mode === "local" && !localUsesSavedForward
      ? (availableTrafficBillingHosts.find((host: RuleResourceRow) => Number(host.id) === Number(form.hostId)) || availableTrafficBillingHosts[0] || null)
      : null;
    if (mode === "tunnel" && !nextTunnel) return;
    if (usesForwardGroup && nextGroups.length === 0) return;
    if (mode === "local" && !usesForwardGroup && !nextBillingHost) return;
    const expectedGroupMode = mode === "local" ? "port" : mode === "chain" ? "chain" : "failover";
    const nextGroup = usesForwardGroup
      ? (selectedForwardGroup && forwardGroupModeOf(selectedForwardGroup) === expectedGroupMode ? selectedForwardGroup : nextGroups[0])
      : null;
    const nextDirectForwardType = usableForwardTypes.includes(form.forwardType) ? form.forwardType : usableForwardTypes[0];
    const nextForwardType = mode === "tunnel"
      ? "gost"
      : usesForwardGroup
      ? getForwardGroupRuleForwardType(nextGroup, usableForwardTypes.includes(form.forwardType) ? form.forwardType : usableForwardTypes[0])
      : nextDirectForwardType;
    if (!nextForwardType) return;
    latestPortCheckRef.current += 1;
    setPortStatus("idle");
    setPortRangeError(null);
    setForm((prev) => ({
      ...prev,
      routeMode: mode,
      // 换页签回到独立端口：上一个页签选的入站多半不在新页签的资源上。
      entryMode: "port",
      tlsInboundId: null,
      forwardType: nextForwardType,
      tunnelId: mode === "tunnel" && nextTunnel ? Number(nextTunnel.id) : null,
      forwardGroupId: usesForwardGroup && nextGroup ? Number(nextGroup.id) : null,
      hostId: mode === "tunnel" && nextTunnel
        ? nextTunnel.entryHostId
        : usesForwardGroup
        ? null
        : availableTrafficBillingHosts.some((host: RuleResourceRow) => Number(host.id) === Number(prev.hostId))
        ? prev.hostId
        : (Number(nextBillingHost?.id || 0) || null),
      failoverEnabled: false,
    }));
  };
  /** 顶上的标签：「隧道转发」「叠加」都落到隧道转发，在两类隧道之间换只换选中的隧道。 */
  const selectRouteTab = (tab: RuleRouteTab) => {
    if (tab !== "tunnel" && tab !== "aggregate") {
      setRouteMode(tab);
      return;
    }
    const wantAggregate = tab === "aggregate";
    if (form.routeMode !== "tunnel") {
      setRouteMode("tunnel", wantAggregate);
      return;
    }
    if (selectedTunnelIsAggregate === wantAggregate && form.tunnelId) return;
    const next = (wantAggregate ? aggregateTunnels : plainTunnels)[0];
    if (!next) return;
    setInlineLinkOpen(false);
    setForm((prev) => ({ ...prev, tunnelId: Number(next.id), hostId: next.entryHostId }));
  };

  const resetForm = () => {
    setForm({ ...defaultForm });
    setEditingId(null);
    setEditingLimitBaseline(null);
    setEditingOriginalProtocol(null);
    setLegacyLocalRuleEditId(null);
    setPortStatus("idle");
    setInlineLinkOpen(false);
  };

  const openCreate = (preferredRouteMode?: RuleRouteMode) => {
    resetForm();
    const firstPortGroup = canUseSavedLocalForward ? availablePortForwardGroups[0] : null;
    const firstLocalForwardType = firstPortGroup ? getForwardGroupRuleForwardType(firstPortGroup, defaultForm.forwardType) : null;
    const firstBillingHost = canUseBillingHostLocalForward ? availableTrafficBillingHosts[0] : null;
    const firstDirectForwardType = usableForwardTypes.includes(defaultForm.forwardType) ? defaultForm.forwardType : usableForwardTypes[0];
    // 新建默认落在「隧道转发」：先挑普通隧道，只有叠加时才用叠加。
    const firstTunnel = canUseGost
      ? (plainTunnels[0] || supportedTunnels[0])
      : null;
    const firstChain = canUseForwardChain ? availableForwardChainGroups[0] : null;
    const firstGroup = canUseFailoverGroup ? availableFailoverForwardGroups[0] : null;
    const hasSavedLocalForward = !!firstPortGroup && !!firstLocalForwardType;
    const hasBillingHostLocalForward = !!firstBillingHost && !!firstDirectForwardType;
    if (preferredRouteMode === "local") {
      if (hasSavedLocalForward) {
        setForm({
          ...defaultForm,
          routeMode: "local",
          hostId: null,
          forwardType: firstLocalForwardType,
          tunnelId: null,
          forwardGroupId: Number(firstPortGroup.id),
        });
        setShowDialog(true);
        return;
      }
      if (hasBillingHostLocalForward) {
        setForm({
          ...defaultForm,
          routeMode: "local",
          hostId: Number(firstBillingHost.id),
          forwardType: firstDirectForwardType,
          tunnelId: null,
          forwardGroupId: null,
        });
        setShowDialog(true);
        return;
      }
      if (canUseSniInbound) {
        const inbound = usableTlsInbounds[0];
        setForm({
          ...defaultForm,
          routeMode: "local",
          entryMode: "sni",
          tlsInboundId: Number(inbound.id),
          hostId: Number(inbound.hostId),
          forwardType: firstDirectForwardType,
          protocol: "tcp",
        });
        setShowDialog(true);
        return;
      }
      toast.error("暂无可用端口转发，请检查链路配置、授权或计费余额");
      return;
    }
    if (!hasSavedLocalForward && !hasBillingHostLocalForward && canUseSniInbound && !firstTunnel && !firstChain && !firstGroup) {
      openCreate("local");
      return;
    }
    if (hasSavedLocalForward || hasBillingHostLocalForward || firstTunnel || firstChain || firstGroup) {
      const routeMode: RuleRouteMode = hasSavedLocalForward || hasBillingHostLocalForward ? "local" : firstTunnel ? "tunnel" : firstChain ? "chain" : "group";
      const localUsesSavedForward = routeMode === "local" && hasSavedLocalForward;
      setForm({
        ...defaultForm,
        routeMode,
        hostId: routeMode === "tunnel" && firstTunnel
          ? firstTunnel.entryHostId
          : routeMode === "local" && !localUsesSavedForward && firstBillingHost
          ? Number(firstBillingHost.id)
          : null,
        forwardType: routeMode === "tunnel"
          ? "gost"
          : routeMode === "group" && firstGroup
          ? getForwardGroupRuleForwardType(firstGroup, "iptables")
          : routeMode === "local" && localUsesSavedForward
          ? firstLocalForwardType
          : routeMode === "local"
          ? firstDirectForwardType
          : "iptables",
        tunnelId: routeMode === "tunnel" && firstTunnel ? firstTunnel.id : null,
        forwardGroupId: routeMode === "local" && localUsesSavedForward && firstPortGroup ? Number(firstPortGroup.id) : routeMode === "chain" && firstChain ? Number(firstChain.id) : routeMode === "group" && firstGroup ? Number(firstGroup.id) : null,
      });
    } else {
      toast.error("暂无可用转发资源，请检查链路配置、授权或计费余额");
      return;
    }
    setShowDialog(true);
  };

  const openEdit = (rule: RuleCardRule) => {
    const editForwardGroup = rule.forwardGroupId
      ? (forwardGroups || []).find((group: RuleResourceRow) => Number(group.id) === Number(rule.forwardGroupId))
      : null;
    const isSniRule = Number(rule.tlsInboundId || 0) > 0;
    const isLegacyLocalRule = !isSniRule
      && !Number(rule.forwardGroupId || 0)
      && !(rule.forwardType === "gost" && Number(rule.tunnelId || 0) > 0);
    setForm({
      hostId: rule.hostId,
      name: rule.name,
      routeMode: rule.forwardGroupId ? (forwardGroupModeOf(editForwardGroup) === "port" ? "local" : isForwardChainGroup(editForwardGroup) ? "chain" : "group") : rule.forwardType === "gost" && rule.tunnelId ? "tunnel" : "local",
      forwardType: rule.forwardType,
      protocol: rule.protocol,
      tunnelId: rule.tunnelId || null,
      forwardGroupId: rule.forwardGroupId || null,
      sourcePort: rule.sourcePort,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
      // 段规则把整段写回端口框，段尾从原文解析。目标框写起点就够了（段长跟着入口）。
      sourcePortText: isPortRangeRule(rule) ? formatPortSpan(rule.sourcePort, ruleSourcePortEnd(rule)) : null,
      targetPortText: null,
      targetNodeId: Number(rule.proxyNodeId || 0) > 0 ? Number(rule.proxyNodeId) : null,
      telegramErrorNotifyEnabled: !!rule.telegramErrorNotifyEnabled,
      entryDomainEnabled: rule.entryDomainEnabled !== false,
      failoverEnabled: !!rule.failoverEnabled,
      // 老主备（2.3.376 之前配的）在这里被读成路径清单：备用各是一条直连的路径。
      // 线路定义（2.3.496）：存了就用，老数据由路径推成「每条路径一条线路」，编辑框统一按线路编辑。
      routeGroup: (() => {
        const group = routeGroupOf(rule);
        return group ? { ...group, lines: routeLinesForEditor(rule, group.paths) } : null;
      })(),
      entryMode: isSniRule ? "sni" : "port",
      tlsInboundId: isSniRule ? Number(rule.tlsInboundId) : null,
      sniNamesText: isSniRule ? parseSniNameJson(rule.sniNames).join("\n") : "",
      egress: normalizeRuleEgressType(rule.egressType) === "none"
        ? DEFAULT_RULE_EGRESS_FORM
        : {
          egressType: normalizeRuleEgressType(rule.egressType),
          egressHostId: Number(rule.egress?.landingHostId || 0) || null,
          egressInboundId: Number(rule.egressInboundId || 0) || null,
          egressLink: "",
          egressLinkMasked: String(rule.egress?.masked || ""),
          egressUdp: !!rule.egressUdp,
        },
      limits: newRuleLimitsForm(rule),
    });
    setEditingId(rule.id);
    setEditingLimitBaseline(rule);
    setEditingOriginalProtocol(normalizeRuleProtocol(rule.protocol));
    setLegacyLocalRuleEditId(isLegacyLocalRule ? Number(rule.id) : null);
    setPortStatus("idle");
    setShowAdvanced(false);
    setShowEgress(false);
    setShowRouteGroup(false);
    setShowDialog(true);
  };
  return { resetForm, openCreate, openEdit, setRouteMode, selectRouteTab };
}
