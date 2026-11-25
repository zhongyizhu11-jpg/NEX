/*
  从 client/src/pages/Rules.tsx 第 5161-5264 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { getForwardGroupRouteLabel, getTunnelDisplay } from "../../pages/Rules";
import { TRAFFIC_MULTIPLIER_DEFAULT, formatTrafficMultiplier, normalizeTrafficMultiplier } from "@shared/trafficMultiplier";

export type UseRuleSelectOptionHelpersContext = {
  hosts: Array<any> | undefined;
  trafficBillingHostIds: Set<number>;
  trafficBillingTunnelIds: Set<number>;
  tunnelAvailabilityById: any /* 原类型 Map<number, LinkAvailabilityResult>… 引用了拿不到的 LinkAvailabilityResult，手动收拾 */;
  trafficBilling: any /* 原类型 { usableResourceIds: TrafficBillingResourceIds; hasUsableResources: boolean; ena… 引用了拿不到的 TrafficBillingResourceIds，手动收拾 */;
  trafficBillingForwardGroupIds: Set<number>;
};

export type UseRuleSelectOptionHelpersResult = {
  isTrafficBillingForwardGroup: (group: any) => any;
  getForwardGroupSelectName: (group: any) => string;
  renderTrafficMultiplierBadge: any /* 原类型 (value: unknown) => JSX.Element… 引用了拿不到的 JSX，手动收拾 */;
  renderTrafficBillingResourceBadge: any /* 原类型 (enabled?: boolean) => JSX.Element | null… 引用了拿不到的 JSX，手动收拾 */;
  getHostName: (hostId: number) => any;
  getTunnelSelectName: (tunnel: any) => string;
  getTunnelSelectText: (tunnel: any) => string;
  renderTunnelSelectLabel: any /* 原类型 (tunnel: any) => JSX.Element… 引用了拿不到的 JSX，手动收拾 */;
  getHostOptionText: (host: any) => string;
  renderHostStatusLabel: any /* 原类型 (host: any) => JSX.Element… 引用了拿不到的 JSX，手动收拾 */;
};

export function useRuleSelectOptionHelpers(ctx: UseRuleSelectOptionHelpersContext): UseRuleSelectOptionHelpersResult {
  const { hosts, trafficBillingHostIds, trafficBillingTunnelIds, tunnelAvailabilityById, trafficBilling, trafficBillingForwardGroupIds } = ctx;
  const getHostName = (hostId: number) => {
    return hosts?.find((h: any) => h.id === hostId)?.name || `主机 #${hostId}`;
  };
  const getHostOptionName = (host: any) => host?.name || `主机 #${host?.id || "-"}`;
  const renderTrafficBillingResourceBadge = (enabled = true) => enabled ? (
    <span className="shrink-0 rounded border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] px-1.5 py-0.5 text-[11px] font-medium leading-none text-[var(--fx-warn-text)]">
      按量计费资源
    </span>
  ) : null;
  const getHostOptionText = (host: any) => `${getHostOptionName(host)}（${host?.isOnline ? "在线" : "离线"}）${trafficBillingHostIds.has(Number(host?.id)) ? " / 按量计费资源" : ""}`;
  const renderHostStatusLabel = (host: any) => {
    const online = !!host?.isOnline;
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={getHostOptionText(host)}>
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            online
              ? "bg-[var(--fx-healthy)] shadow-[0_0_0_3px_var(--fx-healthy-soft)]"
              : "bg-[var(--fx-down)] shadow-[0_0_0_3px_var(--fx-down-soft)]"
          }`}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{getHostOptionName(host)}</span>
        {renderTrafficBillingResourceBadge(trafficBillingHostIds.has(Number(host?.id)))}
        <span className="sr-only">{online ? "在线" : "离线"}</span>
      </span>
    );
  };
  const getPortRangeText = (item: any) => {
    const start = Number(item?.portRangeStart || 0);
    const end = Number(item?.portRangeEnd || 0);
    return start > 0 && end > 0 ? `${start}-${end}` : "";
  };
  /*
    计费倍率徽标。

    以前不管倍率是多少都刷一层绿 —— 参数名都写成了 `_value`，说明它压根没看过
    这个值。而绿在这套面板里是「正常」的语义色，于是一条 5 倍计费的线路和一条
    1 倍的线路长得一模一样，还都透着「没问题」。

    倍率的意义是**这条线路的流量按几倍扣**，所以只有一种情况需要颜色：超过 1 倍，
    那是花钱的警告。等于 1 倍是默认，低于 1 倍是优惠 —— 两者都不必抢注意力。
  */
  const trafficMultiplierBadgeClass = (value: unknown) =>
    normalizeTrafficMultiplier(value) > TRAFFIC_MULTIPLIER_DEFAULT
      ? "border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] text-[var(--fx-warn-text)]"
      : "border-[var(--fx-stroke-base)] text-muted-foreground";
  const renderTrafficMultiplierBadge = (value: unknown) => (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${trafficMultiplierBadgeClass(value)}`}>
      {formatTrafficMultiplier(value)}
    </span>
  );
  const getTunnelSelectName = (tunnel: any) => String(tunnel?.name || `隧道 #${tunnel?.id || "-"}`);
  const getTunnelSelectModeLabel = (tunnel: any) => getTunnelDisplay(tunnel, true).shortLabel;
  const getTunnelSelectText = (tunnel: any) => [
    getTunnelSelectName(tunnel),
    getTunnelSelectModeLabel(tunnel),
    getPortRangeText(tunnel),
    formatTrafficMultiplier((tunnel as any)?.trafficMultiplier),
    trafficBillingTunnelIds.has(Number(tunnel?.id)) ? "按量计费资源" : "",
  ].filter(Boolean).join(" / ");
  const renderTunnelModeBadge = (tunnel: any) => (
    <span className="shrink-0 rounded border border-[color-mix(in_srgb,var(--fx-accent)_30%,transparent)] bg-[var(--fx-accent-soft)] px-1.5 py-0.5 text-[11px] font-medium leading-none text-[var(--fx-accent)]">
      {getTunnelSelectModeLabel(tunnel)}
    </span>
  );
  const getTunnelStatusText = (tunnel: any) => {
    const state = tunnelAvailabilityById.get(Number(tunnel?.id || 0));
    if (state?.status === "available") return "可用";
    if (state?.status === "degraded") return "部分可用";
    if (state?.status === "pending") return "等待检测";
    if (state?.status === "unavailable") return "不可用";
    return state?.message || "已停用";
  };
  const renderTunnelSelectStatusDot = (tunnel: any) => {
    const state = tunnelAvailabilityById.get(Number(tunnel?.id || 0));
    if (state?.status === "available") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" aria-hidden="true" />;
    if (state?.status === "degraded" || state?.status === "pending") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--fx-warn)] shadow-sm" aria-hidden="true" />;
    if (state?.status === "unavailable") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-destructive/70 shadow-sm shadow-destructive/40" aria-hidden="true" />;
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />;
  };
  const renderTunnelSelectLabel = (tunnel: any) => (
    <span className="inline-flex min-w-0 items-center gap-2" title={`${getTunnelStatusText(tunnel)} / ${getTunnelSelectText(tunnel)}`}>
      {renderTunnelSelectStatusDot(tunnel)}
      <span className="min-w-0 truncate">{getTunnelSelectName(tunnel)}</span>
      {renderTunnelModeBadge(tunnel)}
      {getPortRangeText(tunnel) && <span className="shrink-0 rounded border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">{getPortRangeText(tunnel)}</span>}
      {renderTrafficMultiplierBadge((tunnel as any).trafficMultiplier)}
      {renderTrafficBillingResourceBadge(trafficBillingTunnelIds.has(Number(tunnel?.id)))}
      <span className="sr-only">{getTunnelStatusText(tunnel)}</span>
    </span>
  );
  const getForwardGroupSelectName = (group: any) => String(group?.name || `${getForwardGroupRouteLabel(group)} #${group?.id || "-"}`);
  const isTrafficBillingForwardGroup = (group: any) => {
    if (!trafficBilling?.enabled || !group) return false;
    if (trafficBillingForwardGroupIds.has(Number(group.id))) return true;
    const members = Array.isArray(group.members) ? group.members : [];
    return members.some((member: any) => {
      if (!member || member.isEnabled === false) return false;
      if (member.memberType === "host") return trafficBillingHostIds.has(Number(member.hostId || 0));
      if (member.memberType === "tunnel") return trafficBillingTunnelIds.has(Number(member.tunnelId || 0));
      return false;
    });
  };
  return { isTrafficBillingForwardGroup, getForwardGroupSelectName, renderTrafficMultiplierBadge, renderTrafficBillingResourceBadge, getHostName, getTunnelSelectName, getTunnelSelectText, renderTunnelSelectLabel, getHostOptionText, renderHostStatusLabel };
}
