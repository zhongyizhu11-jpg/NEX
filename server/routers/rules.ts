import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { crudRulesRouter, routeSchedulerHostIds } from "./rules.crud";
import { portsRulesRouter } from "./rules.ports";
import { selfTestRulesRouter } from "./rules.selfTest";
import { trafficRulesRouter } from "./rules.traffic";
import { canUseForwardRuleResource, getLinkAccessScope } from "../linkAccessView";
import { isManagedForwardGroupChildRule } from "../forwardRuleVisibility";
import { formatHostAddressWithPort, getHostEntryAddress } from "@shared/hostEntryAddress";
import {
  isForwardRuleProtocolTcpEnabled,
  isForwardRuleProtocolUdpEnabled,
  isUserspaceForwardType,
  normalizeForwardRuleProtocol,
} from "@shared/forwardTypes";
import { describeFailoverActiveLine } from "@shared/failoverActiveLine";
import {
  ROUTE_GROUP_AGENT_VERSION,
  describeRouteIssue,
  describeRouteReason,
  routeEventMillis,
  routeGroupIsForwardXTunnel,
  routeGroupOf,
  routeGroupSchedulerAgentVersion,
  routePathDestination,
  routePathDial,
  routePathLabel,
  routePathLetter,
} from "@shared/routeGroup";
import { routeScoreGrade } from "@shared/routeScore";
import { isAgentVersionBehind } from "@shared/version";
import { getRouteStatus, routeHopDownHints } from "../routeGroupStats";
import { routeRelayRulesByKey } from "../routeGroups";
import { dbBool } from "../repositories/repositoryUtils";
import { ruleTrafficQueryCache } from "../ruleLatencyQueryCache";
import { idSetFingerprint } from "../queryCache";

/** 看一条规则的线路状态：管理员随便看，别人只能看自己的。 */
async function requireRuleVisible(user: { id: number; role: string }, ruleId: number) {
  const rule = await db.getForwardRuleById(ruleId) as any;
  if (!rule || dbBool(rule.pendingDelete)) throw new Error("规则不存在或已删除");
  if (user.role !== "admin" && Number(rule.userId) !== Number(user.id)) throw new Error("无权查看此规则");
  return rule;
}

/**
 * 几台调度机里最旧的 Agent 版本。有一台读不到版本就返回空串：说不准它认不认，按不支持算，
 * 和心跳那边 isAgentVersionAtLeast("", …) 为假一致。
 */
export function oldestAgentVersion(versions: readonly string[]): string {
  let oldest = "";
  for (const version of versions) {
    if (!version) return "";
    if (!oldest || isAgentVersionBehind(version, oldest)) oldest = version;
  }
  return oldest;
}

async function withRuleResourceAccess<T extends any>(value: T, user: { id: number; role: string }): Promise<T> {
  if (user.role === "admin") return value;
  const scope = await getLinkAccessScope(user);
  const decorate = (rule: any) => ({
    ...rule,
    resourceAccessAllowed: canUseForwardRuleResource(rule, scope),
  });
  if (Array.isArray(value)) return value.map(decorate) as T;
  if (value && Array.isArray((value as any).items)) {
    return { ...value, items: (value as any).items.map(decorate) } as T;
  }
  return (value ? decorate(value) : value) as T;
}

/**
 * 给规则带上换隧道后仍在生效的旧入口桥接（server/ruleEntryBridges），卡片上据此说一句
 * 「旧入口 Po0 仍在转发（桥接至 …）」。只带界面要的几样：主机 id、主机名、到期时间。
 */
async function withRuleEntryBridges<T extends any>(value: T): Promise<T> {
  const list: any[] = Array.isArray(value)
    ? value
    : value && Array.isArray((value as any).items)
      ? (value as any).items
      : value ? [value] : [];
  const ruleIds = list.map((rule: any) => Number(rule?.id || 0)).filter((id) => id > 0);
  if (ruleIds.length === 0) return value;
  const bridgesByRule = await db.getActiveRuleEntryBridgesForRules(ruleIds).catch(() => new Map());
  if (bridgesByRule.size === 0) return value;
  const decorate = (rule: any) => {
    const bridges = bridgesByRule.get(Number(rule?.id || 0)) || [];
    if (!rule || bridges.length === 0) return rule;
    return {
      ...rule,
      entryBridges: bridges.map((bridge: any) => ({
        hostId: bridge.hostId,
        hostName: bridge.hostName,
        sourcePort: bridge.sourcePort,
        expiresAt: bridge.expiresAt,
      })),
    };
  };
  if (Array.isArray(value)) return value.map(decorate) as T;
  if (value && Array.isArray((value as any).items)) {
    return { ...value, items: (value as any).items.map(decorate) } as T;
  }
  return decorate(value) as T;
}

type RuleListCategory = "all" | "local" | "tunnel" | "chain" | "group";
type RuleResourceType = "local" | "tunnel" | "chain" | "group";
type RuleListFilters = {
  userId?: number;
  scope?: "self" | "all";
  entryHostId?: number | null;
  resourceType?: RuleResourceType | null;
  resourceId?: number | null;
  category: RuleListCategory;
  search: string;
};

async function getRuleListRepositoryInput(
  input: RuleListFilters,
  user: { id: number; role: string },
) {
  const isAdmin = user.role === "admin";
  const accessScope = isAdmin ? null : await getLinkAccessScope(user);
  const ownerUserId = isAdmin
    ? input.scope === "all"
      ? undefined
      : input.userId ?? user.id
    : user.id;
  return {
    ownerUserId,
    searchVisibleHostIds: accessScope
      ? Array.from(accessScope.useHostIds || accessScope.hostIds)
      : undefined,
    searchVisibleTunnelIds: accessScope
      ? Array.from(accessScope.useTunnelIds || accessScope.tunnelIds)
      : undefined,
    searchVisibleForwardGroupIds: accessScope
      ? Array.from(accessScope.useGroupIds || accessScope.groupIds)
      : undefined,
    entryHostId: input.entryHostId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    category: input.category,
    search: input.search,
  };
}

export const rulesRouter = router({
  /**
   * 线路组的「最近切换」：Agent 报的切换 / 异常 / 恢复 / 预热 / 预检没过，和面板这边的
   * 人工指定，按时间倒序。原因已经翻成人话（describeRouteReason），界面直接显示。
   */
  routeEvents: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive(), limit: z.number().int().min(1).max(100).optional() }))
    .query(async ({ input, ctx }) => {
      await requireRuleVisible(ctx.user, input.ruleId);
      const rows = await db.getForwardRuleRouteEvents(input.ruleId, input.limit ?? 20) as any[];
      return rows.map((row) => ({
        id: Number(row.id),
        kind: String(row.kind || ""),
        fromKey: row.fromKey ?? null,
        toKey: row.toKey ?? null,
        fromLabel: row.fromLabel ?? null,
        toLabel: row.toLabel ?? null,
        reason: row.reason ?? null,
        reasonText: describeRouteReason(row.reason),
        score: row.score ?? null,
        latencyMs: row.latencyMs ?? null,
        at: routeEventMillis(row.createdAt),
      }));
    }),
  /**
   * 线路组此刻的样子：每条路径走哪几跳、拨哪个地址、评分几分、哪一跳断了、现在走的是哪条。
   *
   * 评分和逐跳探测都是内存里的（routeGroupStats）：入口 Agent 每次心跳带评分，中转机的
   * Agent 一分钟报一次它那一跳。Agent 没升到 2.2.198 的，评分为空，界面据 agentSupportsScores
   * 说明「升级 Agent 后才有评分」。
   */
  routeStatus: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const rule = await requireRuleVisible(ctx.user, input.ruleId);
      const group = routeGroupOf(rule);
      if (!group) return null;
      const { paths, policy } = group;
      const status = getRouteStatus(Number(rule.id));
      const agent = status.agent || status.staleAgent;
      const hints = routeHopDownHints(Number(rule.id), paths);
      const hopIds = Array.from(new Set(paths.flatMap((path) => path.hops)));
      /*
        评分和预热跑在调度层那台机器上 —— GOST 隧道规则是隧道的出口机，不是规则的入口机。
        版本读错机器的话，界面会说「支持评分」而真正跑调度的那台 Agent 还是旧的（或者反过来）。
        负载均衡的隧道每个出口各跑一个调度器，心跳要每一台都够版本才下发 UDP 调度，所以这里
        按最旧的那台说（routeSchedulerHostIds 和心跳是同一个口径）。
      */
      const routeTunnel = Number((rule as any).tunnelId || 0) > 0
        ? await (db.getTunnelById(Number((rule as any).tunnelId)) as Promise<any>).catch(() => null)
        : null;
      const routeExitNodes = routeTunnel ? await db.getTunnelExitNodes(Number(routeTunnel.id)).catch(() => []) : [];
      const schedulerHostIds = routeSchedulerHostIds(Number(rule.hostId), routeTunnel, routeExitNodes);
      const [names, relays, schedulerHosts] = await Promise.all([
        hopIds.length > 0 ? db.getHostNamesByIds(hopIds) : Promise.resolve(new Map<number, string>()),
        routeRelayRulesByKey(Number(rule.id)),
        Promise.all(schedulerHostIds.map((hostId) => (db.getHostById(hostId) as Promise<any>).catch(() => null))),
      ]);
      const active = describeFailoverActiveLine(rule);
      const activeIndex = status.agent && status.agent.activeIndex >= 0 ? status.agent.activeIndex : (active ? active.index : -1);
      const rows = paths.map((path, index) => {
        const target = agent?.targets.find((item) => item.index === index) || null;
        const hint = hints.get(path.key) || null;
        const hops = path.hops.map((hostId, hopIndex) => {
          const probe = status.hops.find((item) => item.pathKey === path.key && item.hopIndex === hopIndex) || null;
          const relay = relays.get(`${path.key}:${hopIndex}`) as any;
          return {
            hostId,
            name: names.get(hostId) || `主机 ${hostId}`,
            port: relay ? Number(relay.sourcePort) : null,
            running: relay ? dbBool(relay.isRunning) : null,
            enabled: relay ? dbBool(relay.isEnabled) : null,
            ok: probe ? probe.ok : null,
            latencyMs: probe?.latencyMs ?? null,
            consecutiveFailures: probe?.consecutiveFailures ?? 0,
            probedAt: probe?.at ?? null,
            nextLabel: probe?.nextLabel ?? null,
          };
        });
        const down = !!target?.down || !!hint || !!path.issue;
        const downReason = path.issue || (hint ? hint.reason : target?.downReason || "");
        return {
          key: path.key,
          index,
          letter: routePathLetter(index),
          name: routePathLabel(path, index),
          hops,
          dest: routePathDestination(path, rule),
          dial: routePathDial(path, rule),
          issue: path.issue,
          weight: path.weight,
          probe: path.probe,
          score: target?.score ?? null,
          grade: routeScoreGrade(target?.score ?? null),
          latencyMs: target?.latencyMs ?? null,
          lossPct: target?.lossPct ?? null,
          jitterMs: target?.jitterMs ?? null,
          availabilityPct: target?.availabilityPct ?? null,
          healthy: target ? target.healthy && !down : null,
          down,
          downReason: describeRouteIssue(downReason),
          connections: target?.connections ?? null,
          samples: target?.samples ?? 0,
          active: activeIndex === index,
          prewarming: !!agent && agent.prewarmIndex === index,
        };
      });
      const agentVersion = oldestAgentVersion(schedulerHosts.map((schedulerHost) => String(schedulerHost?.agentVersion || "").trim()));
      /*
        UDP、TCP+UDP 和 NEX 隧道的线路组要 Agent 2.2.199 起才调度；更老的时候面板不下发
        调度，流量走路径 A、不切换（server/agentHeartbeatRoute.ts 的 routePrimaryEndpoint）。
        界面据 agentSupportsProtocol 把这件事说出来，别让人以为配了就生效；schedulerNeed 说是
        哪一样要新 Agent，界面的说法跟着换。
      */
      const protocol = normalizeForwardRuleProtocol((rule as any).protocol);
      const schedulerAgentVersion = routeGroupSchedulerAgentVersion(protocol, routeTunnel?.mode);
      const schedulerNeed = routeGroupIsForwardXTunnel(routeTunnel?.mode) ? "forwardx" : protocol !== "tcp" ? "udp" : null;
      return {
        ruleId: Number(rule.id),
        protocol,
        policy,
        paths: rows,
        activeIndex,
        activeSince: status.agent?.activeSince || (active?.since ? active.since * 1000 : null),
        prewarmIndex: agent?.prewarmIndex ?? -1,
        agentReportedAt: agent?.reportedAt ?? null,
        agentStale: !status.agent && !!status.staleAgent,
        agentVersion: agentVersion || null,
        agentSupportsScores: !!agentVersion && !isAgentVersionBehind(agentVersion, ROUTE_GROUP_AGENT_VERSION),
        agentSupportsProtocol: !schedulerAgentVersion || (!!agentVersion && !isAgentVersionBehind(agentVersion, schedulerAgentVersion)),
        requiredAgentVersion: schedulerAgentVersion || ROUTE_GROUP_AGENT_VERSION,
        schedulerNeed,
        tunnelMode: routeTunnel ? String(routeTunnel.mode || "") : null,
      };
    }),
  list: protectedProcedure
    .input(z.object({
      hostId: z.number().optional(),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      tunnelId: z.number().nullable().optional(),
      // 只要开了主备 / 线路组（failoverEnabled）的规则，线路组面板用。
      failoverOnly: z.boolean().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const requestedUserId = isAdmin
        ? input?.scope === "all"
          ? undefined
          : input?.userId ?? ctx.user.id
        : ctx.user.id;
      const rules = await db.getForwardRules(requestedUserId, input?.hostId, { failoverOnly: input?.failoverOnly === true });
      const filtered = input?.tunnelId === undefined
        ? rules
        : input.tunnelId === null
          ? rules.filter((rule: any) => !rule.tunnelId)
          : rules.filter((rule: any) => Number(rule.tunnelId || 0) === Number(input.tunnelId));
      return withRuleResourceAccess(await withRuleEntryBridges(filtered), ctx.user);
    }),
  listPage: protectedProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const page = await db.getForwardRulesPage({ ...repositoryInput, page: input.page, pageSize: input.pageSize });
      return withRuleResourceAccess(await withRuleEntryBridges(page), ctx.user);
    }),
  mapItems: protectedProcedure
    .input(z.object({
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(20).max(250).default(100),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const batch = await db.getForwardRuleMapBatch(repositoryInput, input.cursor || 0, input.limit);
      return withRuleResourceAccess(batch, ctx.user);
    }),
  listSummary: protectedProcedure
    .input(z.object({
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const selection = await db.getForwardRuleSummarySelection(repositoryInput);
      const sumRows = (rows: any[]) => rows.reduce((total, row) => ({
        bytesIn: total.bytesIn + Math.max(0, Number(row?.bytesIn) || 0),
        bytesOut: total.bytesOut + Math.max(0, Number(row?.bytesOut) || 0),
        connections: total.connections + Math.max(0, Number(row?.connections) || 0),
      }), { bytesIn: 0, bytesOut: 0, connections: 0 });
      const isAdmin = ctx.user.role === "admin";
      /*
        规则数照旧每次现查（便宜，增删规则后立刻对）；流量合计是整页最贵的一段，缓存 10 秒、
        过期后 60 秒内先回旧值再后台重算。键是「谁在看 + 选中的是哪些规则」：筛选条件不同但
        选中同一批规则时结果本来就一样；规则一增删指纹就变，不会拿旧集合的合计顶上。
        重置规则流量会清 ruleTrafficQueryCache。
      */
      const traffic = selection.ruleIds.length > 0
        ? await ruleTrafficQueryCache.get(
          `listSummary:${isAdmin ? "all" : `user:${ctx.user.id}`}:${idSetFingerprint(selection.ruleIds)}`,
          { ttlMs: 10_000, staleMs: 60_000 },
          async () => {
            const [totalRows, dailyRows] = await Promise.all([
              db.getTrafficCounterSummaryByRule({
                userId: isAdmin ? undefined : ctx.user.id,
                ruleIds: selection.ruleIds,
              }),
              db.getTrafficSummaryByRule({
                userId: isAdmin ? undefined : ctx.user.id,
                ruleIds: selection.ruleIds,
                since: new Date(Date.now() - 24 * 60 * 60 * 1000),
                // 这里只累加字节数和连接数，不需要每条规则的最新延迟 ——
                // 延迟那一段要再查 forward_rules / tcping_stats / forward_tests 好几次。
                includeLatency: false,
              }),
            ]);
            return { totalTraffic: sumRows(totalRows as any[]), dailyTraffic: sumRows(dailyRows as any[]) };
          },
        )
        : { totalTraffic: sumRows([]), dailyTraffic: sumRows([]) };
      return {
        totalItems: selection.totalItems,
        activeItems: selection.activeItems,
        totalTraffic: traffic.totalTraffic,
        dailyTraffic: traffic.dailyTraffic,
      };
    }),
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) return null;
      if (ctx.user.role !== "admin" && isManagedForwardGroupChildRule(rule)) return null;
      return withRuleResourceAccess(await withRuleEntryBridges(rule), ctx.user);
    }),
  /**
   * 能当「备用线路」用的中转。
   *
   * 主备的备用线路原来是个多行文本框，得自己手填 `地址:端口` —— 而面板里明明就有
   * 这些中转：它们是一条条指向落地的转发规则。手填的代价不只是麻烦：
   *
   *   · 填错了不会有任何提示，要等真出事那天才发现备用线路根本连不上；
   *   · 面板知道那台中转用的是哪种转发方式，而**这直接决定了健康检查有没有盲区**
   *     （用户态转发时，连得上只证明中转活着，它到落地那段断了照样探不出来）——
   *     手填的地址让面板没法把这件事告诉用户。
   *
   * 所以这里把候选列出来，连带每条的转发方式、它自己指向哪个落地一起给界面。
   * 界面据此可以当场说清楚：这条出站通到哪儿、和主线路是不是同一个落地、
   * 要不要另配探测目标。
   */
  relayCandidates: protectedProcedure
    .input(z.object({
      excludeRuleId: z.number().int().positive().optional(),
      /** 线路组转哪种协议；候选得转得了它。不传按 TCP（上一版的行为）。 */
      protocol: z.enum(["tcp", "udp", "both"]).optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const rules = await db.getForwardRules(isAdmin ? undefined : ctx.user.id);
      /*
        主机按**规则引用到的 id** 取，不按归属取。

        租户的规则可以跑在管理员的按量计费主机上 —— 按归属取的话这些中转会整批消失，
        而用户在自己的规则行上明明看得见它们。只查规则引用到的那些，也不会多暴露
        任何东西：规则本来就是他自己的。
      */
      const hostIds = Array.from(new Set((rules as any[])
        .map((rule: any) => Number(rule?.hostId || 0))
        .filter((hostId: number) => hostId > 0)));
      const hosts = hostIds.length > 0 ? await db.getHostsByIds(hostIds) : [];
      const hostById = new Map((hosts as any[]).map((host: any) => [Number(host.id), host]));
      const excluded = Number(input?.excludeRuleId || 0);
      const candidates: Array<{
        id: number;
        label: string;
        hostName: string;
        address: string;
        forwardType: string;
        userspaceRelay: boolean;
        targetIp: string;
        targetPort: number;
      }> = [];
      for (const rule of rules as any[]) {
        const id = Number(rule?.id || 0);
        if (!id || id === excluded) continue;
        // 候选得转得了这条线路组的协议（UDP 的挑 UDP 中转，TCP+UDP 两样都要），关掉的规则
        // 也不该出现在候选里 —— 选了等于配了一条一定连不上的备用线路。
        const needed = normalizeForwardRuleProtocol(input?.protocol);
        if (needed !== "udp" && !isForwardRuleProtocolTcpEnabled(rule?.protocol)) continue;
        if (needed !== "tcp" && !isForwardRuleProtocolUdpEnabled(rule?.protocol)) continue;
        if (rule?.isEnabled === false) continue;
        const sourcePort = Number(rule?.sourcePort || 0);
        if (!(sourcePort >= 1 && sourcePort <= 65535)) continue;
        const host = hostById.get(Number(rule?.hostId || 0));
        if (!host) continue;
        const entryAddress = getHostEntryAddress(host);
        if (!entryAddress) continue;
        candidates.push({
          id,
          label: String(rule?.name || `规则 #${id}`),
          hostName: String(host?.name || `主机 ${host?.id}`),
          address: formatHostAddressWithPort(entryAddress, sourcePort),
          forwardType: String(rule?.forwardType || ""),
          userspaceRelay: isUserspaceForwardType(rule?.forwardType),
          targetIp: String(rule?.targetIp || ""),
          targetPort: Number(rule?.targetPort || 0),
        });
      }
      return candidates;
    }),
  reorder: protectedProcedure
    .input(z.object({
      category: z.enum(["local", "tunnel", "chain", "group"]),
      ids: z.array(z.number().int().positive()).min(1),
      startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
    }))
    .mutation(async ({ input, ctx }) => {
      await db.reorderForwardRules(input.category, input.ids, ctx.user.role === "admin" ? undefined : ctx.user.id, input.startIndex);
      return { success: true };
    }),
  ...portsRulesRouter._def.procedures,
  ...crudRulesRouter._def.procedures,
  ...trafficRulesRouter._def.procedures,
  ...selfTestRulesRouter._def.procedures,
});
