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

/** 规则卡整链的两段（面板探的，server/exitTargetHealth.ts 的 RuleChainLatencyView）。 */
export type RuleChainLatencyLike = {
  exitHostId?: number | null;
  exitName?: string | null;
  exitMs?: number | null;
  targetMs?: number | null;
  share?: number | null;
};

type ProbeEntry = {
  latestLatencyAt?: unknown;
  latestLatencyMs?: unknown;
  latestLatencyIsTimeout?: unknown;
  latestLatencyChain?: RuleChainLatencyLike | null;
  latestLatencySource?: string | null;
};

const roundMs = (value: number) => `${Math.round(value)} ms`;

/**
 * 卡上延迟的悬停那句（两段都是面板探的）。规则卡的数一律是「整链」（入口→在用出口→目标），和诊断的合计同一口径：
 *   整链 9 ms = 入口到 hep ix 6 ms + hep ix 到目标 3 ms（面板探测，18:48）
 * 没有两段返回 null。totalMs：卡上那个数（服务端算好的整链）；不传时两段相加。
 */
export function describeRuleChainLatency(chain: RuleChainLatencyLike | null | undefined, totalMs?: number | null, at = ""): string | null {
  if (!chain) return null;
  const exitMs = typeof chain.exitMs === "number" && Number.isFinite(chain.exitMs) ? chain.exitMs : null;
  const targetMs = typeof chain.targetMs === "number" && Number.isFinite(chain.targetMs) ? chain.targetMs : null;
  if (exitMs === null || targetMs === null) return null;
  const name = String(chain.exitName || "").trim();
  const total = roundMs(typeof totalMs === "number" && Number.isFinite(totalMs) ? totalMs : exitMs + targetMs);
  const exit = roundMs(exitMs);
  const target = roundMs(targetMs);
  // 整句写全（不拼半句）：界面翻译按整句的模板套
  if (name) {
    return at
      ? `整链 ${total} = 入口到 ${name} ${exit} + ${name} 到目标 ${target}（面板探测，${at}）`
      : `整链 ${total} = 入口到 ${name} ${exit} + ${name} 到目标 ${target}（面板探测）`;
  }
  return at
    ? `整链 ${total} = 入口到出口 ${exit} + 出口到目标 ${target}（面板探测，${at}）`
    : `整链 ${total} = 入口到出口 ${exit} + 出口到目标 ${target}（面板探测）`;
}

function clockText(at: unknown, nowMs: number) {
  const date = at instanceof Date ? at : new Date(typeof at === "number" && at > 0 && at < 1_000_000_000_000 ? at * 1000 : at as string);
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date(nowMs);
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? hhmm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
}

/**
 * 规则卡延迟那一枚的悬停（不管哪种来历都写成「整链 …」）：
 *   两段都测到：见 describeRuleChainLatency
 *   最近一次诊断：整链 9 ms（最近一次诊断 18:48）
 *   定时探测：整链 9 ms（定时探测 18:48）
 *   只有在用出口探目标那段（主出口切走了）：整链 ≥ 4 ms：只有在用出口到目标那段……
 */
export function describeRuleLatency(probe: ProbeEntry | null | undefined, ms: number, nowMs = Date.now()): { title: string; atLeast: boolean } {
  const at = clockText(probe?.latestLatencyAt, nowMs);
  const chain = describeRuleChainLatency(probe?.latestLatencyChain, ms, at);
  if (chain) return { title: chain, atLeast: false };
  const source = String(probe?.latestLatencySource || "");
  const value = roundMs(ms);
  if (source === "exit-target") {
    return { title: `整链 ≥ ${value}：只有在用出口到目标那段，入口到出口那段没算（出口机探测${at ? ` ${at}` : ""}）`, atLeast: true };
  }
  if (source === "diagnosis") return { title: at ? `整链 ${value}（最近一次诊断 ${at}）` : `整链 ${value}（最近一次诊断）`, atLeast: false };
  return { title: at ? `整链 ${value}（定时探测 ${at}）` : `整链 ${value}（定时探测）`, atLeast: false };
}

export type RuleCardDerivedProps = {
  visualState: ForwardRuleVisualStatus["state"];
  visualTitle: string;
  /** 橙色是实际数据下的结论（负载均衡「有出口连不上、已切走」），不是「还在等」：橙点、不写「等待 Agent 应用」 */
  visualConfirmed?: boolean;
  /** 指定的出口不能用、已切到别的出口：通的，只让走势线变琥珀（forwardRuleStatus 的 pinBypassed） */
  visualPinBypassed?: boolean;
  /** 线路组那枚（没有线路组是 null）。policy 只在线路行展开时给：收着的时候用不上，给了反而每轮都是新对象。 */
  failover: { text: string; title: string; tone: string; policy: FailoverLineDisplay["policy"] | null } | null;
  totalIn: number;
  totalOut: number;
  hasTotal: boolean;
  dailyIn: number;
  dailyOut: number;
  spark: number[];
  routeBoard: RouteBoardStatus | undefined;
  /** liveTitle / atLeast：卡上延迟的悬停（「整链 …」，写明是面板两段相加 / 定时探测 / 最近一次诊断）、要不要写「≥」（describeRuleLatency） */
  probe: { at: boolean; stale: boolean; ageText: string; isTimeout: boolean; ms: number | null; liveTitle: string | null; atLeast: boolean };
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
  probeByRule: Map<number, ProbeEntry>;
  expandedEntryRuleIds: Set<number>;
  expandedLineRuleIds: Set<number>;
  isProbeFresh: (at: unknown) => boolean;
  probeAgeText: (at: unknown) => string;
};

const EMPTY_SPARK: number[] = [];

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
  const probe = sources.probeByRule.get(ruleId);
  const probeAt = probe?.latestLatencyAt;
  const probeStale = !!probeAt && !sources.isProbeFresh(probeAt);
  const probeMs = typeof probe?.latestLatencyMs === "number" && Number.isFinite(probe.latestLatencyMs) ? probe.latestLatencyMs : null;
  const live = probeMs !== null && !probe?.latestLatencyIsTimeout ? describeRuleLatency(probe, probeMs, nowMs) : null;
  const expiresAt = rule.expiresAt ? new Date(rule.expiresAt as string | number | Date).getTime() : NaN;
  return {
    visualState: visual.state,
    visualTitle: visual.title,
    visualConfirmed: !!visual.confirmed,
    visualPinBypassed: !!visual.pinBypassed,
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
      liveTitle: live?.title ?? null,
      atLeast: live?.atLeast ?? false,
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
  return a.at === b.at && a.stale === b.stale && a.ageText === b.ageText && a.isTimeout === b.isTimeout && a.ms === b.ms
    && a.liveTitle === b.liveTitle && a.atLeast === b.atLeast;
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
