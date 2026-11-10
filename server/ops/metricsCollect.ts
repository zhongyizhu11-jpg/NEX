/*
  指标导出的取数：把面板已经有的批量查询和内存态拼成一份快照（server/ops/metricsFamilies.ts 再把它写成指标）。

  ── 查多少次库 ──
  和规则、主机的数量无关，一轮固定十几条语句，全是面板页面本来就在用的批量查询：
    · 主机：主机列表、每台最新一条指标、累计流量（公开监控页同一套）；
    · 规则：规则列表、累计流量（规则页「累计」）、最近一次探测（规则页「24 小时」那条，带着延迟回来）；
    · 线路组：评分、在用哪条、中转断没断全在内存里（routeGroupStats），只有近 24 小时切换次数查一次库。
  没有任何一步是「每条规则查一次」。规则多于上限时连规则列表都不整表读，只数个数。
  速率（ruleLiveRates）、主机负载（hostLoad）、主机实时指标（hostLiveMetrics）直接读内存。

  ── 数据库不可用时 ──
  不去碰库（每条查询都要等连接超时），只回面板自己知道的：版本、nex_database_up 0。
  主机、规则这些序列这一轮没有 —— 不是 0，是没有。

  整份结果由 server/ops/metricsRoute.ts 缓存 10 秒，所以这里不用再各自缓存。
*/
import { and, eq, inArray } from "drizzle-orm";
import { forwardRules } from "../../drizzle/schema";
import { APP_VERSION } from "../../shared/versions";
import { describeFailoverActiveLine } from "../../shared/failoverActiveLine";
import { routeGroupOf, routePathLabel, type RouteGroupRule } from "../../shared/routeGroup";
import { databaseHealth } from "../databaseHealthState";
import { boolLiteral, epochSeconds, quoteIdentifier as q } from "../dbCompat";
import { getDatabaseKind, getDb, queryRaw } from "../dbRuntime";
import { getHostLiveMetric } from "../hostLiveMetrics";
import { hostLoadPctOf } from "../hostLoad";
import { getForwardRules } from "../repositories/forwardRuleRepository";
import { getHosts } from "../repositories/hostRepository";
import {
  getHostTrafficSummary,
  getLatestHostMetricRows,
  getTotalTraffic,
  getTrafficCounterSummaryByRule,
  getTrafficSummaryByRule,
} from "../repositories/metricsRepository";
import { dbBool } from "../repositories/repositoryUtils";
import { getRouteStatus, routeHopDownHints, routeNodeHints, routePathDownstreamMs } from "../routeGroupStats";
import { ensureRouteNodeHealthFresh, getRouteNodeStatus } from "../routeNodeHealth";
import { getRuleLiveRate } from "../ruleLiveRates";
import {
  MonotonicTotal,
  type MetricsHostSample,
  type MetricsRoutePathSample,
  type MetricsRouteSample,
  type MetricsRuleSample,
  type MetricsSnapshot,
} from "./metricsFamilies";

type Row = Record<string, unknown>;

/** 一条 IN 里最多放多少个规则 id：三种数据库的参数上限都远高于它，留着余量给一条语句里用好几遍的情况。 */
const RULE_ID_BATCH = 500;
/** 最近一次探测超过这么久就不再导出：停用的规则会一直留着停用前那次的结果。 */
const PROBE_STALE_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const num = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const numOrNull = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const text = (value: unknown) => String(value ?? "").trim();

function millis(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) out.push(items.slice(offset, offset + size));
  return out;
}

// ---------------------------------------------------------------- 主机

async function collectHosts(nowMs: number): Promise<MetricsHostSample[]> {
  const rows = (await getHosts()) as Row[];
  const ids = rows.map((row) => num(row.id)).filter((id) => id > 0);
  const [metricRows, trafficRows] = await Promise.all([
    getLatestHostMetricRows(ids) as Promise<Row[]>,
    // 不带主机筛选：一条不带 IN 的查询，没有计数器的主机不出现在结果里。
    getHostTrafficSummary() as Promise<Row[]>,
  ]);
  const metricByHost = new Map(metricRows.map((row) => [num(row.hostId), row]));
  const trafficByHost = new Map(trafficRows.map((row) => [num(row.hostId), row]));
  return rows.filter((row) => num(row.id) > 0).map((row) => {
    const id = num(row.id);
    const online = row.isOnline === true;
    const heartbeatAt = millis(row.lastHeartbeat);
    // 实时样本（8 秒内的心跳 / 实时通道）比库里那条新；没有就用库里最新一条。离线机器的旧数不报。
    const vitals: Row | null = online ? ((getHostLiveMetric(id, nowMs) as Row | null) ?? metricByHost.get(id) ?? null) : null;
    const traffic = trafficByHost.get(id);
    return {
      id,
      name: text(row.name) || `主机 ${id}`,
      online,
      heartbeatAgeSeconds: heartbeatAt > 0 ? Math.max(0, Math.round((nowMs - heartbeatAt) / 1000)) : null,
      agentVersion: text(row.agentVersion),
      cpuPct: numOrNull(vitals?.cpuUsage),
      memoryPct: numOrNull(vitals?.memoryUsage),
      diskPct: numOrNull(vitals?.diskUsage),
      loadPct: online ? hostLoadPctOf(id, nowMs) : null,
      tcpConnections: numOrNull(vitals?.tcpConnections),
      udpConnections: numOrNull(vitals?.udpConnections),
      trafficIn: traffic ? num(traffic.bytesIn) : null,
      trafficOut: traffic ? num(traffic.bytesOut) : null,
    };
  });
}

// ---------------------------------------------------------------- 规则

/**
 * 规则总数 / 启用数 / 在跑数，一条聚合语句。口径和规则列表（getForwardRules）一致：不含待删除的、
 * 线路组的中继规则、转发组成员引用的规则；转发组的模板算一条，它在各台成员机上的子规则不单独算，
 * 但只要有一条子规则在跑，模板就算在跑。
 */
async function collectRuleCounts(): Promise<{ total: number; enabled: number; running: number }> {
  const yes = boolLiteral(true);
  const no = boolLiteral(false);
  const child = `COALESCE(r.${q("forwardGroupRuleId")}, 0)`;
  const rows = await queryRaw<Row>(
    `SELECT COUNT(DISTINCT CASE WHEN ${child} = 0 THEN r.${q("id")} END) AS ${q("total")},
            COUNT(DISTINCT CASE WHEN ${child} = 0 AND r.${q("isEnabled")} = ${yes} THEN r.${q("id")} END) AS ${q("enabled")},
            COUNT(DISTINCT CASE WHEN r.${q("isRunning")} = ${yes} THEN (CASE WHEN ${child} > 0 THEN r.${q("forwardGroupRuleId")} ELSE r.${q("id")} END) END) AS ${q("running")}
       FROM ${q("forward_rules")} r
      WHERE COALESCE(r.${q("pendingDelete")}, ${no}) = ${no}
        AND COALESCE(r.${q("routeParentRuleId")}, 0) = 0
        AND r.${q("id")} NOT IN (SELECT ${q("ruleId")} FROM ${q("forward_group_members")} WHERE ${q("ruleId")} IS NOT NULL)`,
  );
  const row = rows[0] || {};
  return { total: num(row.total), enabled: num(row.enabled), running: num(row.running) };
}

/** 一批转发组模板在各台成员机上的子规则（没在删的），按模板 id 分好。 */
async function loadTemplateChildren(templateIds: readonly number[]): Promise<Map<number, Row[]>> {
  const byTemplate = new Map<number, Row[]>();
  if (templateIds.length === 0) return byTemplate;
  const db = await getDb();
  if (!db) return byTemplate;
  for (const batch of chunks(templateIds, RULE_ID_BATCH)) {
    const rows = (await db.select().from(forwardRules).where(and(
      inArray(forwardRules.forwardGroupRuleId, batch),
      eq(forwardRules.pendingDelete, false),
    ))) as Row[];
    for (const row of rows) {
      const parent = num(row.forwardGroupRuleId);
      const list = byTemplate.get(parent);
      if (list) list.push(row);
      else byTemplate.set(parent, [row]);
    }
  }
  return byTemplate;
}

type RuleTraffic = { bytesIn: number; bytesOut: number; connections: number };
type RuleProbe = { latencyMs: number | null; timeout: boolean; at: number };

async function loadRuleTraffic(ruleIds: readonly number[]): Promise<Map<number, RuleTraffic>> {
  const byRule = new Map<number, RuleTraffic>();
  for (const batch of chunks(ruleIds, RULE_ID_BATCH)) {
    // 一条规则可能有几行（每台上报的机器一行），加起来；转发组的子规则已经并到模板上了。
    for (const row of await getTrafficCounterSummaryByRule({ ruleIds: batch })) {
      const current = byRule.get(row.ruleId) || { bytesIn: 0, bytesOut: 0, connections: 0 };
      current.bytesIn += row.bytesIn;
      current.bytesOut += row.bytesOut;
      current.connections += row.connections;
      byRule.set(row.ruleId, current);
    }
  }
  return byRule;
}

/**
 * 每条规则最近一次探测。走规则页同一条批量查询（它把转发组、隧道、多跳链路的延迟怎么算都处理好了），
 * 流量窗口只给一分钟：这里要的是它带回来的延迟，窗口越短那一半越便宜。
 */
async function loadRuleProbes(ruleIds: readonly number[], nowMs: number): Promise<Map<number, RuleProbe>> {
  const byRule = new Map<number, RuleProbe>();
  for (const batch of chunks(ruleIds, RULE_ID_BATCH)) {
    const rows = await getTrafficSummaryByRule({ ruleIds: batch, since: new Date(nowMs - 60_000), includeLatency: true });
    for (const row of rows) {
      const at = millis(row.latestLatencyAt);
      if (at <= 0 || nowMs - at > PROBE_STALE_MS) continue;
      const previous = byRule.get(row.ruleId);
      if (previous && previous.at >= at) continue;
      byRule.set(row.ruleId, { latencyMs: numOrNull(row.latestLatencyMs), timeout: !!row.latestLatencyIsTimeout, at });
    }
  }
  return byRule;
}

/** 这条规则此刻的速率。转发组模板自己不跑，取它各台子规则里最大的那份（同一股流量不重复加，和 ruleLiveRates 对多台机器的口径一样）。 */
function liveRateOf(ruleId: number, children: readonly Row[], nowMs: number) {
  let best = getRuleLiveRate(ruleId, nowMs);
  for (const child of children) {
    const rate = getRuleLiveRate(num(child.id), nowMs);
    if (rate && (!best || rate.inBps + rate.outBps > best.inBps + best.outBps)) best = rate;
  }
  return best;
}

async function collectRules(rows: readonly Row[], children: Map<number, Row[]>, hostNames: Map<number, string>, nowMs: number): Promise<MetricsRuleSample[]> {
  const ids = rows.map((row) => num(row.id)).filter((id) => id > 0);
  const [traffic, probes] = await Promise.all([loadRuleTraffic(ids), loadRuleProbes(ids, nowMs)]);
  return rows.filter((row) => num(row.id) > 0).map((row) => {
    const id = num(row.id);
    const mine = children.get(id) || [];
    const usage = traffic.get(id);
    const probe = probes.get(id);
    const rate = liveRateOf(id, mine, nowMs);
    return {
      id,
      name: text(row.name) || `规则 ${id}`,
      hostName: hostNames.get(num(row.hostId)) || "",
      enabled: dbBool(row.isEnabled),
      running: dbBool(row.isRunning) || mine.some((child) => dbBool(child.isRunning)),
      trafficIn: usage ? usage.bytesIn : null,
      trafficOut: usage ? usage.bytesOut : null,
      connectionsTotal: usage ? usage.connections : null,
      rateIn: rate ? rate.inBps : null,
      rateOut: rate ? rate.outBps : null,
      probeLatencyMs: probe ? probe.latencyMs : null,
      probeTimeout: probe ? probe.timeout : null,
    };
  });
}

// ---------------------------------------------------------------- 线路组

/**
 * 模板真正在跑、在上报评分的那条子规则。和线路详情（routeStatusView 的 routeStatusSubject）同一个挑法：
 * 启用的优先，其次最近有 Agent 上报的，再其次在跑的、最早建的。不是模板或还没展开，就是它自己。
 */
function routeSubject(rule: Row, children: readonly Row[], nowMs: number): Row {
  if (!dbBool(rule.isForwardGroupTemplate)) return rule;
  const candidates = children.filter((child) => num(child.sourcePort) > 0);
  if (candidates.length === 0) return rule;
  const reportedAt = (child: Row) => {
    const status = getRouteStatus(num(child.id), nowMs);
    return (status.agent || status.staleAgent)?.reportedAt ?? 0;
  };
  return candidates
    .map((child) => ({ child, at: reportedAt(child), running: dbBool(child.isRunning), enabled: child.isEnabled === undefined ? true : dbBool(child.isEnabled) }))
    .sort((left, right) => (
      Number(right.enabled) - Number(left.enabled)
      || right.at - left.at
      || Number(right.running) - Number(left.running)
      || num(left.child.id) - num(right.child.id)
    ))[0].child;
}

/** 这些规则近 24 小时各切了几次线路（只数 switch），一条分组语句。 */
async function loadSwitchCounts(ruleIds: readonly number[], nowMs: number): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const batch of chunks(ruleIds, RULE_ID_BATCH)) {
    const rows = await queryRaw<Row>(
      `SELECT ${q("ruleId")} AS ${q("ruleId")}, COUNT(*) AS ${q("count")}
         FROM ${q("forward_rule_route_events")}
        WHERE ${q("kind")} = 'switch' AND ${q("createdAt")} >= ? AND ${q("ruleId")} IN (${batch.map(() => "?").join(",")})
        GROUP BY ${q("ruleId")}`,
      [epochSeconds(new Date(nowMs - DAY_MS)), ...batch],
    );
    for (const row of rows) counts.set(num(row.ruleId), num(row.count));
  }
  return counts;
}

async function collectRoutes(rows: readonly Row[], children: Map<number, Row[]>, hostNames: Map<number, string>, nowMs: number): Promise<MetricsRouteSample[]> {
  if (rows.length === 0) return [];
  await ensureRouteNodeHealthFresh();
  /*
    切换记录记在哪：Agent 报的记在真正在跑的那条上（模板的每台子规则），面板上的指定 / 暂停记在模板上。
    所以一条规则的次数 = 它自己的 + 它所有子规则的（和线路详情的 routeLineDataRuleIds 同一个口径）。
  */
  const eventRuleIds = new Set<number>();
  for (const row of rows) {
    eventRuleIds.add(num(row.id));
    for (const child of children.get(num(row.id)) || []) eventRuleIds.add(num(child.id));
  }
  const switchCounts = await loadSwitchCounts(Array.from(eventRuleIds).filter((id) => id > 0), nowMs).catch(() => null);
  const routes: MetricsRouteSample[] = [];
  for (const row of rows) {
    const id = num(row.id);
    const mine = children.get(id) || [];
    const subject = routeSubject(row, mine, nowMs);
    const group = routeGroupOf(subject as RouteGroupRule, { nowMs }) || routeGroupOf(row as RouteGroupRule, { nowMs });
    if (!group) continue;
    const subjectId = num(subject.id);
    const status = getRouteStatus(subjectId, nowMs);
    // 评分只用 10 分钟内的：再旧就不是「此刻」了。在用哪条在旧快照里也还作数（界面也是这么显示的）。
    const fresh = status.agent;
    const hopHints = routeHopDownHints(subjectId, group.paths, nowMs);
    const nodeHints = routeNodeHints(group.paths, getRouteNodeStatus);
    const reported = describeFailoverActiveLine(subject as Parameters<typeof describeFailoverActiveLine>[0]);
    const activeIndex = fresh && fresh.activeIndex >= 0 ? fresh.activeIndex : (reported ? reported.index : -1);
    const paths: MetricsRoutePathSample[] = group.paths.map((path, index) => {
      const target = fresh?.targets.find((item) => item.index === index) || null;
      const down = !!target?.down || hopHints.has(path.key) || nodeHints.has(path.key) || !!path.issue || (!!target && !target.healthy);
      return {
        key: path.key,
        name: routePathLabel(path, index),
        score: target?.score ?? null,
        latencyMs: typeof target?.latencyMs === "number" ? target.latencyMs + routePathDownstreamMs(subjectId, path, nowMs) : null,
        lossPct: target ? target.lossPct : null,
        jitterMs: target ? target.jitterMs : null,
        availabilityPct: target ? target.availabilityPct : null,
        active: activeIndex === index,
        down,
      };
    });
    routes.push({
      ruleId: id,
      ruleName: text(row.name) || `规则 ${id}`,
      hostName: hostNames.get(num(subject.hostId)) || hostNames.get(num(row.hostId)) || "",
      paths,
      switches24h: switchCounts
        ? [id, ...mine.map((child) => num(child.id))].reduce((total, ruleId) => total + (switchCounts.get(ruleId) || 0), 0)
        : null,
    });
  }
  return routes;
}

// ---------------------------------------------------------------- 整份

let trafficIn = new MonotonicTotal();
let trafficOut = new MonotonicTotal();

export type MetricsCollectOptions = {
  /** 规则（线路组规则）多于这个数就不逐条取，见 metricsFamilies.ts。 */
  maxRules: number;
  nowMs?: number;
};

/** 一步出错只丢那一段，别的照常：某张表正好锁着，不该让整份指标都没了。 */
async function section<T>(name: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    console.warn(`[Metrics] ${name} 这一段没取到：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function collectMetricsSnapshot(options: MetricsCollectOptions): Promise<MetricsSnapshot> {
  const startedAt = Date.now();
  const nowMs = options.nowMs ?? startedAt;
  const health = databaseHealth.snapshot();
  const snapshot: MetricsSnapshot = {
    panel: { version: APP_VERSION, databaseKind: String(getDatabaseKind() || health.databaseType || "unknown"), databaseUp: health.state === "healthy" },
    hosts: null,
    ruleCounts: null,
    rules: null,
    routes: null,
    traffic: null,
    collectSeconds: 0,
  };
  const finish = () => {
    snapshot.collectSeconds = (Date.now() - startedAt) / 1000;
    return snapshot;
  };
  if (databaseHealth.isUnavailable() || !(await getDb().catch(() => null))) {
    // 累计流量照旧给上一次的数（只增不减，缺一轮没关系），别的都等数据库回来。
    const totalIn = trafficIn.observe(null);
    const totalOut = trafficOut.observe(null);
    if (totalIn !== null && totalOut !== null) snapshot.traffic = { in: totalIn, out: totalOut };
    return finish();
  }

  const [hosts, ruleCounts, totals] = await Promise.all([
    section("主机", () => collectHosts(nowMs)),
    section("规则数", collectRuleCounts),
    section("全站流量", () => getTotalTraffic()),
  ]);
  snapshot.hosts = hosts;
  snapshot.ruleCounts = ruleCounts;
  const totalIn = trafficIn.observe(totals ? totals.totalIn : null);
  const totalOut = trafficOut.observe(totals ? totals.totalOut : null);
  if (totalIn !== null && totalOut !== null) snapshot.traffic = { in: totalIn, out: totalOut };

  const hostNames = new Map((hosts || []).map((host) => [host.id, host.name]));
  const maxRules = Math.max(0, Math.floor(options.maxRules));
  const ruleDetail = !!ruleCounts && ruleCounts.total <= maxRules;
  /*
    规则没超上限：整份规则列表读一次，线路组规则从里面挑。
    超了：只读开了主备 / 线路组的那些（库里筛，见 getForwardRules 的 failoverOnly），它们也超了就连线路明细都不给。
  */
  const ruleRows = ruleCounts
    ? await section("规则列表", () => (ruleDetail ? getForwardRules() : getForwardRules(undefined, undefined, { failoverOnly: true })) as Promise<Row[]>)
    : null;
  if (!ruleRows) return finish();
  const routeRows = ruleRows.filter((row) => !!routeGroupOf(row as RouteGroupRule, { nowMs }));
  const routeDetail = routeRows.length <= maxRules;
  const templates = (ruleDetail ? ruleRows : routeDetail ? routeRows : [])
    .filter((row) => dbBool(row.isForwardGroupTemplate))
    .map((row) => num(row.id));
  const children = (await section("转发组子规则", () => loadTemplateChildren(templates))) || new Map<number, Row[]>();
  const [rules, routes] = await Promise.all([
    ruleDetail ? section("规则明细", () => collectRules(ruleRows, children, hostNames, nowMs)) : Promise.resolve(null),
    routeDetail ? section("线路组", () => collectRoutes(routeRows, children, hostNames, nowMs)) : Promise.resolve(null),
  ]);
  snapshot.rules = rules;
  snapshot.routes = routes;
  return finish();
}

export function resetMetricsCollectStateForTest() {
  trafficIn = new MonotonicTotal();
  trafficOut = new MonotonicTotal();
}
