import assert from "node:assert/strict";
import test from "node:test";
import { replaceEqualDeep } from "@tanstack/react-query";

import { reuseStableRows } from "@/lib/stableRows";
import { buildRuleCardDerivedProps, ruleCardPropsEqual, type RuleCardDerivedProps, type RuleCardDerivedSources } from "./ruleCardProps";

/*
  规则卡是 React.memo 的（Rules.tsx 的 RuleCard）：props 比得上就不重画。这里把规则页一轮轮询
  走一遍 —— 规则列表（带 Date）经 React Query 结构共享 + useStableRows，流量 / 走势 / 探测 / 状态表
  每轮按页面里 useMemo 的写法从头新建 —— 再按 renderRuleCard 的方式拼出每张卡的 props，
  看 memo 的比较函数放行了谁：只改了一条规则的那一轮，应该只有那一张卡要重画。
*/
type Row = { id: number; name: string; hostId: number; createdAt: Date; updatedAt: Date; expiresAt?: Date | null; isEnabled: boolean };

const fetchRules = (overrides: Partial<Record<number, Partial<Row>>> = {}): Row[] => [1, 2, 3, 4].map((id) => ({
  id,
  name: `rule-${id}`,
  hostId: 10 + id,
  createdAt: new Date(`2026-01-0${id}T00:00:00Z`),
  updatedAt: new Date(`2026-02-0${id}T00:00:00Z`),
  expiresAt: id === 4 ? new Date("2026-11-03T12:00:00Z") : null,
  isEnabled: true,
  ...overrides[id],
}));

type Poll = { traffic: Record<number, number>; probeMs: Record<number, number>; probeAt: number; visual?: Record<number, string> };

/** 和 Rules.tsx 里那几个 useMemo 一样：每轮都从头建表，值相同对象也是新的。 */
function sourcesFor(poll: Poll): RuleCardDerivedSources {
  const total = new Map<unknown, { bytesIn: number; bytesOut: number }>();
  const daily = new Map<unknown, { bytesIn: number; bytesOut: number }>();
  const spark = new Map<number, number[]>();
  const probes = new Map<number, { latestLatencyAt: Date; latestLatencyMs: number; latestLatencyIsTimeout: boolean }>();
  const visuals = new Map<number, { state: "running" | "error"; title: string }>();
  for (const id of [1, 2, 3, 4]) {
    const bytes = poll.traffic[id] ?? 1000;
    total.set(id, { bytesIn: bytes, bytesOut: bytes / 2 });
    daily.set(id, { bytesIn: bytes / 10, bytesOut: bytes / 20 });
    spark.set(id, new Array(24).fill(0).map((_, index) => (index === 23 ? bytes : 0)));
    probes.set(id, { latestLatencyAt: new Date(poll.probeAt), latestLatencyMs: poll.probeMs[id] ?? 40, latestLatencyIsTimeout: false });
    const state = poll.visual?.[id] === "error" ? "error" : "running";
    visuals.set(id, { state, title: state === "error" ? "出错" : "运行中" });
  }
  return {
    visualDisplay: (ruleId) => visuals.get(ruleId),
    resolveVisual: () => ({ state: "pending", title: "待确认" }),
    hostById: new Map([[11, { id: 11 }], [12, { id: 12 }], [13, { id: 13 }], [14, { id: 14 }]]),
    routeBoardByRule: new Map(),
    totalTrafficByRule: total,
    dailyTrafficByRule: daily,
    sparkByRule: spark,
    stableProbeByRule: probes,
    expandedEntryRuleIds: new Set(),
    expandedLineRuleIds: new Set(),
    isProbeFresh: (at) => NOW - new Date(at as Date).getTime() < 10 * 60_000,
    probeAgeText: (at) => `${Math.round((NOW - new Date(at as Date).getTime()) / 60_000)} 分钟前`,
  };
}

let NOW = Date.parse("2026-11-03T10:00:00Z");
const page = { ui: {}, compact: false };
const key = (row: Row) => row.id;
type CardProps = RuleCardDerivedProps & { rule: Row; page: typeof page };

function cardsFor(rows: Row[], poll: Poll) {
  const sources = sourcesFor(poll);
  return rows.map((rule): CardProps => ({ rule, page, ...buildRuleCardDerivedProps(rule, sources, NOW) }));
}

function rerendered(prev: CardProps[], next: CardProps[]) {
  return next.filter((props, index) => !ruleCardPropsEqual(prev[index], props)).map((props) => props.rule.id);
}

test("一轮轮询只改了一条规则的流量：只有那张卡要重画", () => {
  const basePoll: Poll = { traffic: {}, probeMs: {}, probeAt: NOW - 60_000 };
  const r1 = reuseStableRows<Row>(null, replaceEqualDeep(undefined, fetchRules()), key);
  const cards1 = cardsFor(r1.rows, basePoll);

  // 什么都没变（规则行的 Date 也是新对象）：一张都不重画
  const r2 = reuseStableRows(r1, replaceEqualDeep(r1.rows, fetchRules()), key);
  const cards2 = cardsFor(r2.rows, basePoll);
  assert.deepEqual(rerendered(cards1, cards2), []);

  // 规则 2 的流量涨了
  const cards3 = cardsFor(r2.rows, { ...basePoll, traffic: { 2: 5000 } });
  assert.deepEqual(rerendered(cards2, cards3), [2]);

  // 规则 3 的延迟变了、规则 1 出错了
  const cards4 = cardsFor(r2.rows, { ...basePoll, traffic: { 2: 5000 }, probeMs: { 3: 88 }, visual: { 1: "error" } });
  assert.deepEqual(rerendered(cards3, cards4), [1, 3]);
});

test("规则本身改了（列表轮询带回新名字）：只有那张卡要重画", () => {
  const poll: Poll = { traffic: {}, probeMs: {}, probeAt: NOW - 60_000 };
  const r1 = reuseStableRows<Row>(null, replaceEqualDeep(undefined, fetchRules()), key);
  const r2 = reuseStableRows(r1, replaceEqualDeep(r1.rows, fetchRules({ 4: { name: "renamed" } })), key);
  assert.deepEqual(rerendered(cardsFor(r1.rows, poll), cardsFor(r2.rows, poll)), [4]);
});

test("和时间有关的跟着时间走：探测过期、到期那一刻，对应的卡会重画", () => {
  const poll: Poll = { traffic: {}, probeMs: {}, probeAt: NOW - 9 * 60_000 };
  const rows = reuseStableRows<Row>(null, fetchRules(), key).rows;
  const before = cardsFor(rows, poll);
  NOW += 2 * 60_000 + 12 * 60 * 60_000; // 探测过了 10 分钟的新鲜期；规则 4 也过了到期时间
  const after = cardsFor(rows, poll);
  assert.deepEqual(rerendered(before, after), [1, 2, 3, 4]);
  assert.equal(after[0].probe.stale, true);
  assert.equal(after[3].expiryPassed, true);
  assert.equal(after[0].expiryPassed, false);
  // 时间没再走、数据也没变：不重画（「多久以前」那几个字变了才会）
  const later = cardsFor(rows, poll);
  assert.deepEqual(rerendered(after, later), []);
});

test("比较函数：走势线按内容比，线路组、探测按字段比，其余按引用", () => {
  const base = cardsFor(reuseStableRows<Row>(null, fetchRules(), key).rows, { traffic: {}, probeMs: {}, probeAt: NOW })[0];
  const policy = {} as NonNullable<RuleCardDerivedProps["failover"]>["policy"];
  const withFailover = { ...base, failover: { text: "主备 · 主线路", title: "t", tone: "normal", policy: null } };
  assert.equal(ruleCardPropsEqual(withFailover, { ...withFailover, failover: { ...withFailover.failover } }), true);
  assert.equal(ruleCardPropsEqual(withFailover, { ...withFailover, failover: { ...withFailover.failover, text: "主备 · 备用 1" } }), false);
  assert.equal(ruleCardPropsEqual(withFailover, { ...withFailover, failover: { ...withFailover.failover, policy } }), false, "展开线路行要的 policy 按引用");
  assert.equal(ruleCardPropsEqual(base, { ...base, spark: [...base.spark] }), true);
  assert.equal(ruleCardPropsEqual(base, { ...base, spark: base.spark.map((value, index) => (index === 0 ? value + 1 : value)) }), false);
  assert.equal(ruleCardPropsEqual(base, { ...base, page: { ...page } }), false, "page 换了引用：一页的卡全重画");
  assert.equal(ruleCardPropsEqual(base, { ...base, rule: { ...base.rule } }), false);
});
