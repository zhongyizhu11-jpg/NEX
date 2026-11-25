/*
  从 client/src/pages/Rules.tsx 第 2602-2660 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { usePanelFlags } from "@/hooks/usePanelFlags";
import { isForwardGroupBackedRouteModeValue, type RuleCardRule, type RuleFormData, type RuleResourceRow } from "../../pages/Rules";
import { type RuleRouteTab } from "@/features/rules/routeModeHints";
import { isAggregateLinkTunnel } from "@shared/aggregateLink";
import { FORWARD_PROTOCOL_LABELS, FORWARD_TYPE_LABELS, TUNNEL_PROTOCOLS, type ForwardProtocolKey, type ForwardType } from "@shared/forwardTypes";
import { useCallback, useMemo } from "react";

export type UseRuleProtocolSupportContext = {
  form: RuleFormData;
  isLegacyLocalRuleEdit: boolean;
  hosts: Array<RuleResourceRow> | undefined;
  panelFlags: Pick<ReturnType<typeof usePanelFlags>, "forwardProtocols">;
  tunnels: Array<RuleResourceRow> | undefined;
};

export type UseRuleProtocolSupportResult = {
  isRuleSupported: (rule: RuleCardRule) => boolean;
  isProtocolEnabled: (key: ForwardProtocolKey | null | undefined) => boolean;
  getTunnelProtocolKey: (tunnel: RuleResourceRow | null | undefined) => ForwardProtocolKey | null;
  supportedTunnels: Array<RuleResourceRow>;
  availableTunnels: Array<RuleResourceRow>;
  aggregateTunnels: Array<RuleResourceRow>;
  plainTunnels: Array<RuleResourceRow>;
  selectedTunnel: RuleResourceRow;
  selectedTunnelIsAggregate: boolean;
  routeTab: RuleRouteTab;
  selectedHost: RuleResourceRow;
  nginxTunnelEnabled: boolean;
  forwardTypeDisplayLabel: (forwardType: unknown) => string;
  getRuleProtocolKey: (rule: RuleCardRule) => ForwardProtocolKey | null;
  protocolUnsupportedLabel: (protocolKey: ForwardProtocolKey | null | undefined) => string;
};

export function useRuleProtocolSupport(ctx: UseRuleProtocolSupportContext): UseRuleProtocolSupportResult {
  const { form, isLegacyLocalRuleEdit, hosts, panelFlags, tunnels } = ctx;
  const selectedHost = useMemo(() => {
    if (isForwardGroupBackedRouteModeValue(form.routeMode, form.forwardGroupId) || (isLegacyLocalRuleEdit && form.routeMode === "local")) return null;
    if (!form.hostId || !hosts) return null;
    return hosts.find((h: RuleResourceRow) => h.id === form.hostId) || null;
  }, [form.forwardGroupId, form.hostId, form.routeMode, hosts, isLegacyLocalRuleEdit]);
  const forwardProtocolSettings = panelFlags.forwardProtocols;
  const nginxTunnelEnabled = forwardProtocolSettings.nginx_stream !== false;
  const protocolUnsupportedLabel = useCallback((protocolKey: ForwardProtocolKey | null | undefined) => {
    const genericLabel = "\u8be5\u534f\u8bae";
    if (!protocolKey) return genericLabel;
    if (protocolKey === "nginx" && forwardProtocolSettings.nginx === false) return genericLabel;
    if (protocolKey === "nginx_stream" && !nginxTunnelEnabled) return genericLabel;
    return FORWARD_PROTOCOL_LABELS[protocolKey] || genericLabel;
  }, [forwardProtocolSettings.nginx, nginxTunnelEnabled]);
  const forwardTypeDisplayLabel = useCallback((forwardType: unknown) => {
    const type = String(forwardType || "");
    if (type === "nginx" && forwardProtocolSettings.nginx === false) return "\u8f6c\u53d1\u5de5\u5177";
    return FORWARD_TYPE_LABELS[type as ForwardType] || type || "-";
  }, [forwardProtocolSettings.nginx]);

  const isProtocolEnabled = useCallback((key: ForwardProtocolKey | null | undefined) => {
    if (!key) return false;
    return forwardProtocolSettings[key] !== false;
  }, [forwardProtocolSettings]);
  const getTunnelProtocolKey = useCallback((tunnel: RuleResourceRow | null | undefined): ForwardProtocolKey | null => {
    const mode = String(tunnel?.mode || "").toLowerCase();
    return (TUNNEL_PROTOCOLS as readonly string[]).includes(mode)
      ? mode as ForwardProtocolKey
      : null;
  }, []);
  const getRuleProtocolKey = useCallback((rule: RuleCardRule): ForwardProtocolKey | null => {
    if (rule.forwardType === "gost" && rule.tunnelId) {
      const tunnel = tunnels?.find((t: RuleResourceRow) => Number(t.id) === Number(rule.tunnelId));
      return getTunnelProtocolKey(tunnel);
    }
    return rule.forwardType as ForwardProtocolKey;
  }, [getTunnelProtocolKey, tunnels]);
  const isRuleSupported = useCallback((rule: RuleCardRule) => isProtocolEnabled(getRuleProtocolKey(rule)), [getRuleProtocolKey, isProtocolEnabled]);
  const supportedTunnels = useMemo(
    () => (tunnels || []).filter((t: RuleResourceRow) => isProtocolEnabled(getTunnelProtocolKey(t))),
    [getTunnelProtocolKey, isProtocolEnabled, tunnels]
  );
  /*
    「隧道转发」和「叠加」两个标签底下都是隧道转发（routeMode 都是 tunnel），只是各列各的隧道：
    叠加列单连接叠加的 NEX 隧道（shared/aggregateLink.ts），隧道转发列其余的。选中的是哪种就在哪个标签。
  */
  const plainTunnels = useMemo(() => supportedTunnels.filter((t: RuleResourceRow) => !isAggregateLinkTunnel(t)), [supportedTunnels]);
  const aggregateTunnels = useMemo(() => supportedTunnels.filter((t: RuleResourceRow) => isAggregateLinkTunnel(t)), [supportedTunnels]);
  const selectedTunnel = useMemo(() => {
    if (!form.tunnelId || !tunnels) return null;
    return tunnels.find((t: RuleResourceRow) => t.id === form.tunnelId) || null;
  }, [form.tunnelId, tunnels]);
  const selectedTunnelIsAggregate = isAggregateLinkTunnel(selectedTunnel);
  const routeTab: RuleRouteTab = form.routeMode === "tunnel" && selectedTunnelIsAggregate ? "aggregate" : form.routeMode;
  const availableTunnels = useMemo(() => {
    if (form.routeMode === "tunnel") return selectedTunnelIsAggregate ? aggregateTunnels : plainTunnels;
    if (!form.hostId) return [];
    return supportedTunnels.filter((t: RuleResourceRow) => t.entryHostId === form.hostId);
  }, [aggregateTunnels, form.hostId, form.routeMode, plainTunnels, selectedTunnelIsAggregate, supportedTunnels]);
  return { isRuleSupported, isProtocolEnabled, getTunnelProtocolKey, supportedTunnels, availableTunnels, aggregateTunnels, plainTunnels, selectedTunnel, selectedTunnelIsAggregate, routeTab, selectedHost, nginxTunnelEnabled, forwardTypeDisplayLabel, getRuleProtocolKey, protocolUnsupportedLabel };
}
