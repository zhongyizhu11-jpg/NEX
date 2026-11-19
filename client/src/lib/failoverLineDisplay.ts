import {
  describeGroupRoutePolicy,
  describeRoutePolicy,
  describeRoutePolicyReport,
  type GroupRoutePolicyOptions,
  type RoutePolicy,
  type RoutePolicyGroup,
  type RoutePolicyHost,
  type RoutePolicyReportText,
} from "@shared/routePolicy";
import { routeStrategyLabel } from "@shared/routeGroup";

/**
 * 规则行上那一小块主备状态该说什么。
 *
 * 原来列表上只有一个「主备 2」的计数徽标 —— 它回答的是「配了几条」，而人想
 * 知道的是「现在走的是哪条」。配了主备和没配主备在列表上长得几乎一样，等于
 * 这个功能配完就看不见了。
 *
 * 判断全在 shared/routePolicy：走哪条、这份报告能信到什么程度、走的是不是按规矩
 * 该走的那条。这里只管压成徽标上的几个字和一个颜色。颜色不按「是不是在备用上」定 ——
 * 晚上按时段表走备用 1 是排好的，不是出事；没走首选才值得看一眼。
 */

export type FailoverLineTone = RoutePolicyReportText["tone"];

/** 徽标的颜色。规则卡、转发组卡片共用一份：同一种状态不能在两张卡上是两个颜色。 */
export const FAILOVER_TONE_CLASS: Record<FailoverLineTone, string> = {
  normal: "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] text-[var(--fx-healthy-text)]",
  deviated: "border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
  warn: "border-destructive/40 text-destructive",
  muted: "border-border text-muted-foreground",
};

export type FailoverLineDisplay = {
  /** 徽标上的短文案。 */
  text: string;
  /** 鼠标悬停/读屏用的完整说明。 */
  title: string;
  tone: FailoverLineTone;
  policy: RoutePolicy;
};

export function describeFailoverLineDisplay(
  rule: Parameters<typeof describeRoutePolicy>[0],
  host?: RoutePolicyHost,
  nowMs?: number,
): FailoverLineDisplay | null {
  const policy = describeRoutePolicy(rule, { host, nowMs });
  if (!policy) return null;
  const report = describeRoutePolicyReport(policy, { nowMs });
  // 8 种分配方式的名字（同时分的说分法，其余是「主备」），和编辑框同一套
  const label = routeStrategyLabel(policy, true);
  const activeIndex = policy.report.kind === "current" ? policy.report.index : null;
  return {
    // 还不知道走哪条时报路径条数：「混合 · 3 条」比「混合 2」（备用条数）看得懂。
    text: activeIndex !== null ? `${label} · ${policy.lines[activeIndex].label}` : `${label} · ${policy.lines.length} 条`,
    // 每一句自己带句号，只有第一句（「现在走 备用 1，21:30 起」）是短语，补一个。
    title: `${report.text}。${report.note || ""}${policy.divergence || ""}`,
    tone: report.tone,
    policy,
  };
}

/**
 * 转发组卡片上那一小块：域名现在解析到哪个成员。
 *
 * 原来卡片上只有成员胶囊，绿色的意思是「这个成员能用」，不是「解析指向它」—— 三个都是
 * 绿的时候，看不出域名到底指着谁，只能去 DNS 服务商后台查。组停用了不给：卡片上已经写着停用。
 */
export function describeGroupPolicyDisplay(group: RoutePolicyGroup, options: GroupRoutePolicyOptions = {}): FailoverLineDisplay | null {
  const policy = describeGroupRoutePolicy(group, options);
  if (!policy || policy.report.kind === "groupDisabled") return null;
  const report = describeRoutePolicyReport(policy, options);
  const kind = policy.report;
  const text = kind.kind === "resolved"
    ? `解析 · ${policy.lines[kind.index].label}`
    : kind.kind === "suggested"
      ? `建议 · ${policy.lines[kind.index].label}`
      : kind.kind === "noDomain"
        ? "不切换"
        : "未选出入口";
  return {
    text,
    // 转发组的警告（比如「眼下没有健康的成员」）也要进悬停说明：徽标上只有几个字。
    title: `${report.text}。${report.note || ""}${policy.divergence || ""}${policy.warnings.join("")}`,
    tone: report.tone,
    policy,
  };
}
