/*
  线路诊断（线路组规则的分段测速、整条线路导出）。

  - segmentSpeedStart / segmentSpeedStatus：一条路径相邻两台自己的机器之间各跑一次 iperf3，
    找瓶颈（server/lineSegmentSpeed.ts）。
  - lineExport：线路此刻的状态 + 最近 N 小时的切换 / 异常 / 恢复事件 + 质量历史，导出 JSON 或 CSV，
    交给技术支持或 AI 分析。不含任何密钥类字段。

  权限和 rules.routeStatus 一样：管理员随便看，别人只能看自己的规则。
*/
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { quoteDbIdentifier, queryRaw } from "../dbRuntime";
import { dbBool } from "../repositories/repositoryUtils";
import { ROUTE_PATH_QUALITY_RETENTION_HOURS, getRoutePathQualityHistory } from "../repositories/routePathQualityRepository";
import { bucketRouteQualityRows, routeQualityBucketMs } from "../routePathQualityHistory";
import { buildRouteStatus } from "../routeStatusView";
import { getSegmentSpeedRun, startSegmentSpeedRun, type SegmentEndpoints } from "../lineSegmentSpeed";
import { lineSegmentLatencyStatus, startLineSegmentLatency } from "../lineSegmentLatency";
import { routeEntryHostId } from "./rules.crud";
import { requireHostsAccess } from "./helpers";
import { formatHostAddressWithPort, getHostEntryAddress } from "@shared/hostEntryAddress";
import {
  describeRouteReason,
  routeEventMillis,
  routeGroupOf,
  routePathDestination,
  routePathLabel,
  routePathLetter,
} from "@shared/routeGroup";
import { lineExportFilename, lineExportToCsv, planLineSegments, type LineEventRow } from "@shared/lineDiagnostics";

/** 和 rules.routeStatus 同一个口径：管理员随便看，别人只能看自己的。 */
async function requireRuleVisible(user: { id: number; role: string }, ruleId: number) {
  const rule = await db.getForwardRuleById(ruleId) as any;
  if (!rule || dbBool(rule.pendingDelete)) throw new Error("规则不存在或已删除");
  if (user.role !== "admin" && Number(rule.userId) !== Number(user.id)) throw new Error("无权查看此规则");
  return rule;
}

/** 和网络测试页同一个开关：管理员关了普通用户的网络测试，分段测速也不给用。 */
async function assertNetworkTestAllowed(user: { role: string }) {
  if (user.role === "admin") return;
  const userEnabled = (await db.getSetting("lookingGlassUserEnabled")) !== "false";
  if (!userEnabled) throw new TRPCError({ code: "FORBIDDEN", message: "管理员已关闭普通用户使用网络测试" });
}

const EXPORT_EVENT_LIMIT = 5000;
const SENSITIVE_KEY = /token|secret|password|privatekey|private_key|apikey|api_key|cookie|psk|uuid$/i;

/** 导出前再扫一遍：不管上游哪天多带了什么字段，令牌 / 密码类的一律不出去。 */
function scrubSecrets(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    out[key] = scrubSecrets(item, depth + 1);
  }
  return out;
}

/** 最近 hours 小时的线路事件（新的在前）。rules.routeEvents 一次最多 100 条，导出要整段时间的。 */
async function lineEventsSince(ruleId: number, hours: number): Promise<LineEventRow[]> {
  const q = quoteDbIdentifier;
  const cutoff = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("kind")}, ${q("fromKey")}, ${q("toKey")}, ${q("fromLabel")}, ${q("toLabel")}, ${q("reason")}, ${q("score")}, ${q("latencyMs")}, ${q("createdAt")}
       FROM ${q("forward_rule_route_events")}
      WHERE ${q("ruleId")} = ? AND ${q("createdAt")} >= ?
      ORDER BY ${q("createdAt")} DESC, ${q("id")} DESC
      LIMIT ${EXPORT_EVENT_LIMIT}`,
    [ruleId, cutoff],
  ).catch(() => [] as any[]);
  return rows.map((row) => {
    const createdAt = Number(row.createdAt);
    return {
      id: Number(row.id),
      kind: String(row.kind || ""),
      fromKey: row.fromKey ?? null,
      toKey: row.toKey ?? null,
      fromLabel: row.fromLabel ?? null,
      toLabel: row.toLabel ?? null,
      reason: row.reason ?? null,
      reasonText: describeRouteReason(row.reason),
      score: row.score === null || row.score === undefined ? null : Number(row.score),
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      at: routeEventMillis(Number.isFinite(createdAt) && createdAt > 0 ? createdAt : row.createdAt),
    };
  });
}

export const lineDiagnosticsRouter = router({
  /**
   * 开一轮分段测速：入口 → 中转 1 → … 相邻两台自己的机器各测一次（下游开 iperf3 服务端、
   * 上游当客户端拨下游的入口地址，4 条并行 8 秒，先正向再反向），一段一段来。到落地那段跳过。
   * 立刻返回 runId 和初始进度，之后用 segmentSpeedStatus 轮询。
   */
  segmentSpeedStart: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive(), pathKey: z.string().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx.user);
      const rule = await requireRuleVisible(ctx.user, input.ruleId);
      const group = routeGroupOf(rule);
      if (!group) throw new Error("这条规则没有开线路组");
      const pathIndex = group.paths.findIndex((path) => path.key === input.pathKey);
      if (pathIndex < 0) throw new Error("这条路径不存在（可能刚被删掉或改过）");
      const path = group.paths[pathIndex];

      // 调度（拨第一跳）的机器：直连规则是入口机，隧道规则是隧道出口（和 routeStatus 同一个口径）。
      const tunnel = Number(rule.tunnelId || 0) > 0 ? await (db.getTunnelById(Number(rule.tunnelId)) as Promise<any>).catch(() => null) : null;
      const entryHostId = routeEntryHostId(Number(rule.hostId), tunnel);
      const hostIds = [entryHostId, ...path.hops].filter((id) => Number(id) > 0);
      const hosts = await requireHostsAccess(ctx, Array.from(new Set(hostIds))) as any[];
      const hostById = new Map<number, any>(hosts.map((host) => [Number(host.id), host]));
      const node = (hostId: number) => ({ hostId, name: String(hostById.get(hostId)?.name || `主机 ${hostId}`) });

      const dest = routePathDestination(path, rule);
      const plan = planLineSegments({
        entry: node(entryHostId),
        hops: path.hops.map(node),
        landing: { name: dest.ip ? formatHostAddressWithPort(dest.ip, dest.port || "") : "落地" },
      });
      const endpoints: Array<SegmentEndpoints | null> = plan.map((segment) => {
        if (segment.skipReason || segment.from.hostId === null || segment.to.hostId === null) return null;
        return {
          fromHostId: segment.from.hostId,
          toHostId: segment.to.hostId,
          toAddress: getHostEntryAddress(hostById.get(segment.to.hostId)),
        };
      });
      // 没装 Agent 的机器开不了 iperf3：提前说，不用等超时。
      for (const ends of endpoints) {
        if (!ends) continue;
        for (const hostId of [ends.fromHostId, ends.toHostId]) {
          const host = hostById.get(hostId);
          if (!String(host?.agentToken || "")) throw new Error(`「${host?.name || `主机 ${hostId}`}」没有绑定 Agent，没法在它上面跑 iperf3`);
        }
      }

      const { view } = startSegmentSpeedRun({
        ruleId: Number(rule.id),
        pathKey: path.key,
        pathName: `${routePathLetter(pathIndex)} ${routePathLabel(path, pathIndex)}`.trim(),
        userId: Number(ctx.user.id),
        allowPrivate: ctx.user.role === "admin",
        plan,
        endpoints,
      });
      return view;
    }),

  /** 一轮分段测速的进度：每段的状态和带宽（Mbit/s），测完后 slowest 指向瓶颈段。 */
  segmentSpeedStatus: protectedProcedure
    .input(z.object({ runId: z.string().min(8).max(64) }))
    .query(async ({ input, ctx }) => {
      const run = getSegmentSpeedRun(input.runId, ctx.user);
      if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "测速任务不存在或已过期" });
      return run;
    }),

  /**
   * 导出整条线路：此刻的状态（rules.routeStatus 同一份）、最近 hours 小时的线路事件、
   * 同一段时间的质量历史。format=json 给机器读，csv 给表格软件（三张表上下排）。
   */
  lineExport: protectedProcedure
    .input(z.object({
      ruleId: z.number().int().positive(),
      format: z.enum(["json", "csv"]).default("json"),
      hours: z.number().int().min(1).max(ROUTE_PATH_QUALITY_RETENTION_HOURS).default(24),
    }))
    .query(async ({ input, ctx }) => {
      const rule = await requireRuleVisible(ctx.user, input.ruleId);
      const group = routeGroupOf(rule);
      if (!group) throw new Error("这条规则没有开线路组");
      const nowMs = Date.now();
      const bucketMs = routeQualityBucketMs(input.hours);
      const [status, events, qualityRows] = await Promise.all([
        buildRouteStatus(rule),
        lineEventsSince(Number(rule.id), input.hours),
        getRoutePathQualityHistory(Number(rule.id), { sinceMs: nowMs - input.hours * 3600 * 1000 }).catch(() => []),
      ]);
      const byPath = new Map<string, typeof qualityRows>();
      for (const row of qualityRows) {
        const list = byPath.get(row.pathKey) || [];
        list.push(row);
        byPath.set(row.pathKey, list);
      }
      const quality = group.paths.map((path, index) => ({
        key: path.key,
        letter: routePathLetter(index),
        name: routePathLabel(path, index),
        points: bucketRouteQualityRows(byPath.get(path.key) || [], bucketMs),
      }));
      const ruleInfo = {
        id: Number(rule.id),
        name: String(rule.name || ""),
        protocol: status?.protocol ?? null,
        sourcePort: Number(rule.sourcePort || 0),
        entry: status?.entry ?? null,
      };
      if (input.format === "csv") {
        return {
          filename: lineExportFilename(ruleInfo.id, "csv", nowMs),
          contentType: "text/csv; charset=utf-8",
          body: lineExportToCsv({
            ruleId: ruleInfo.id,
            ruleName: ruleInfo.name,
            exportedAt: nowMs,
            paths: (status?.paths || []).map((path) => ({ ...path, hops: path.hops.map((hop) => ({ name: hop.name })) })),
            events,
            quality,
          }),
        };
      }
      const payload = scrubSecrets({
        exportedAt: new Date(nowMs).toISOString(),
        hours: input.hours,
        bucketMinutes: Math.round(bucketMs / 60_000),
        rule: ruleInfo,
        status,
        events,
        quality,
      });
      return {
        filename: lineExportFilename(ruleInfo.id, "json", nowMs),
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(payload, null, 2),
      };
    }),
  /** 线路编辑框的小闪电：一条（可能还没保存的）线路逐段测延迟。 */
  segmentLatencyStart: protectedProcedure
    .input(z.object({
      ruleId: z.number().int().nonnegative().optional(),
      entryHostId: z.number().int().positive(),
      hops: z.array(z.number().int().positive()).max(8),
      hopVia: z.array(z.number().int().positive().nullable()).max(8).optional(),
      dest: z.object({ ip: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535) }).nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.ruleId) await requireRuleVisible(ctx.user, input.ruleId);
      await requireHostsAccess(ctx, [input.entryHostId, ...input.hops]);
      const runId = await startLineSegmentLatency(ctx.user, { entryHostId: input.entryHostId, hops: input.hops, hopVia: input.hopVia, dest: input.dest }, input.ruleId || 0);
      return { runId };
    }),

  segmentLatencyStatus: protectedProcedure
    .input(z.object({ runId: z.string().min(1).max(96) }))
    .query(async ({ input, ctx }) => {
      const status = await lineSegmentLatencyStatus(ctx.user, input.runId);
      if (!status) throw new Error("测试已过期，请重新测");
      return status;
    }),
  /** 线路工作台的看板头：在线节点、近 24 小时告警、已自动恢复、最近几条。 */
  lineWorkspace: protectedProcedure
    .input(z.object({ hours: z.number().int().min(1).max(168).default(24) }).optional())
    .query(async ({ input, ctx }) => {
      const { lineWorkspace } = await import("../routeLineViews");
      return lineWorkspace(ctx.user, input?.hours ?? 24);
    }),

  /** 节点池那一页：节点池 + 入口组（DNS 记录逐条的状态）+ 出口组（每台的解锁结论），合成一种卡片。 */
  poolBoard: protectedProcedure.query(async ({ ctx }) => {
    const { poolBoard } = await import("../routeLineViews");
    return poolBoard(ctx.user);
  }),

  /** 节点池：列表 / 建 / 改 / 删 / 从入口组、出口组导入。池改了，用到它的线路自动重新展开。 */
  nodePools: protectedProcedure.query(async ({ ctx }) => {
    const { listNodePools, ruleIdsUsingPool } = await import("../nodePools");
    const pools = await listNodePools(ctx.user.role === "admin" ? null : ctx.user.id);
    const hostIds = Array.from(new Set(pools.flatMap((pool) => pool.hostIds)));
    const hosts = hostIds.length > 0 ? await db.getHostsByIds(hostIds) as any[] : [];
    const byId = new Map(hosts.map((host) => [Number(host.id), host]));
    const { routeTrippedNodeIds, routeSegmentLatencyEstimate } = await import("../routeGroupStats");
    void routeSegmentLatencyEstimate;
    const tripped = routeTrippedNodeIds();
    return Promise.all(pools.map(async (pool) => ({
      ...pool,
      usedBy: (await ruleIdsUsingPool(pool.id)).length,
      members: pool.hostIds.map((hostId) => {
        const host = byId.get(hostId);
        return {
          hostId,
          name: String(host?.name || `主机 ${hostId}`),
          online: host ? dbBool(host.isOnline) : false,
          maintenance: host ? dbBool(host.maintenanceMode) : false,
          tripped: tripped.has(hostId),
          countryCode: host?.countryCode ? String(host.countryCode) : null,
        };
      }),
    })));
  }),

  nodePoolSave: protectedProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(1).max(60),
      role: z.enum(["relay", "landing", "any"]).default("relay"),
      hostIds: z.array(z.number().int().positive()).max(32),
      note: z.string().trim().max(200).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const pools = await import("../nodePools");
      await requireHostsAccess(ctx, input.hostIds);
      const hostIds = Array.from(new Set(input.hostIds));
      if (input.id) {
        const existing = await pools.getNodePool(input.id);
        if (!existing || (ctx.user.role !== "admin" && existing.userId !== ctx.user.id)) throw new Error("节点池不存在");
        await pools.updateNodePool(input.id, { name: input.name, role: input.role, hostIds, note: input.note ?? null });
        const ruleIds = await pools.ruleIdsUsingPool(input.id);
        pools.logPoolReexpand(input.id, ruleIds);
        const { reexpandRouteLinesForRules } = await import("../routeLineExpansion");
        await reexpandRouteLinesForRules(ruleIds, "node-pool-updated");
        return { id: input.id, reexpanded: ruleIds.length };
      }
      const id = await pools.createNodePool({ userId: ctx.user.id, name: input.name, role: input.role, hostIds, note: input.note ?? undefined });
      return { id, reexpanded: 0 };
    }),

  nodePoolDelete: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const pools = await import("../nodePools");
      const existing = await pools.getNodePool(input.id);
      if (!existing || (ctx.user.role !== "admin" && existing.userId !== ctx.user.id)) throw new Error("节点池不存在");
      const ruleIds = await pools.ruleIdsUsingPool(input.id);
      if (ruleIds.length > 0) throw new Error(`还有 ${ruleIds.length} 条线路在用这个池：先在线路里换掉它`);
      await pools.deleteNodePool(input.id);
      return { ok: true };
    }),

  nodePoolImport: protectedProcedure
    .input(z.object({ groupId: z.number().int().positive(), role: z.enum(["relay", "landing", "any"]).default("relay") }))
    .mutation(async ({ input, ctx }) => {
      const group = await db.getForwardGroupById(input.groupId) as any;
      if (!group) throw new Error("组不存在");
      if (ctx.user.role !== "admin" && Number(group.userId) !== Number(ctx.user.id)) throw new Error("无权使用这个组");
      const hostIds = (group.members || [])
        .filter((member: any) => member.isEnabled !== false && member.isEnabled !== 0 && Number(member.hostId || 0) > 0)
        .map((member: any) => Number(member.hostId));
      if (hostIds.length === 0) throw new Error("这个组里没有主机成员");
      const pools = await import("../nodePools");
      const id = await pools.createNodePool({ userId: ctx.user.id, name: `${String(group.name || "组").slice(0, 50)}（导入）`, role: input.role, hostIds });
      return { id, members: hostIds.length };
    }),
  /**
   * 暂停 / 恢复一条线路（运行中那一屏的暂停按钮）：只改 paused，不重建中继。调度器拿到「已暂停」
   * 提示就不再往这条上发新连接；不能把所有线路都停掉。
   */
  linePause: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive(), lineKey: z.string().min(1).max(32), paused: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const viewed = await requireRuleVisible(ctx.user, input.ruleId);
      // 转发组的子规则照抄模板：暂停记在模板上，组同步带到每台成员机。
      const template = Number(viewed.forwardGroupRuleId || 0) > 0 ? await db.getForwardRuleById(Number(viewed.forwardGroupRuleId)) as any : null;
      const rule = template || viewed;
      if (ctx.user.role !== "admin" && Number(rule.userId) !== Number(ctx.user.id)) throw new Error("无权操作此规则");
      const { parseRoutePaths, serializeRoutePaths } = await import("@shared/routeGroup");
      const { routeLinesOf, serializeRouteLines } = await import("@shared/routeLines");
      const lines = routeLinesOf(rule);
      const paths = parseRoutePaths(rule.routePaths);
      const matches = (path: { key: string; lineKey?: string | null }) => (path.lineKey || path.key) === input.lineKey;
      if (!paths.some(matches)) throw new Error("这条线路不在了");
      const nextPaths = paths.map((path) => (matches(path) ? { ...path, paused: input.paused } : path));
      if (nextPaths.every((path) => path.paused)) throw new Error("不能把所有线路都暂停：至少留一条能走");
      const nextLines = lines.map((line) => (line.key === input.lineKey ? { ...line, paused: input.paused } : line));
      await db.updateForwardRule(Number(rule.id), {
        routePaths: serializeRoutePaths(nextPaths),
        ...(rule.routeLines ? { routeLines: serializeRouteLines(nextLines) } : {}),
      } as any);
      if (dbBool(rule.isForwardGroupTemplate) && Number(rule.forwardGroupId || 0) > 0) {
        await db.syncForwardGroupRules(Number(rule.forwardGroupId));
      } else {
        const { pushAgentRefresh } = await import("../agentEvents");
        const status = await buildRouteStatus({ ...rule, routePaths: serializeRoutePaths(nextPaths) });
        for (const hostId of status?.schedulerHostIds || [Number(rule.hostId)]) pushAgentRefresh(hostId, input.paused ? "route-line-paused" : "route-line-resumed", { urgent: true });
      }
      await db.insertForwardRuleRouteEvent({
        ruleId: Number(viewed.id),
        kind: input.paused ? "pinned" : "unpinned",
        fromKey: null,
        toKey: input.lineKey,
        fromLabel: null,
        toLabel: lines.find((line) => line.key === input.lineKey)?.name || input.lineKey,
        reason: `panel: ${input.paused ? "手动暂停这条线路" : "恢复这条线路"}`,
        score: null,
        latencyMs: null,
      } as any).catch(() => undefined);
      return { ok: true };
    }),
});
