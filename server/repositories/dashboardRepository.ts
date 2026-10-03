import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { forwardGroups, forwardRules, hosts, tunnels, users } from "../../drizzle/schema";
import { getDb } from "../dbRuntime";
import { boolLiteral, quoteIdentifier, sqlCountAll } from "../dbCompat";
import { getTotalTraffic, getTrafficSummaryByRule } from "./metricsRepository";
import { clampPositiveInt, epochSeconds, sqlBool } from "./repositoryUtils";
import { resolveDashboardTrafficRuleIdentity } from "../dashboardTrafficIdentity";
import { HOST_ONLINE_TTL_MS } from "../hostHeartbeatPolicy";
import {
  countAttentionIssues,
  emptyAttentionTotals,
  type DashboardAttention,
  type DashboardAttentionRow,
  type DashboardAttentionTotals,
} from "../../shared/dashboardAttention";
import { timestampMillis } from "../../shared/timestamp";
import { buildForwardMapLinks, type ForwardMapHost, type ForwardMapRule } from "../../shared/forwardMapLinks";

type DashboardTrafficBreakdownItem = {
  id: number;
  name: string;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
};

type TrafficSummaryItem = {
  ruleId: number;
  hostId: number;
  bytesIn: number;
  bytesOut: number;
  connections: number;
};

type RuleTrafficBucket = "tunnelRules" | "portRules" | "forwardGroupRules";

type RuleTrafficMeta = {
  trafficId: number;
  name: string;
  forwardType: string;
  tunnelId: number | null;
  forwardGroupId: number | null;
  forwardGroupRuleId: number | null;
  forwardGroupMemberId: number | null;
  forwardGroupMode: string | null;
  isForwardGroupTemplate: boolean;
};

function emptyTrafficBreakdown() {
  return {
    tunnelRules: [] as DashboardTrafficBreakdownItem[],
    portRules: [] as DashboardTrafficBreakdownItem[],
    forwardGroupRules: [] as DashboardTrafficBreakdownItem[],
  };
}

function addTraffic(
  map: Map<number, DashboardTrafficBreakdownItem>,
  id: number,
  name: string,
  bytesIn: number,
  bytesOut: number,
) {
  if (!id) return;
  const totalBytes = bytesIn + bytesOut;
  if (totalBytes <= 0) return;
  const prev = map.get(id);
  if (prev) {
    prev.bytesIn += bytesIn;
    prev.bytesOut += bytesOut;
    prev.totalBytes += totalBytes;
    return;
  }
  map.set(id, { id, name, bytesIn, bytesOut, totalBytes });
}

function sortTrafficItems(map: Map<number, DashboardTrafficBreakdownItem>, limit: number) {
  return Array.from(map.values())
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, limit);
}

function getRuleTrafficBucket(rule: RuleTrafficMeta | undefined): RuleTrafficBucket {
  if (
    rule?.isForwardGroupTemplate ||
    rule?.forwardGroupId ||
    rule?.forwardGroupRuleId ||
    rule?.forwardGroupMemberId
  ) {
    if (rule?.forwardGroupMode === "port") return "portRules";
    return "forwardGroupRules";
  }
  if (rule?.tunnelId) return "tunnelRules";
  return "portRules";
}

// ==================== 系统健康摘要 ====================

export type SystemHealthSummary = {
  hosts: { total: number; online: number; offline: number; neverConnected: number };
  links: { total: number; healthy: number; unhealthy: number; degraded: number };
  /**
   * paused：主人被暂停了转发（到期、超额、欠费、管理员手动）的规则。它们按设计
   * 停着，既不是 running 也不是 stalled —— 见 ruleOwnerPausedSql。
   */
  forwards: { total: number; running: number; stalled: number; paused: number; disabled: number };
  /** 异常总数：「需要关注」里所有 down 那几类加起来。0 表示没有异常。 */
  issues: number;
};

/** 首页顶上那一块的全部依据：几个数，加上这几个数背后具体是谁。 */
export type DashboardHealth = SystemHealthSummary & { attention: DashboardAttention };

/** 每一类最多取几行。首页只画五六行，多取一点是为了排序后挑得出最该看的。 */
const ATTENTION_ROWS_PER_REASON = 6;

/**
 * 规则「在跑」的判据。
 *
 * 普通规则看自己的 isRunning。转发组的**模板规则**不行：模板是「转发组的那一条」，
 * 自己从不下发给 Agent，isRunning 永远是 false —— 真正在机器上跑的是它派生出来的
 * 子规则（它们在 forwardGroupRuleId 下面）。所以模板看它有没有子规则在跑。
 *
 * 上一版没分开：每个启用的转发组都在首页多记一条「转发未运行」，而且永远消不掉。
 */
function ruleEffectivelyRunningSql() {
  const q = quoteIdentifier;
  const child = q("fx_child");
  const isTemplate = sql`COALESCE(${forwardRules.isForwardGroupTemplate}, ${sqlBool(false)}) = ${sqlBool(true)}`;
  // 子查询里的表起了别名，所以裸写的 forward_rules 指的是外层那一行。
  const childRunning = sql.raw(
    `EXISTS (SELECT 1 FROM ${q("forward_rules")} ${child}`
    + ` WHERE ${child}.${q("forwardGroupRuleId")} = ${q("forward_rules")}.${q("id")}`
    + ` AND ${child}.${q("isRunning")} = ${boolLiteral(true)}`
    + ` AND ${child}.${q("pendingDelete")} = ${boolLiteral(false)})`,
  );
  return sql`(${forwardRules.isRunning} = ${sqlBool(true)} OR (${isTemplate} AND ${childRunning}))`;
}

/**
 * 规则的主人被暂停了转发。
 *
 * 到期、超额、欠费时计费那边会把这个人的规则 isRunning 清成 false，但 isEnabled
 * 留着 true —— 续期之后要自己恢复。于是它和「该跑没跑」长得一模一样。
 *
 * 可它是**按设计停着**：计费把它停的，不是哪里坏了。管理员首页上把它算成异常，
 * 等于每个到期没续费的租户都在首页挂一条红的，永远消不掉，真正的故障反而淹在里面。
 */
function ruleOwnerPausedSql() {
  const q = quoteIdentifier;
  const owner = q("fx_owner");
  return sql.raw(
    `EXISTS (SELECT 1 FROM ${q("users")} ${owner}`
    + ` WHERE ${owner}.${q("id")} = ${q("forward_rules")}.${q("userId")}`
    + ` AND ${owner}.${q("role")} <> 'admin'`
    + ` AND ${owner}.${q("canAddRules")} = ${boolLiteral(false)})`,
  );
}

/**
 * 转发只数「用户眼里的那一条」：转发组派生出来的子规则不算，否则一个五成员的
 * 转发组会让首页多出五条转发，而界面上从来只显示一条。
 */
function userFacingRuleWhere(userId?: number) {
  return and(
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    ...(userId ? [eq(forwardRules.userId, userId)] : []),
  );
}

function hostOnlineSql() {
  const freshSince = epochSeconds(new Date(Date.now() - HOST_ONLINE_TTL_MS));
  return sql`${hosts.isOnline} = ${sqlBool(true)} AND ${hosts.lastHeartbeat} >= ${freshSince}`;
}

type HealthCounts = { summary: SystemHealthSummary; totals: DashboardAttentionTotals };

function emptyHealthCounts(): HealthCounts {
  return {
    summary: {
      hosts: { total: 0, online: 0, offline: 0, neverConnected: 0 },
      links: { total: 0, healthy: 0, unhealthy: 0, degraded: 0 },
      forwards: { total: 0, running: 0, stalled: 0, paused: 0, disabled: 0 },
      issues: 0,
    },
    totals: emptyAttentionTotals(),
  };
}

/**
 * 首页那一块要回答的问题：现在系统是否正常，不正常的话是哪几类。
 *
 * 之前首页顶上挂着一个写死的绿色「系统在线」—— 后面没有任何数据，掉多少台机器
 * 它都是绿的。这个函数就是为了让那句话有据可依。
 *
 * 几类异常各有各的判据，故意不合成一个笼统的「不健康」：
 *
 *   - **主机掉线**：收过心跳、但已经超时。从没收过心跳的算「还没装 Agent」，
 *     那是一步没做完，不是出了故障 —— 进「需要关注」，但不计入异常。
 *   - **隧道没在运行**：启用了而 isRunning 为假。
 *   - **转发组故障 / 降级**：转发组自己报的 down / error / degraded。unknown 不算
 *     —— 那是「还没测过」。降级不计入异常，但要进「需要关注」。
 *   - **转发该跑没跑**：启用了而没在跑。模板看子规则（ruleEffectivelyRunningSql），
 *     主人被暂停转发的不算（ruleOwnerPausedSql）。
 *
 * 全部用 SQL 聚合，计数查询的条数和机器数量无关 —— 首页是所有人的落地页，
 * 不能把整表拉回来再在内存里数。
 */
async function countDashboardHealth(userId?: number): Promise<HealthCounts> {
  const db = await getDb();
  if (!db) return emptyHealthCounts();

  const online = hostOnlineSql();
  const neverConnected = sql`${hosts.lastHeartbeat} IS NULL`;

  /*
    四个聚合互不依赖，并发发出去：MySQL / PostgreSQL 上各走一个连接，首页等最慢的那一条
    而不是四条相加；SQLite 是同一个同步连接，照样一条条跑，只是不再多排几轮事件循环。
    这里不在事务里，也不依赖彼此的结果，并发不改变任何一个数。
  */
  const hostRowsQuery = db
    .select({
      total: sqlCountAll(),
      online: sql<number>`COALESCE(SUM(CASE WHEN ${online} THEN 1 ELSE 0 END), 0)`,
      neverConnected: sql<number>`COALESCE(SUM(CASE WHEN ${neverConnected} THEN 1 ELSE 0 END), 0)`,
    })
    .from(hosts)
    .where(userId ? eq(hosts.userId, userId) : undefined);

  const enabled = sql`${forwardRules.isEnabled} = ${sqlBool(true)}`;
  const running = ruleEffectivelyRunningSql();
  const ownerPaused = ruleOwnerPausedSql();
  const ruleRowsQuery = db
    .select({
      total: sqlCountAll(),
      running: sql<number>`COALESCE(SUM(CASE WHEN ${enabled} AND ${running} THEN 1 ELSE 0 END), 0)`,
      stalled: sql<number>`COALESCE(SUM(CASE WHEN ${enabled} AND NOT ${running} AND NOT ${ownerPaused} THEN 1 ELSE 0 END), 0)`,
      paused: sql<number>`COALESCE(SUM(CASE WHEN ${enabled} AND NOT ${running} AND ${ownerPaused} THEN 1 ELSE 0 END), 0)`,
      disabled: sql<number>`COALESCE(SUM(CASE WHEN ${forwardRules.isEnabled} = ${sqlBool(false)} THEN 1 ELSE 0 END), 0)`,
    })
    .from(forwardRules)
    .where(userFacingRuleWhere(userId));

  const tunnelRowsQuery = db
    .select({
      total: sqlCountAll(),
      unhealthy: sql<number>`COALESCE(SUM(CASE WHEN ${tunnels.isEnabled} = ${sqlBool(true)} AND ${tunnels.isRunning} = ${sqlBool(false)} THEN 1 ELSE 0 END), 0)`,
    })
    .from(tunnels)
    .where(userId ? eq(tunnels.userId, userId) : undefined);

  const groupRowsQuery = db
    .select({
      total: sqlCountAll(),
      // unknown 是「还没测过」，不是异常；只有明确报坏的才算。
      unhealthy: sql<number>`COALESCE(SUM(CASE WHEN ${forwardGroups.isEnabled} = ${sqlBool(true)} AND ${forwardGroups.lastStatus} IN ('down', 'error') THEN 1 ELSE 0 END), 0)`,
      degraded: sql<number>`COALESCE(SUM(CASE WHEN ${forwardGroups.isEnabled} = ${sqlBool(true)} AND ${forwardGroups.lastStatus} = 'degraded' THEN 1 ELSE 0 END), 0)`,
    })
    .from(forwardGroups)
    .where(userId ? eq(forwardGroups.userId, userId) : undefined);
  const [hostRows, ruleRows, tunnelRows, groupRows] = await Promise.all([hostRowsQuery, ruleRowsQuery, tunnelRowsQuery, groupRowsQuery]);

  const n = (value: unknown) => Math.max(0, Math.trunc(Number(value) || 0));
  const hostTotal = n(hostRows[0]?.total);
  const hostOnline = n(hostRows[0]?.online);
  const hostNever = n(hostRows[0]?.neverConnected);
  // 掉线 = 连过但现在不在线。从没连过的单独算，不计入异常。
  const hostOffline = Math.max(0, hostTotal - hostOnline - hostNever);

  const tunnelUnhealthy = n(tunnelRows[0]?.unhealthy);
  const groupUnhealthy = n(groupRows[0]?.unhealthy);
  const groupDegraded = n(groupRows[0]?.degraded);
  const linkTotal = n(tunnelRows[0]?.total) + n(groupRows[0]?.total);
  const linkUnhealthy = tunnelUnhealthy + groupUnhealthy;
  const stalled = n(ruleRows[0]?.stalled);
  const paused = n(ruleRows[0]?.paused);

  const totals = emptyAttentionTotals();
  totals["host-offline"] = hostOffline;
  totals["host-never-connected"] = hostNever;
  totals["tunnel-stopped"] = tunnelUnhealthy;
  totals["group-down"] = groupUnhealthy;
  totals["group-degraded"] = groupDegraded;
  totals["forward-stalled"] = stalled;
  /*
    暂停只在租户**自己的**首页上算一件事（合成一行）：对他来说转发确实停了，而且
    只有他能处理（续期、充值）。管理员那边不算 —— 那是计费状态，不是系统故障。
  */
  totals["forward-paused"] = userId && paused > 0 ? 1 : 0;

  return {
    summary: {
      hosts: { total: hostTotal, online: hostOnline, offline: hostOffline, neverConnected: hostNever },
      links: {
        total: linkTotal,
        healthy: Math.max(0, linkTotal - linkUnhealthy - groupDegraded),
        unhealthy: linkUnhealthy,
        degraded: groupDegraded,
      },
      forwards: {
        total: n(ruleRows[0]?.total),
        running: n(ruleRows[0]?.running),
        stalled,
        paused,
        disabled: n(ruleRows[0]?.disabled),
      },
      issues: countAttentionIssues(totals),
    },
    totals,
  };
}

export async function getSystemHealthSummary(userId?: number): Promise<SystemHealthSummary> {
  return (await countDashboardHealth(userId)).summary;
}

function millisOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = timestampMillis(value);
  return ms > 0 ? ms : null;
}

async function hostNamesById(ids: Iterable<unknown>): Promise<Map<number, string>> {
  const wanted = Array.from(new Set(Array.from(ids).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const db = await getDb();
  if (!db || wanted.length === 0) return new Map();
  const rows = await db.select({ id: hosts.id, name: hosts.name }).from(hosts).where(inArray(hosts.id, wanted));
  return new Map((rows as any[]).map((row) => [Number(row.id), String(row.name || "")]));
}

/**
 * 「需要关注」的具体行。
 *
 * 判据和 countDashboardHealth 逐条对应 —— 顶上那个数和列表必须是同一件事的两种
 * 说法。计数为 0 的类别直接跳过：系统一切正常时，这一步一条查询都不发。
 */
async function listDashboardAttentionRows(
  userId: number | undefined,
  totals: DashboardAttentionTotals,
  limit: number,
): Promise<DashboardAttentionRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows: DashboardAttentionRow[] = [];
  const tasks: Promise<void>[] = [];

  if (totals["host-offline"] > 0) {
    tasks.push((async () => {
      const found = await db
        .select({ id: hosts.id, name: hosts.name, lastHeartbeat: hosts.lastHeartbeat })
        .from(hosts)
        .where(and(
          sql`${hosts.lastHeartbeat} IS NOT NULL`,
          sql`NOT (${hostOnlineSql()})`,
          userId ? eq(hosts.userId, userId) : undefined,
        ))
        // 刚掉的在前：掉了三天的那台多半已经有人知道了。
        .orderBy(desc(hosts.lastHeartbeat))
        .limit(limit);
      for (const host of found as any[]) {
        rows.push({ reason: "host-offline", id: Number(host.id), name: String(host.name || ""), at: millisOrNull(host.lastHeartbeat) });
      }
    })());
  }

  if (totals["host-never-connected"] > 0) {
    tasks.push((async () => {
      const found = await db
        .select({ id: hosts.id, name: hosts.name, createdAt: hosts.createdAt })
        .from(hosts)
        .where(and(sql`${hosts.lastHeartbeat} IS NULL`, userId ? eq(hosts.userId, userId) : undefined))
        .orderBy(desc(hosts.createdAt))
        .limit(limit);
      for (const host of found as any[]) {
        rows.push({ reason: "host-never-connected", id: Number(host.id), name: String(host.name || ""), at: millisOrNull(host.createdAt) });
      }
    })());
  }

  if (totals["tunnel-stopped"] > 0) {
    tasks.push((async () => {
      const found = await db
        .select({
          id: tunnels.id,
          name: tunnels.name,
          entryHostId: tunnels.entryHostId,
          exitHostId: tunnels.exitHostId,
          updatedAt: tunnels.updatedAt,
        })
        .from(tunnels)
        .where(and(
          eq(tunnels.isEnabled, true),
          eq(tunnels.isRunning, false),
          userId ? eq(tunnels.userId, userId) : undefined,
        ))
        .orderBy(desc(tunnels.updatedAt))
        .limit(limit);
      const names = await hostNamesById((found as any[]).flatMap((row) => [row.entryHostId, row.exitHostId]));
      for (const tunnel of found as any[]) {
        rows.push({
          reason: "tunnel-stopped",
          id: Number(tunnel.id),
          name: String(tunnel.name || ""),
          at: millisOrNull(tunnel.updatedAt),
          entryName: names.get(Number(tunnel.entryHostId)) || null,
          exitName: names.get(Number(tunnel.exitHostId)) || null,
        });
      }
    })());
  }

  const groupRowsFor = (reason: "group-down" | "group-degraded", statuses: string[]) => (async () => {
    const found = await db
      .select({
        id: forwardGroups.id,
        name: forwardGroups.name,
        groupMode: forwardGroups.groupMode,
        lastMessage: forwardGroups.lastMessage,
        updatedAt: forwardGroups.updatedAt,
      })
      .from(forwardGroups)
      .where(and(
        eq(forwardGroups.isEnabled, true),
        inArray(forwardGroups.lastStatus, statuses),
        userId ? eq(forwardGroups.userId, userId) : undefined,
      ))
      .orderBy(desc(forwardGroups.updatedAt))
      .limit(limit);
    for (const group of found as any[]) {
      rows.push({
        reason,
        id: Number(group.id),
        name: String(group.name || ""),
        at: millisOrNull(group.updatedAt),
        message: String(group.lastMessage || "").trim() || null,
        groupMode: String(group.groupMode || "") || null,
      });
    }
  })();
  if (totals["group-down"] > 0) tasks.push(groupRowsFor("group-down", ["down", "error"]));
  if (totals["group-degraded"] > 0) tasks.push(groupRowsFor("group-degraded", ["degraded"]));

  if (totals["forward-stalled"] > 0) {
    tasks.push((async () => {
      const found = await db
        .select({
          id: forwardRules.id,
          name: forwardRules.name,
          hostId: forwardRules.hostId,
          forwardGroupId: forwardRules.forwardGroupId,
          isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
          updatedAt: forwardRules.updatedAt,
        })
        .from(forwardRules)
        .where(and(
          userFacingRuleWhere(userId),
          eq(forwardRules.isEnabled, true),
          sql`NOT ${ruleEffectivelyRunningSql()}`,
          sql`NOT ${ruleOwnerPausedSql()}`,
        ))
        .orderBy(desc(forwardRules.updatedAt))
        .limit(limit);
      const hostNames = await hostNamesById((found as any[]).map((row) => row.hostId));
      const groupIds = Array.from(new Set((found as any[])
        .filter((row) => !!row.isForwardGroupTemplate)
        .map((row) => Number(row.forwardGroupId))
        .filter((id) => Number.isInteger(id) && id > 0)));
      const groupNames = groupIds.length
        ? new Map(((await db
          .select({ id: forwardGroups.id, name: forwardGroups.name })
          .from(forwardGroups)
          .where(inArray(forwardGroups.id, groupIds))) as any[]).map((row) => [Number(row.id), String(row.name || "")]))
        : new Map<number, string>();
      for (const rule of found as any[]) {
        const isTemplate = !!rule.isForwardGroupTemplate;
        rows.push({
          reason: "forward-stalled",
          id: Number(rule.id),
          name: String(rule.name || ""),
          at: millisOrNull(rule.updatedAt),
          // 模板在哪台机器上没有意义（它不跑），有意义的是它属于哪个转发组。
          hostName: isTemplate ? null : hostNames.get(Number(rule.hostId)) || null,
          groupName: isTemplate ? groupNames.get(Number(rule.forwardGroupId)) || null : null,
        });
      }
    })());
  }

  if (userId && totals["forward-paused"] > 0) {
    tasks.push((async () => {
      const owner = await db
        .select({ forwardAccessPauseReason: users.forwardAccessPauseReason })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const paused = await db
        .select({ count: sqlCountAll() })
        .from(forwardRules)
        .where(and(
          userFacingRuleWhere(userId),
          eq(forwardRules.isEnabled, true),
          sql`NOT ${ruleEffectivelyRunningSql()}`,
          sql`${ruleOwnerPausedSql()}`,
        ));
      rows.push({
        reason: "forward-paused",
        id: userId,
        name: "",
        at: null,
        count: Math.max(0, Math.trunc(Number((paused as any[])[0]?.count) || 0)),
        pauseReason: String((owner as any[])[0]?.forwardAccessPauseReason || "").trim() || null,
      });
    })());
  }

  await Promise.all(tasks);
  return rows;
}

/**
 * 首页顶上那一块：几个数 + 这几个数背后具体是谁。
 *
 * 放在同一次调用里返回，而不是拆成两个接口：拆开的话两边各自缓存、各自刷新，
 * 总有一瞬间顶上写「2 处异常」而列表里画着 3 行。
 */
export async function getDashboardHealth(userId?: number): Promise<DashboardHealth> {
  const { summary, totals } = await countDashboardHealth(userId);
  const rows = await listDashboardAttentionRows(userId, totals, ATTENTION_ROWS_PER_REASON);
  return { ...summary, attention: { rows, totals } };
}

// ==================== Dashboard Stats ====================

export async function getDashboardStats(userId?: number, opts: { includeTraffic?: boolean } = {}) {
  const db = await getDb();
  if (!db) return { totalHosts: 0, onlineHosts: 0, totalRules: 0, activeRules: 0, totalTrafficIn: 0, totalTrafficOut: 0 };

  const heartbeatFreshSince = epochSeconds(new Date(Date.now() - HOST_ONLINE_TTL_MS));
  const hostConditions = userId ? eq(hosts.userId, userId) : undefined;
  const ruleConditions = [
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    ...(userId ? [eq(forwardRules.userId, userId)] : []),
  ];

  const hostStatsQuery = db
    .select({
      totalHosts: sqlCountAll(),
      onlineHosts: sql<number>`COALESCE(SUM(CASE WHEN ${hosts.isOnline} = ${sqlBool(true)} AND ${hosts.lastHeartbeat} >= ${heartbeatFreshSince} THEN 1 ELSE 0 END), 0)`,
    })
    .from(hosts)
    .where(hostConditions as any);

  const ruleStatsQuery = db
    .select({
      totalRules: sqlCountAll(),
      activeRules: sql<number>`SUM(CASE WHEN ${forwardRules.isEnabled} = ${sqlBool(true)} THEN 1 ELSE 0 END)`,
    })
    .from(forwardRules)
    .where(and(...ruleConditions));

  const [hostStatsRows, ruleStatsRows, traffic] = await Promise.all([
    hostStatsQuery,
    ruleStatsQuery,
    opts.includeTraffic === false ? Promise.resolve({ totalIn: 0, totalOut: 0 }) : getTotalTraffic(userId),
  ]);
  const hostStats = hostStatsRows[0];
  const ruleStats = ruleStatsRows[0];

  return {
    totalHosts: Number(hostStats?.totalHosts) || 0,
    onlineHosts: Number(hostStats?.onlineHosts) || 0,
    totalRules: Number(ruleStats?.totalRules) || 0,
    activeRules: Number(ruleStats?.activeRules) || 0,
    totalTrafficIn: traffic.totalIn,
    totalTrafficOut: traffic.totalOut,
  };
}

// ==================== Dashboard Traffic Breakdown ====================

export async function getDashboardTrafficBreakdown(opts: {
  userId?: number;
  since?: Date;
  limit?: number;
} = {}) {
  const db = await getDb();
  if (!db) return emptyTrafficBreakdown();

  const limit = clampPositiveInt(opts.limit, 30, 100);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const summaries = await getTrafficSummaryByRule({ userId: opts.userId, since, includeLatency: false }) as TrafficSummaryItem[];
  if (summaries.length === 0) return emptyTrafficBreakdown();

  const ruleIds = Array.from(new Set(summaries.map((item) => Number(item.ruleId)).filter(Boolean)));
  const ruleRows = ruleIds.length
    ? await db
      .select({
        id: forwardRules.id,
        name: forwardRules.name,
        forwardType: forwardRules.forwardType,
        tunnelId: forwardRules.tunnelId,
        forwardGroupId: forwardRules.forwardGroupId,
        forwardGroupRuleId: forwardRules.forwardGroupRuleId,
        forwardGroupMemberId: forwardRules.forwardGroupMemberId,
        forwardGroupMode: forwardGroups.groupMode,
        isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
      })
      .from(forwardRules)
      .leftJoin(forwardGroups, eq(forwardGroups.id, forwardRules.forwardGroupId))
      .where(sql`${forwardRules.id} IN (${sql.join(ruleIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];

  const templateRuleIds = Array.from(new Set((ruleRows as any[])
    .map((row: any) => Number(row.forwardGroupRuleId || 0))
    .filter((id: number) => Number.isInteger(id) && id > 0)));
  const templateRows = templateRuleIds.length
    ? await db
      .select({
        id: forwardRules.id,
        name: forwardRules.name,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.id} IN (${sql.join(templateRuleIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const templateNames = new Map<number, string>((templateRows as any[]).map((row: any) => [
    Number(row.id),
    String(row.name || "").trim(),
  ]));

  const ruleMeta = new Map<number, RuleTrafficMeta>();
  for (const row of ruleRows as any[]) {
    const identity = resolveDashboardTrafficRuleIdentity(row.id, row, templateNames);
    ruleMeta.set(Number(row.id), {
      trafficId: identity.id,
      name: identity.name,
      forwardType: String(row.forwardType || ""),
      tunnelId: row.tunnelId ? Number(row.tunnelId) : null,
      forwardGroupId: row.forwardGroupId ? Number(row.forwardGroupId) : null,
      forwardGroupRuleId: row.forwardGroupRuleId ? Number(row.forwardGroupRuleId) : null,
      forwardGroupMemberId: row.forwardGroupMemberId ? Number(row.forwardGroupMemberId) : null,
      forwardGroupMode: row.forwardGroupMode ? String(row.forwardGroupMode) : null,
      isForwardGroupTemplate: !!row.isForwardGroupTemplate,
    });
  }

  const tunnelRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const portRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const forwardGroupRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const totalsByBucket: Record<RuleTrafficBucket, Map<number, DashboardTrafficBreakdownItem>> = {
    tunnelRules: tunnelRuleTotals,
    portRules: portRuleTotals,
    forwardGroupRules: forwardGroupRuleTotals,
  };

  for (const item of summaries) {
    const ruleId = Number(item.ruleId);
    const bytesIn = Number(item.bytesIn) || 0;
    const bytesOut = Number(item.bytesOut) || 0;
    const rule = ruleMeta.get(ruleId);
    const bucket = getRuleTrafficBucket(rule);
    addTraffic(totalsByBucket[bucket], rule?.trafficId || ruleId, rule?.name || `规则 #${ruleId}`, bytesIn, bytesOut);
  }

  return {
    tunnelRules: sortTrafficItems(tunnelRuleTotals, limit),
    portRules: sortTrafficItems(portRuleTotals, limit),
    forwardGroupRules: sortTrafficItems(forwardGroupRuleTotals, limit),
  };
}

/**
 * 首页「概览」上主机之间的转发连线（规则 → 目标那台主机，算法在 shared/forwardMapLinks）。
 *
 * 两条小查询，各只取要用的几列：规则（没在删除的；租户只取自己的）和主机地址。租户只看得到自己的
 * 主机和被授权的主机（visibleHostIds），任何一端在这之外的线都不给 —— 不靠这张图知道别人的机器。
 */
export async function getDashboardForwardMap(userId?: number, visibleHostIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const ruleConds: any[] = [sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`];
  if (userId) ruleConds.push(eq(forwardRules.userId, userId));
  const [ruleRows, hostRows] = await Promise.all([
    db.select({
      id: forwardRules.id,
      hostId: forwardRules.hostId,
      targetIp: forwardRules.targetIp,
      targetPort: forwardRules.targetPort,
      tunnelId: forwardRules.tunnelId,
      isEnabled: forwardRules.isEnabled,
      isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
      routeParentRuleId: forwardRules.routeParentRuleId,
      failoverEnabled: forwardRules.failoverEnabled,
      failoverTargets: forwardRules.failoverTargets,
      routePaths: forwardRules.routePaths,
    }).from(forwardRules).where(and(...ruleConds)),
    db.select({
      id: hosts.id,
      userId: hosts.userId,
      ip: hosts.ip,
      ipv4: hosts.ipv4,
      ipv6: hosts.ipv6,
      entryIp: hosts.entryIp,
      tunnelEntryIp: hosts.tunnelEntryIp,
      ddnsDomain: hosts.ddnsDomain,
      ddnsEnabled: hosts.ddnsEnabled,
    }).from(hosts),
  ]);
  const visible = userId
    ? new Set<number>([
      ...(visibleHostIds || []).map(Number),
      ...hostRows.filter((host: any) => Number(host.userId) === Number(userId)).map((host: any) => Number(host.id)),
    ])
    : undefined;
  return buildForwardMapLinks(ruleRows as ForwardMapRule[], hostRows as ForwardMapHost[], { visibleHostIds: visible });
}
