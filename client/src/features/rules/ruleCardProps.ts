import type { RouteBoardStatus } from "@/features/rules/RouteBoard";
import { describeFailoverLineDisplay, type FailoverLineDisplay } from "@/lib/failoverLineDisplay";
import type { ForwardRuleVisualStatus } from "@/lib/forwardRuleStatus";

/*
  规则卡（Rules.tsx 里的 RuleCard，React.memo）除了规则本身以外要的那些「这一张卡自己的」派生值，
  以及 memo 的比较函数。单独一个文件、不碰 React，是为了能在 node 里测「一次轮询只改了一条规则，
  就只有那一张卡的 props 变了」（ruleCardProps.test.ts）。

  规矩：传原始值（数字、字符串、布尔）；对象要么是查询数据里结构共享过的原物（线路板状态），
  要么拆成原始值；和当前时间有关的（探测过没过期、多久以前、到没到期、线路组「几点起」）在这里按
  nowMs 算好，卡片自己不读时钟。
*/

type RuleLike = {
  id?: unknown;
  hostId?: unknown;
  expiresAt?: unknown;
  [key: string]: unknown;
};

type TrafficTotals = { bytesIn?: number | null; bytesOut?: number | null };

type ProbeEntry = {
  latestLatencyAt?: unknown;
  latestLatencyMs?: unknown;
  latestLatencyIsTimeout?: unknown;
};

export type RuleCardDerivedProps = {
  visualState: ForwardRuleVisualStatus["state"];
  visualTitle: string;
  /** 线路组那枚（没有线路组是 null）。policy 只在线路行展开时给：收着的时候用不上，给了反而每轮都是新对象。 */
  failover: { text: string; title: string; tone: string; policy: FailoverLineDisplay["policy"] | null } | null;
  totalIn: number;
  totalOut: number;
  hasTotal: boolean;
  dailyIn: number;
  dailyOut: number;
  spark: number[];
  routeBoard: RouteBoardStatus | undefined;
  probe: { at: boolean; stale: boolean; ageText: string; isTimeout: boolean; ms: number | null };
  /** 到没到期：翻过去的那一刻卡片要重画（RuleLimitSummary 按当下时间写「已于…到期」）。 */
  expiryPassed: boolean;
  entriesExpanded: boolean;
  linesOpen: boolean;
};

export type RuleCardDerivedSources = {
  /** ruleVisualStatuses 里那份 display（带「上次状态」兜底）；没有就现算。 */
  visualDisplay: (ruleId: number) => ForwardRuleVisualStatus | undefined;
  resolveVisual: (rule: RuleLike) => ForwardRuleVisualStatus;
  hostById: Map<number, unknown>;
  routeBoardByRule: Map<number, unknown>;
  totalTrafficByRule: Map<unknown, TrafficTotals>;
  dailyTrafficByRule: Map<unknown, TrafficTotals>;
  sparkByRule: Map<number, number[]>;
  stableProbeByRule: Map<number, ProbeEntry>;
  expandedEntryRuleIds: Set<number>;
  expandedLineRuleIds: Set<number>;
  isProbeFresh: (at: unknown) => boolean;
  probeAgeText: (at: unknown) => string;
};

export const EMPTY_SPARK: number[] = [];

export function buildRuleCardDerivedProps(rule: RuleLike, sources: RuleCardDerivedSources, nowMs = Date.now()): RuleCardDerivedProps {
  const ruleId = Number(rule.id);
  const visual = sources.visualDisplay(ruleId) || sources.resolveVisual(rule);
  const failoverDisplay = describeFailoverLineDisplay(
    rule as Parameters<typeof describeFailoverLineDisplay>[0],
    sources.hostById.get(Number(rule.hostId)) as Parameters<typeof describeFailoverLineDisplay>[1],
    nowMs,
  );
  const routeBoard = sources.routeBoardByRule.get(ruleId) as RouteBoardStatus | undefined;
  const linesOpen = sources.expandedLineRuleIds.has(ruleId);
  // 流量表的 key 是数字 id，原来卡片直接拿 rule.id 去查，这里照旧
  const total = sources.totalTrafficByRule.get(rule.id);
  const daily = sources.dailyTrafficByRule.get(rule.id);
  const probe = sources.stableProbeByRule.get(ruleId);
  const probeAt = probe?.latestLatencyAt;
  const probeStale = !!probeAt && !sources.isProbeFresh(probeAt);
  const probeMs = typeof probe?.latestLatencyMs === "number" && Number.isFinite(probe.latestLatencyMs) ? probe.latestLatencyMs : null;
  const expiresAt = rule.expiresAt ? new Date(rule.expiresAt as string | number | Date).getTime() : NaN;
  return {
    visualState: visual.state,
    visualTitle: visual.title,
    failover: failoverDisplay ? {
      text: failoverDisplay.text,
      title: failoverDisplay.title,
      tone: failoverDisplay.tone,
      policy: linesOpen && routeBoard ? failoverDisplay.policy : null,
    } : null,
    totalIn: Number(total?.bytesIn || 0),
    totalOut: Number(total?.bytesOut || 0),
    hasTotal: !!total,
    dailyIn: Number(daily?.bytesIn || 0),
    dailyOut: Number(daily?.bytesOut || 0),
    spark: sources.sparkByRule.get(ruleId) || EMPTY_SPARK,
    routeBoard,
    probe: {
      at: !!probeAt,
      stale: probeStale,
      ageText: probeStale ? sources.probeAgeText(probeAt) : "",
      isTimeout: !!probe?.latestLatencyIsTimeout,
      ms: probeMs,
    },
    expiryPassed: Number.isFinite(expiresAt) && expiresAt <= nowMs,
    entriesExpanded: sources.expandedEntryRuleIds.has(ruleId),
    linesOpen,
  };
}

function sameNumbers(a: number[], b: number[]) {
  return a === b || (a.length === b.length && a.every((value, index) => value === b[index]));
}

function sameFailover(a: RuleCardDerivedProps["failover"], b: RuleCardDerivedProps["failover"]) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.text === b.text && a.title === b.title && a.tone === b.tone && a.policy === b.policy;
}

function sameProbe(a: RuleCardDerivedProps["probe"], b: RuleCardDerivedProps["probe"]) {
  return a.at === b.at && a.stale === b.stale && a.ageText === b.ageText && a.isTimeout === b.isTimeout && a.ms === b.ms;
}

/**
 * RuleCard 的 memo 比较：大多按引用 / 原始值比；走势线、线路组、探测这三包是每轮新建的小对象，按内容比。
 * 别的 props（rule、sortable、page）一律按引用。
 */
export function ruleCardPropsEqual<P extends RuleCardDerivedProps>(prev: P, next: P) {
  const keys = Object.keys(next) as Array<keyof P>;
  if (keys.length !== Object.keys(prev).length) return false;
  for (const key of keys) {
    if (key === "spark") {
      if (!sameNumbers(prev.spark, next.spark)) return false;
    } else if (key === "failover") {
      if (!sameFailover(prev.failover, next.failover)) return false;
    } else if (key === "probe") {
      if (!sameProbe(prev.probe, next.probe)) return false;
    } else if (prev[key] !== next[key]) {
      return false;
    }
  }
  return true;
}
