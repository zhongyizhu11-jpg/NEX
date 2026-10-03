import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { createQueryCache } from "../queryCache";

const dashboardCache = createQueryCache(250);

function cachedDashboardQuery<T>(key: string, ttlMs: number, staleMs: number, load: () => Promise<T>): Promise<T> {
  return dashboardCache.get(key, { ttlMs, staleMs }, load);
}

/**
 * 首页该统计谁的资源。
 *
 * 管理员看全部，租户只看自己的 —— 和主机页、转发页同一个口径。原来仪表盘一律
 * 按 ctx.user.id 过滤，于是管理员的主机页列出 3 台、首页却写着 1 台：同一个人
 * 同一时刻，两个页面两个答案，而看不出哪个是对的。
 */
function dashboardScopeUserId(user: { id: number; role?: unknown }): number | undefined {
  return String(user.role || "") === "admin" ? undefined : user.id;
}

/**
 * stats / health 的结果只取决于统计范围：管理员看的都是全站，按人分缓存等于每个管理员
 * 各算一遍同一份全站聚合。所以按范围做键 —— 全站一份，租户仍然各自一份（键里带他的 id），
 * 不会把一个租户的数给到另一个人。
 */
function dashboardScopeCacheKey(scope: number | undefined) {
  return scope === undefined ? "all" : `user:${scope}`;
}

export const dashboardRouter = router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      const scope = dashboardScopeUserId(ctx.user);
      return cachedDashboardQuery(
        `stats:${dashboardScopeCacheKey(scope)}`,
        5_000,
        30_000,
        () => db.getDashboardStats(scope, { includeTraffic: false }),
      );
    }),
    /**
     * 首页顶上那一块的依据：现在系统是否正常，以及「需要关注」里具体是谁。
     * 数和行一起返回 —— 分成两个接口各自缓存的话，总有一瞬间两边对不上。
     */
    health: protectedProcedure.query(async ({ ctx }) => {
      const scope = dashboardScopeUserId(ctx.user);
      return cachedDashboardQuery(
        `health:${dashboardScopeCacheKey(scope)}`,
        5_000,
        30_000,
        () => db.getDashboardHealth(scope),
      );
    }),
    /**
     * 首页「概览」图上主机之间的转发连线（隧道那几条另外从 tunnels.options 来）。
     * 租户只拿自己的规则，线的两头都得是他看得到的主机。
     */
    forwardMap: protectedProcedure.query(async ({ ctx }) => {
      const scope = dashboardScopeUserId(ctx.user);
      return cachedDashboardQuery(`forwardMap:${dashboardScopeCacheKey(scope)}`, 10_000, 60_000, async () => {
        if (scope === undefined) return db.getDashboardForwardMap();
        const [allowedHostIds, billingResourceIds] = await Promise.all([
          db.getUserEffectiveAllowedHostIds(scope),
          db.getUserUsableTrafficBillingResourceIds(scope),
        ]);
        return db.getDashboardForwardMap(scope, [...allowedHostIds, ...billingResourceIds.hostIds]);
      });
    }),
    trafficTotals: protectedProcedure.query(async ({ ctx }) => {
      return cachedDashboardQuery(`trafficTotals:${ctx.user.id}`, 5_000, 0, async () => {
        const traffic = await db.getTotalTraffic(ctx.user.id);
        return {
          totalTrafficIn: traffic.totalIn,
          totalTrafficOut: traffic.totalOut,
        };
      });
    }),
    /** 当前用户流量走势（仪表盘图表） */
    trafficSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(0.5).max(24 * 3).default(24),
        bucketMinutes: z.number().min(1).max(60).default(60),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 60;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        return cachedDashboardQuery(
          `trafficSeries:${ctx.user.id}:${hours}:${bucketMinutes}`,
          30_000,
          5 * 60_000,
          () => db.getGlobalTrafficSeries({
            bucketMinutes,
            since,
            userId: ctx.user.id,
          }),
        );
      }),
    /** 当前用户按转发类型划分的规则流量消耗分布 */
    trafficBreakdown: protectedProcedure
      .input(z.object({
        hours: z.number().min(0.5).max(24 * 3).default(24),
        limit: z.number().min(1).max(100).default(30),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const limit = input?.limit ?? 30;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        return cachedDashboardQuery(
          `trafficBreakdown:${ctx.user.id}:${hours}:${limit}`,
          30_000,
          5 * 60_000,
          () => db.getDashboardTrafficBreakdown({
            userId: ctx.user.id,
            since,
            limit,
          }),
        );
      }),
    /** 当前用户 TCPing 延迟走势（仪表盘图表） */
    tcpingSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(0.5).max(24 * 3).default(24),
        bucketMinutes: z.number().min(1).max(60).default(1),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 1;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        return cachedDashboardQuery(
          `tcpingSeries:${ctx.user.id}:${hours}:${bucketMinutes}`,
          30_000,
          2 * 60_000,
          () => db.getGlobalTcpingSeries({
            bucketMinutes,
            since,
            userId: ctx.user.id,
          }),
        );
      }),
    /** 用户流量汇总（首页始终只看当前登录用户） */
    userTraffic: protectedProcedure.query(async ({ ctx }) => cachedDashboardQuery(`userTraffic:${ctx.user.id}`, 10_000, 60_000, async () => {
      const user = await db.getUserById(ctx.user.id);
      if (!user) return [];
      return [{
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
        role: user.role,
        trafficLimit: user.trafficLimit,
        trafficUsed: user.trafficUsed,
        manualCanAddRules: user.manualCanAddRules,
        manualTrafficLimit: user.manualTrafficLimit,
        canAddRules: user.canAddRules,
        gostRateLimitIn: user.gostRateLimitIn,
        gostRateLimitOut: user.gostRateLimitOut,
        expiresAt: user.expiresAt,
        trafficAutoReset: user.trafficAutoReset,
        trafficResetDay: user.trafficResetDay,
      }];
    })),
  });
