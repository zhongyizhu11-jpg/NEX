import { nanoid } from "nanoid";
import { followBoundRulesToNode } from "../proxyNodeFollow";
import { z } from "zod";

import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import {
  parseProxyNodeLink,
  PROXY_NODE_PROTOCOL_LABELS,
  proxyNodeRequiresUdp,
  type ProxyNode,
  type ProxyNodeProtocol,
} from "../../shared/proxyNode";
import { PROXY_SUBSCRIPTION_FORMATS } from "../../shared/proxySubscription";
import { rulesMatchingProxyNode } from "../../shared/proxyNodeAutoBind";
import { PROXY_RULE_PRESETS } from "../../shared/proxyRuleset";
import {
  PROXY_NODE_AUTO_GROUPS,
  PROXY_SUBSCRIPTION_SKIP_LABELS,
  PROXY_SUBSCRIPTION_WARNING_LABELS,
} from "../../shared/proxySubscriptionPlan";
import { resolveProxyNodeHealth, type ProxyNodeProbeSample } from "../../shared/proxyNodeHealth";
import { normalizeProxyNodeResetDay } from "../../shared/proxyNodeQuota";
import { redactSharedProxyNodeRow } from "../../shared/proxyNodeShare";
import { pushAgentRefresh } from "../agentEvents";
import {
  normalizeProxySubAlias,
  normalizeProxySubTokenOptions,
  normalizeProxySubTokenScope,
  parseProxySubTokenOptions,
  parseProxySubTokenScope,
  PROXY_SUB_DEFAULT_TOKEN_OPTIONS,
  PROXY_SUB_EMPTY_SCOPE,
  serializeProxySubTokenOptions,
  serializeProxySubTokenScope,
} from "../../shared/proxySubTokenScope";
import { parseProxyCustomRules } from "../../shared/proxySubCustomRules";
import { normalizeProxySubSettings, PROXY_SUB_DEFAULT_SETTINGS, type ProxySubSettings } from "../../shared/proxySubSettings";
import {
  normalizeProxySubCustomGroups,
  PROXY_SUB_BUILTIN_PRELUDES,
  PROXY_SUB_TEMPLATE_TARGETS,
  validateProxySubTemplate,
} from "../../shared/proxySubTemplates";
import { normalizeProxySubSourceInterval, normalizeProxySubSourceUrl, PROXY_SUB_SOURCE_MODES } from "../../shared/proxySubSource";
import { PROXY_CLIENT_FAMILY_LABELS } from "../../shared/proxyClientUserAgent";
import { PROXY_SUBSCRIPTION_SKIP_LABELS as SKIP_LABELS } from "../../shared/proxySubscriptionPlan";
import { loadProxySubSettings, saveProxySubSettings } from "../proxySubSettings";
import { infoNodesWanted, loadProxySubTokenContext, resolveTemplateForToken } from "../proxySubBundle";
import { syncProxySubSource } from "../proxySubSourceSync";
import { invalidateProxySubCacheForUser } from "../proxySubCache";
import { clearProxySubRateLimitForToken } from "../proxySubRateLimit";
import { buildInboundExit, buildNodeExit } from "../exitQualityView";
import { exitCheckStatusForNode, exitCheckToHostView, speedTestStatusForEntry, startExitCheckForNode, startSpeedTestForEntry } from "../nodeCheckView";
import { NodeCheckError } from "../ops/nodeCheck";
import { buildSubscriptionRouteView } from "../subscriptionRouteView";

/**
 * 订阅令牌够长才安全：地址里带着全部节点凭据，一旦可猜就等于把节点送人。
 */
const SUBSCRIPTION_TOKEN_LENGTH = db.PROXY_SUB_TOKEN_LENGTH;

function nodeToRow(node: ProxyNode, sourceLink: string) {
  return {
    protocol: node.protocol,
    sourceLink: sourceLink || null,
    address: node.address,
    port: node.port,
    uuid: node.uuid || null,
    password: node.password || null,
    method: node.method || null,
    alterId: node.alterId,
    flow: node.flow || null,
    transport: node.transport,
    path: node.path || null,
    host: node.host || null,
    tls: node.tls,
    sni: node.sni || null,
    alpn: node.alpn.length ? node.alpn.join(",") : null,
    fingerprint: node.fingerprint || null,
    certSha256: node.certSha256 || null,
    allowInsecure: node.allowInsecure,
    realityPublicKey: node.realityPublicKey || null,
    realityShortId: node.realityShortId || null,
    udp: node.udp,
    obfs: node.obfs || null,
    obfsPassword: node.obfsPassword || null,
    upMbps: node.upMbps || 0,
    downMbps: node.downMbps || 0,
    congestionControl: node.congestionControl || null,
    udpRelayMode: node.udpRelayMode || null,
    disableSni: node.disableSni,
    snellVersion: node.snellVersion,
    snellMode: node.snellMode || null,
    xhttpMode: node.xhttpMode || null,
  };
}

/**
 * 客户端订阅是一项独立授权：管理员始终可用，普通用户要么被手动授权，要么其
 * 在用套餐附带该权限。超流量或被暂停时权限会被回收（见 billingRepository），
 * 这里读的就是合并后的有效值。
 */
async function hasProxySubscriptionPermission(ctx: any): Promise<boolean> {
  if (ctx.user.role === "admin") return true;
  const user = await db.getUserById(ctx.user.id);
  return !!user?.allowProxySubscription;
}

/** 节点菜单里的检查只能对自己的节点做（管理员看全部）。 */
async function ownedNodeForCheck(ctx: any, nodeId: number) {
  const node = await db.getProxyNodeById(nodeId);
  if (!node || (ctx.user.role !== "admin" && Number(node.userId) !== Number(ctx.user.id))) throw new Error("节点不存在");
  return node;
}

async function assertProxySubscriptionAllowed(ctx: any) {
  if (!await hasProxySubscriptionPermission(ctx)) {
    throw new Error("当前账号没有客户端订阅权限，请联系管理员开通");
  }
}

async function assertOwnedNode(id: number, ctx: any) {
  const node = await db.getProxyNodeById(id);
  if (!node) throw new Error("客户端节点不存在");
  if (ctx.user.role !== "admin" && node.userId !== ctx.user.id) throw new Error("无权操作该客户端节点");
  return node;
}

async function assertOwnedRule(id: number, ctx: any) {
  const rule = await db.getForwardRuleById(id);
  if (!rule) throw new Error("转发规则不存在");
  if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作该转发规则");
  return rule;
}

async function assertOwnedToken(id: number, ctx: any) {
  const token = await db.getProxySubTokenById(id);
  if (!token) throw new Error("订阅链接不存在");
  if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) throw new Error("无权操作该订阅链接");
  return token;
}

/**
 * 刚建好一个落地节点，把已经指向它的转发接上。
 *
 * 先有转发、后加节点是很常见的顺序：机器先跑起来，过几天才想起来「这条其实可以
 * 进订阅」。只有正向自动绑定（建转发时认节点）的话，这些早就存在的转发永远不会
 * 自己进订阅 —— 而它们本来就是通往这个节点的，用户得一条条去预览弹窗里手动绑。
 *
 * 这个方向比正向更安全：节点是**刚建的**，在它存在之前谁也没机会「手动解绑」，
 * 所以不存在「他解绑了、面板又给他绑回去」。已经绑着别的节点的仍然不动。
 *
 * 返回接上了几条，交给界面说出来 —— 面板替人做的事都要看得见。
 */
async function adoptRulesForNewProxyNode(
  userId: number,
  nodeId: number,
  node: { address?: unknown; port?: unknown },
): Promise<number> {
  try {
    const rules = await db.getForwardRules(Number(userId));
    const matched = rulesMatchingProxyNode(
      // 共享 TLS 入站上的规则入口是用户自己的域名 + 入站端口，订阅生成不了正确地址，不接。
      (rules as any[]).filter((rule) => !(Number(rule.tlsInboundId || 0) > 0)).map((rule) => ({
        id: Number(rule.id),
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        proxyNodeId: rule.proxyNodeId,
      })),
      { address: (node as any)?.address, port: (node as any)?.port },
    );
    for (const rule of matched) {
      await db.updateForwardRule(rule.id, { proxyNodeId: Number(nodeId), proxyNodeVisible: true } as any);
    }
    if (matched.length > 0) {
      console.info(`[Subscription] node=${nodeId} adopted ${matched.length} existing rule(s)`);
    }
    return matched.length;
  } catch (error) {
    // 锦上添花的一步，不能让它把「加节点」这件事整个搞失败。
    console.warn("[Subscription] adopt rules failed:", error instanceof Error ? error.message : error);
    return 0;
  }
}

/** 令牌上可以改的新东西：作用域、外观选项、别名、备注、到期、设备数、模板。create / update 共用。 */
const tokenExtraInput = {
  alias: z.string().trim().max(32).nullable().optional(),
  remark: z.string().trim().max(200).nullable().optional(),
  /** ISO 时间或 null（= 不过期）。 */
  expiresAt: z.string().max(64).nullable().optional(),
  maxDevices: z.number().int().min(0).max(1000).optional(),
  templateId: z.number().int().min(0).optional(),
  scope: z.any().optional(),
  options: z.any().optional(),
};

async function normalizeTokenExtra(input: Record<string, any>, exceptTokenId: number): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};
  if (input.alias !== undefined) {
    if (!input.alias) data.alias = null;
    else {
      const alias = normalizeProxySubAlias(input.alias);
      if (!alias) throw new Error("短链别名只能用 4–32 位小写字母、数字和连字符，首尾不能是连字符");
      if (await db.proxySubAliasInUse(alias, exceptTokenId)) throw new Error("这个短链别名已经被用了");
      data.alias = alias;
    }
  }
  if (input.remark !== undefined) data.remark = input.remark || null;
  if (input.expiresAt !== undefined) {
    if (!input.expiresAt) data.expiresAt = null;
    else {
      const date = new Date(input.expiresAt);
      if (!Number.isFinite(date.getTime())) throw new Error("到期时间格式不对");
      data.expiresAt = date;
    }
  }
  if (input.maxDevices !== undefined) data.maxDevices = input.maxDevices;
  if (input.templateId !== undefined) {
    if (input.templateId > 0 && !(await db.getProxySubTemplateById(input.templateId))) throw new Error("模板不存在");
    data.templateId = input.templateId;
  }
  if (input.scope !== undefined) data.scopeJson = serializeProxySubTokenScope(normalizeProxySubTokenScope(input.scope ?? PROXY_SUB_EMPTY_SCOPE));
  if (input.options !== undefined) {
    const options = normalizeProxySubTokenOptions(input.options ?? PROXY_SUB_DEFAULT_TOKEN_OPTIONS);
    const parsed = parseProxyCustomRules(options.customRules);
    if (parsed.errors.length > 0) throw new Error(`自定义规则第 ${parsed.errors[0].line} 行：${parsed.errors[0].message}`);
    data.optionsJson = serializeProxySubTokenOptions(options);
  }
  return data;
}

function normalizeProxyRulePresetSafe(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  return (PROXY_RULE_PRESETS as readonly string[]).includes(raw) ? raw as (typeof PROXY_RULE_PRESETS)[number] : "balanced";
}

function safeJson(value: unknown) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function assertOwnedSource(id: number, ctx: any) {
  const source = await db.getProxySubSourceById(id);
  if (!source) throw new Error("外部订阅不存在");
  if (ctx.user.role !== "admin" && Number((source as any).userId) !== ctx.user.id) throw new Error("无权操作该外部订阅");
  return source;
}

/** 外部订阅：全局开关开着，且（管理员，或套餐允许）。 */
async function assertExternalSourcesAllowed(ctx: any) {
  const settings = await loadProxySubSettings();
  if (!settings.externalSourcesEnabled) throw new Error("管理员没有开放外部订阅");
  if (ctx.user.role === "admin") return;
  const plan = await db.getUserPlanSubscriptionInfo(ctx.user.id);
  if (!plan.allowExternalSubSources) throw new Error("当前套餐不包含外部订阅，请联系管理员");
}

/** 列表里的池节点带上它的落地池：名字、几台、几台能用、直连域名。 */
async function landingPoolNodeInfo(nodes: readonly any[]) {
  type MemberLine = { hostId: number; name: string; port: number; portFallback: boolean; error: string | null };
  const result = new Map<number, { id: number; name: string; members: number; ready: number; directDomain: string | null; summary: string; memberList: MemberLine[] }>();
  const poolIds = Array.from(new Set(nodes.map((node) => Number(node.nodePoolId || 0)).filter((id) => id > 0)));
  if (poolIds.length === 0) return result;
  const { getNodePool } = await import("../nodePools");
  const { describeLandingConfig, parseLandingConfig, parseLandingState } = await import("../../shared/landingPool");
  for (const poolId of poolIds) {
    const pool = await getNodePool(poolId).catch(() => null);
    if (!pool) continue;
    const config = parseLandingConfig(pool.landingJson);
    const states = parseLandingState(pool.landingStateJson);
    const hosts = pool.hostIds.length > 0 ? await db.getHostsByIds(pool.hostIds) as any[] : [];
    result.set(poolId, {
      id: pool.id,
      name: pool.name,
      members: pool.hostIds.length,
      ready: states.filter((state) => !state.error && state.inboundId > 0).length,
      directDomain: pool.directDomain || null,
      summary: config ? describeLandingConfig(config) : "",
      // 每台开在哪个端口（换了端口的、没开出来的标出来）：池节点那一行点开看
      memberList: pool.hostIds.map((hostId) => {
        const state = states.find((item) => item.hostId === hostId);
        const host = hosts.find((item) => Number(item.id) === hostId);
        return { hostId, name: String(host?.name || `主机 ${hostId}`), port: state?.port || 0, portFallback: !!state?.portFallback, error: state ? state.error : "还没同步" };
      }),
    });
  }
  return result;
}

/**
 * 池节点是照落地池派生的（server/landingPools.ts）：名字、地址、凭据、启停、备注每次同步都会改回去，
 * 在这里改了也留不住，所以直接说去哪改。地区、带宽、额度、前置、选路组这些池不管，照常能改；
 * 「直连进订阅」要池设了直连域名才有意义。
 */
async function assertLandingPoolNodeEdit(id: number, input: { link?: string; name?: string; remark?: string | null; isEnabled?: boolean; includeDirect?: boolean }) {
  const node = await db.getProxyNodeById(id) as any;
  const poolId = Number(node?.nodePoolId || 0);
  if (!(poolId > 0)) return;
  if (input.link !== undefined || input.name !== undefined || input.remark !== undefined || input.isEnabled !== undefined) {
    throw new Error("这是落地池的节点：名字、协议、密钥和启停都在 链路管理 → 节点池 里改（每台一起改）");
  }
  if (input.includeDirect === true) {
    const { getNodePool } = await import("../nodePools");
    const pool = await getNodePool(poolId);
    if (!pool?.directDomain) throw new Error("落地池没设直连域名：订阅里只走中转。要直连，先在节点池里给它设一个域名");
  }
}

export const proxySubscriptionsRouter = router({
  /** 解析一条节点链接但不落库，供界面在保存前预览与报错。 */
  parseLink: protectedProcedure
    .input(z.object({ link: z.string().min(1).max(8192) }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const result = parseProxyNodeLink(input.link);
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, node: result.node };
    }),

  /** 当前账号是否可用客户端订阅，界面据此决定是否展示整个页面。 */
  permission: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "admin") return { allowed: true };
    const user = await db.getUserById(ctx.user.id);
    return { allowed: !!user?.allowProxySubscription };
  }),

  listNodes: protectedProcedure.query(async ({ ctx }) => {
    if (!await hasProxySubscriptionPermission(ctx)) return [];
    // 落地池里为分享单独发的那几份凭据不列在主人这边：它们只为收件人存在（和订阅里不出是一个口径）
    const nodes = (await db.getProxyNodesByUser(ctx.user.id) as any[]).filter((node) => !(Number(node.poolSharedUserId || 0) > 0));
    const poolInfo = await landingPoolNodeInfo(nodes);
    const shareUserIds = await db.getProxyNodeShareUserIds(nodes.map((node: any) => Number(node.id)));
    const ruleIdsByNode = await db.getRuleIdsUsingProxyNodes(nodes.map((node: any) => Number(node.id)));
    const allRuleIds = Array.from(new Set(Array.from(ruleIdsByNode.values()).flat()));

    /**
     * 探测结果一次查完。
     *
     * 走 getTrafficSummaryByRule 是因为它顺带带回每条规则最近一次 tcping ——
     * 探测目标就是这条转发的落地地址，所以规则的探测结果直接就是
     * 「这个落地通不通」。这里只要探测，流量走 proxy_nodes.trafficUsed
     * 那个累计列（traffic_stats 只留 72 小时，累计量算不回来）。
     */
    const summary = allRuleIds.length > 0
      ? await db.getTrafficSummaryByRule({ userId: ctx.user.id, ruleIds: allRuleIds })
      : [];
    const byRule = new Map<number, any[]>();
    for (const row of summary as any[]) {
      const list = byRule.get(Number(row.ruleId)) || [];
      list.push(row);
      byRule.set(Number(row.ruleId), list);
    }

    const owned = nodes.map((node: any) => {
      const ruleIds = ruleIdsByNode.get(Number(node.id)) || [];
      const samples: ProxyNodeProbeSample[] = [];
      for (const ruleId of ruleIds) {
        for (const row of byRule.get(ruleId) || []) {
          const at = row.latestLatencyAt ? new Date(row.latestLatencyAt).getTime() : 0;
          if (at > 0) {
            samples.push({
              latencyMs: row.latestLatencyMs === null || row.latestLatencyMs === undefined
                ? null
                : Number(row.latestLatencyMs),
              isTimeout: !!row.latestLatencyIsTimeout,
              at,
            });
          }
        }
      }
      return {
        ...node,
        ruleCount: ruleIds.length,
        health: resolveProxyNodeHealth(samples),
        sharedToUserIds: shareUserIds.get(Number(node.id)) || [],
        sharedFrom: false,
        // 落地池的池节点：池名、几台、几台能用、直连域名（界面标「落地池 · 3 台」，点过去到节点池）
        landingPool: poolInfo.get(Number(node.nodePoolId || 0)) || null,
      };
    });

    /**
     * 别人分享给我的节点也列出来，否则订阅里凭空多出几条，用户在管理页找不到
     * 它们是哪来的。这些行是只读的 —— 编辑与删除在服务端本来就按 userId 挡着，
     * 界面据 sharedFrom 把入口收起来，别让人点进去才发现改不了。
     */
    const shared = await db.getProxyNodesSharedToUser(ctx.user.id);
    if (shared.length === 0) return owned;
    const sharedPoolInfo = await landingPoolNodeInfo(shared as any[]);
    const sharedRows = shared.map((node: any) => ({
      ...redactSharedProxyNodeRow(node),
      landingPool: sharedPoolInfo.get(Number(node.nodePoolId || 0)) || null,
      // 分享进来的节点只可能以直连形态出现：收方名下没有绑着它的转发。
      includeDirect: true,
      frontProxyId: 0,
      ruleCount: 0,
      health: resolveProxyNodeHealth([]),
      sharedToUserIds: [] as number[],
      /**
       * 只标「这是分享来的」，不带节点主人是谁。
       *
       * 原来带的是主人的显示名，而显示名没设时会退到 username —— 这个面板的
       * username 就是邮箱，于是租户在自己的页面上看到了管理员的邮箱地址。
       * 租户拿这个身份也做不了任何事，不该发出去。
       */
      sharedFrom: true,
    }));
    return [...owned, ...sharedRows];
  }),

  /**
   * 这些节点各自分享给了谁。
   *
   * 管理员专用：要选人就得先能列用户，而用户清单本来就只有管理员看得到。
   * 普通用户在自己的节点行上看到的是「已分享 N」这个计数，不含是谁。
   */
  nodeShares: adminProcedure
    .input(z.object({ nodeIds: z.array(z.number().int().positive()).max(100) }))
    .query(async ({ input }) => {
      const map = await db.getProxyNodeShareUserIds(input.nodeIds);
      return Array.from(map.entries()).map(([nodeId, userIds]) => ({ nodeId, userIds }));
    }),

  /** 设定这个节点分享给谁（全量替换）。 */
  setNodeShares: adminProcedure
    .input(z.object({
      nodeId: z.number().int().positive(),
      userIds: z.array(z.number().int().positive()).max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const node = await db.getProxyNodeById(input.nodeId);
      if (!node) throw new Error("客户端节点不存在");
      /**
       * 凭据的名字用收件人的用户名：派生出来的节点叫「入站名 · 小王」，主人
       * 一眼看得出这份是给谁的。取不到就退到 #id，不阻断分享。
       */
      const labels = new Map<number, string>();
      for (const userId of input.userIds) {
        const target = await db.getUserById(userId);
        const label = String((target as any)?.username || (target as any)?.name || "").trim();
        if (label) labels.set(Number(userId), label);
      }
      const { hostIds } = await db.setProxyNodeShareUsers(input.nodeId, input.userIds, { labels });
      // 多凭据入站上分享等于改了那个端口的用户表，要重下发，否则新凭据连不上。
      for (const hostId of hostIds) pushAgentRefresh(hostId, `proxy-node-share-${input.nodeId}`, { urgent: true });
      console.info(`[ProxyNode] Updated shares nodeId=${input.nodeId} count=${input.userIds.length} hosts=${hostIds.length} by=${ctx.user.id}`);
      return { success: true };
    }),

  createNode: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(64),
      // 与 updateNode 一致收 null：界面上清空备注就是 null，两个入口用同一份 payload。
      remark: z.string().trim().max(200).nullable().optional(),
      /** 对外标注：分享给别人时对方看得到的那一句。remark 是自己看的，两回事。 */
      publicLabel: z.string().trim().max(40).nullable().optional(),
      link: z.string().min(1).max(8192),
      autoGroup: z.enum(PROXY_NODE_AUTO_GROUPS).optional(),
      includeDirect: z.boolean().optional(),
      frontProxyId: z.number().int().min(0).optional(),
      bandwidthMbps: z.number().int().min(0).max(1_000_000).optional(),
      trafficLimit: z.number().int().min(0).optional(),
      trafficAutoReset: z.boolean().optional(),
      trafficResetDay: z.number().int().min(1).max(31).optional(),
      /** 手工指定地区（国家码）。 */
      countryCode: z.string().trim().max(8).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const parsed = parseProxyNodeLink(input.link);
      if (!parsed.ok) throw new Error(parsed.error);
      const countryCode = String(input.countryCode || "").trim().toUpperCase();
      if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) throw new Error("地区要填两位国家码，比如 HK、JP");
      const id = await db.createProxyNode({
        userId: ctx.user.id,
        name: input.name,
        remark: input.remark || null,
        publicLabel: input.publicLabel || null,
        countryCode: countryCode || null,
        ...(input.autoGroup ? { autoGroup: input.autoGroup } : {}),
        ...(input.includeDirect !== undefined ? { includeDirect: input.includeDirect } : {}),
        ...(input.frontProxyId !== undefined ? { frontProxyId: input.frontProxyId } : {}),
        ...(input.bandwidthMbps !== undefined ? { bandwidthMbps: input.bandwidthMbps } : {}),
        ...(input.trafficLimit !== undefined ? { trafficLimit: input.trafficLimit } : {}),
        ...(input.trafficAutoReset !== undefined ? { trafficAutoReset: input.trafficAutoReset } : {}),
        ...(input.trafficResetDay !== undefined
          ? { trafficResetDay: normalizeProxyNodeResetDay(input.trafficResetDay) }
          : {}),
        ...nodeToRow(parsed.node, input.link),
      } as any);
      const adopted = await adoptRulesForNewProxyNode(ctx.user.id, Number(id), parsed.node);
      return { id, adoptedRuleCount: adopted };
    }),

  updateNode: protectedProcedure
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(64).optional(),
      remark: z.string().trim().max(200).nullable().optional(),
      /** 对外标注：分享给别人时对方看得到的那一句。remark 是自己看的，两回事。 */
      publicLabel: z.string().trim().max(40).nullable().optional(),
      link: z.string().min(1).max(8192).optional(),
      isEnabled: z.boolean().optional(),
      autoGroup: z.enum(PROXY_NODE_AUTO_GROUPS).optional(),
      includeDirect: z.boolean().optional(),
      frontProxyId: z.number().int().min(0).optional(),
      /** 落地机的套餐规格。带宽 Mbps，0 表示没填。 */
      bandwidthMbps: z.number().int().min(0).max(1_000_000).optional(),
      /** 套餐总流量（字节），0 表示不限。 */
      trafficLimit: z.number().int().min(0).optional(),
      trafficAutoReset: z.boolean().optional(),
      trafficResetDay: z.number().int().min(1).max(31).optional(),
      /** 手工校准已用量，用来跟机房账单对齐。之后仍然继续累加。 */
      trafficUsed: z.number().int().min(0).optional(),
      /** 手工指定地区（国家码），空字符串 = 清掉、按机器 geo / 名字猜。 */
      countryCode: z.string().trim().max(8).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedNode(input.id, ctx);
      await assertLandingPoolNodeEdit(input.id, input);
      const data: Record<string, unknown> = {};
      if (input.countryCode !== undefined) {
        const code = String(input.countryCode || "").trim().toUpperCase();
        if (code && !/^[A-Z]{2}$/.test(code)) throw new Error("地区要填两位国家码，比如 HK、JP");
        data.countryCode = code || null;
      }
      if (input.bandwidthMbps !== undefined) data.bandwidthMbps = input.bandwidthMbps;
      if (input.trafficLimit !== undefined) data.trafficLimit = input.trafficLimit;
      if (input.trafficAutoReset !== undefined) data.trafficAutoReset = input.trafficAutoReset;
      if (input.trafficResetDay !== undefined) {
        // 收敛到 1-31：29/30/31 会按当月天数夹到月末，
        // 而界面上看不出原因。
        data.trafficResetDay = normalizeProxyNodeResetDay(input.trafficResetDay);
      }
      if (input.trafficUsed !== undefined) data.trafficUsed = input.trafficUsed;
      if (input.name !== undefined) data.name = input.name;
      if (input.remark !== undefined) data.remark = input.remark || null;
      if (input.publicLabel !== undefined) data.publicLabel = input.publicLabel || null;
      if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
      if (input.autoGroup !== undefined) data.autoGroup = input.autoGroup;
      if (input.includeDirect !== undefined) data.includeDirect = input.includeDirect;
      if (input.frontProxyId !== undefined) {
        // 自己指向自己会在渲染时造出一条指向自身的链，客户端行为不可预期。
        if (input.frontProxyId === input.id) throw new Error("前置代理不能指向节点自己");
        data.frontProxyId = input.frontProxyId;
      }
      if (input.link !== undefined) {
        const parsed = parseProxyNodeLink(input.link);
        if (!parsed.ok) throw new Error(parsed.error);
        Object.assign(data, nodeToRow(parsed.node, input.link));
      }
      if (Object.keys(data).length === 0) return { success: true };
      const before = await db.getProxyNodeById(input.id) as any;
      await db.updateProxyNode(input.id, data as any);
      if (input.link !== undefined && before
        && (String(before.address || "") !== String((data as any).address || "") || Number(before.port) !== Number((data as any).port))) {
        // 换了链接、地址端口变了：绑着它的转发和线路组路径跟着改。
        await followBoundRulesToNode(input.id, `proxy-node-link-${input.id}`);
      }
      return { success: true };
    }),

  /** 已用流量清零。换套餐周期或刚跟机房对完账时用。 */
  resetNodeTraffic: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedNode(input.id, ctx);
      await db.resetProxyNodeTraffic(input.id);
      return { success: true };
    }),

  deleteNode: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedNode(input.id, ctx);
      const poolNode = await db.getProxyNodeById(input.id) as any;
      if (Number(poolNode?.nodePoolId || 0) > 0) throw new Error("这是落地池的节点：到 链路管理 → 节点池 里删掉整个池，或者把池改回中转");
      // 引用它的转发会被自动解绑，只是不再进订阅，转发本身照常运行。
      const released = await db.countRulesUsingProxyNode(input.id);
      // 套餐里的绑定也会被清掉 —— 那会改变正在卖的东西，得说出来。
      const releasedPlans = await db.countPlansUsingProxyNode(input.id);
      await db.deleteProxyNode(input.id);
      return { success: true, releasedRules: released, releasedPlans };
    }),

  /**
   * 把一条转发绑定到节点模板；proxyNodeId 传 null 表示解绑，该转发不再进订阅。
   * 转发本身的运行不受影响，这里只决定它要不要出现在客户端订阅里。
   */
  bindRule: protectedProcedure
    .input(z.object({
      ruleId: z.number().int().positive(),
      proxyNodeId: z.number().int().positive().nullable(),
      proxyNodeName: z.string().trim().max(64).nullable().optional(),
      proxyNodeVisible: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const rule = await assertOwnedRule(input.ruleId, ctx);
      if (input.proxyNodeId !== null && Number((rule as any).tlsInboundId || 0) > 0) {
        throw new Error("共享 TLS 入站上的规则暂不支持绑定到订阅节点（入口是你自己的域名）");
      }
      if (input.proxyNodeId !== null) {
        const node = await assertOwnedNode(input.proxyNodeId, ctx);
        /**
         * Hysteria2 与 TUIC 跑在 QUIC 上，全程只用 UDP。绑到一条只放行 TCP 的
         * 转发上，客户端能导入、能识别协议，握手却永远收不到回包 —— 报出来只是
         * 一句超时。这里直接拦住并说清要改什么，比事后排查省事得多。
         */
        if (proxyNodeRequiresUdp(node.protocol) && String(rule.protocol || "").toLowerCase() === "tcp") {
          throw new Error(
            `${PROXY_NODE_PROTOCOL_LABELS[node.protocol as ProxyNodeProtocol] || node.protocol} 走 QUIC，只用 UDP；`
            + "这条转发目前只放行 TCP，请先把转发协议改成 UDP 或 TCP+UDP",
          );
        }
      }
      const data: Record<string, unknown> = { proxyNodeId: input.proxyNodeId };
      if (input.proxyNodeName !== undefined) data.proxyNodeName = input.proxyNodeName || null;
      if (input.proxyNodeVisible !== undefined) data.proxyNodeVisible = input.proxyNodeVisible;
      // 重新绑定时默认恢复显示，否则用户换了模板却看不到节点会以为没生效。
      if (input.proxyNodeId !== null && input.proxyNodeVisible === undefined && !rule.proxyNodeId) {
        data.proxyNodeVisible = true;
      }
      await db.updateForwardRule(input.ruleId, data as any);
      return { success: true };
    }),

  /** 单独控制某个节点是否出现在订阅里，不解除绑定。 */
  setRuleVisible: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive(), visible: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedRule(input.ruleId, ctx);
      await db.updateForwardRule(input.ruleId, { proxyNodeVisible: input.visible } as any);
      return { success: true };
    }),

  /**
   * 改订阅里显示的节点名。
   *
   * 传空字符串表示恢复默认（由主机名、模板名、转发名拼出来的那个）。名字只影响
   * 订阅里的显示，转发规则本身不受影响。
   */
  setRuleNodeName: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive(), name: z.string().trim().max(64) }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedRule(input.ruleId, ctx);
      await db.updateForwardRule(input.ruleId, { proxyNodeName: input.name || null } as any);
      return { success: true };
    }),

  /** 预览订阅内容：进订阅的节点，以及每条被排除的转发和原因。 */
  preview: protectedProcedure.query(async ({ ctx }) => {
    if (!await hasProxySubscriptionPermission(ctx)) return { groups: [], nodes: [], skipped: [], warnings: [] };
    // 一次读库出这两样：分开取的话，中间有人动了转发，
    // 策略组和节点清单就会互相对不上（见 getProxySubscriptionPreviewForUser）。
    const { plan, document } = await db.getProxySubscriptionPreviewForUser(ctx.user.id);
    return {
      groups: document.groups
        .filter((group) => group.type !== "select")
        .map((group) => ({ name: group.name, type: group.type, members: group.members, weights: group.weights ?? null })),
      nodes: plan.entries.map((entry) => ({
        ruleId: entry.ruleId,
        templateId: entry.templateId,
        // direct 的条目不来自任何转发规则（ruleId 为 0），改名和显隐都要落到模板上。
        kind: entry.kind,
        name: entry.node.name,
        protocol: entry.node.protocol,
        address: entry.node.address,
        port: entry.node.port,
        // 绑定已经对不上了：这条照发，但界面上要标出来。
        targetMismatch: entry.targetMismatch === true,
      })),
      skipped: plan.skipped.map((item) => ({
        ...item,
        label: PROXY_SUBSCRIPTION_SKIP_LABELS[item.reason],
      })),
      warnings: plan.warnings.map((item) => ({
        ...item,
        label: PROXY_SUBSCRIPTION_WARNING_LABELS[item.reason],
      })),
    };
  }),

  /** 「自动隐藏不通的节点」开关（每个用户自己的，默认开）。 */
  hideUnreachable: protectedProcedure.query(async ({ ctx }) => {
    if (!await hasProxySubscriptionPermission(ctx)) return { enabled: false };
    return { enabled: await db.getProxySubHideUnreachable(ctx.user.id) };
  }),

  setHideUnreachable: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      if (!await hasProxySubscriptionPermission(ctx)) throw new Error("没有订阅权限");
      await db.setProxySubHideUnreachable(ctx.user.id, input.enabled);
      return { enabled: input.enabled };
    }),

  listTokens: protectedProcedure.query(async ({ ctx }) => {
    if (!await hasProxySubscriptionPermission(ctx)) return [];
    const rows = await db.getProxySubTokensByUser(ctx.user.id);
    return Promise.all((rows as any[]).map(async (row) => ({
      ...row,
      scope: parseProxySubTokenScope(row.scopeJson),
      options: parseProxySubTokenOptions(row.optionsJson),
      deviceCount: await db.countProxySubDevices(Number(row.id)),
      lastClientLabel: row.lastClientFamily ? (PROXY_CLIENT_FAMILY_LABELS as any)[row.lastClientFamily] || row.lastClientFamily : "",
    })));
  }),

  /** 用户看得到的那部分订阅设置：备用域名、默认外观、能不能加外部订阅…… */
  settingsPublic: protectedProcedure.query(async ({ ctx }) => {
    const settings = await loadProxySubSettings();
    const plan = ctx.user.role === "admin" ? null : await db.getUserPlanSubscriptionInfo(ctx.user.id);
    return {
      domains: settings.domains,
      landingPageEnabled: settings.landingPageEnabled,
      infoNodesDefault: settings.infoNodesDefault || !!plan?.showSubInfoNodes,
      nameTemplateDefault: settings.nameTemplateDefault,
      flagEmojiDefault: settings.flagEmojiDefault,
      regionGroupsDefault: settings.regionGroupsDefault,
      protocolPrefixDefault: settings.protocolPrefixDefault,
      deviceLimitEnabled: settings.deviceLimitEnabled,
      deviceLimitStrict: settings.deviceLimitStrict,
      externalSourcesAllowed: settings.externalSourcesEnabled && (ctx.user.role === "admin" || !!plan?.allowExternalSubSources),
      externalSourceMaxPerUser: settings.externalSourceMaxPerUser,
      updateIntervalHours: settings.updateIntervalHours,
    };
  }),

  createToken: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(64),
      defaultFormat: z.enum(PROXY_SUBSCRIPTION_FORMATS).default("base64"),
      rulePreset: z.enum(PROXY_RULE_PRESETS).default("balanced"),
      ...tokenExtraInput,
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const extra = await normalizeTokenExtra(input, 0);
      /**
       * 订阅地址条数也有上限。
       *
       * 每条地址都是一份完整凭据，发出去就收不回来 —— 只能吊销那一条。不设上限的话
       * 一个租户可以生成几十条分发出去，而你从「有几个用户」上完全看不出来。
       * 管理员不受限，与其他配额一致。
       */
      if (ctx.user.role !== "admin") {
        const owner = await db.getUserById(ctx.user.id);
        const limit = Number((owner as any)?.maxProxySubTokens || 0);
        if (limit > 0) {
          const used = await db.countProxySubTokensByUser(ctx.user.id);
          if (used >= limit) {
            throw new Error(`订阅地址已达上限（${used}/${limit}）。删掉一条，或让管理员调高上限。`);
          }
        }
      }
      const token = nanoid(SUBSCRIPTION_TOKEN_LENGTH);
      const id = await db.createProxySubToken({
        userId: ctx.user.id,
        name: input.name,
        token,
        defaultFormat: input.defaultFormat,
        rulePreset: input.rulePreset,
        ...extra,
      } as any);
      return { id, token };
    }),

  updateToken: protectedProcedure
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(64).optional(),
      defaultFormat: z.enum(PROXY_SUBSCRIPTION_FORMATS).optional(),
      rulePreset: z.enum(PROXY_RULE_PRESETS).optional(),
      isEnabled: z.boolean().optional(),
      ...tokenExtraInput,
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedToken(input.id, ctx);
      const data: Record<string, unknown> = { ...(await normalizeTokenExtra(input, input.id)) };
      if (input.name !== undefined) data.name = input.name;
      if (input.defaultFormat !== undefined) data.defaultFormat = input.defaultFormat;
      if (input.rulePreset !== undefined) data.rulePreset = input.rulePreset;
      if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
      // 模板只有管理员能指定：模板是全站资源，用户不该能挑别人的。
      if (input.templateId !== undefined && ctx.user.role !== "admin") delete data.templateId;
      if (Object.keys(data).length === 0) return { success: true };
      await db.updateProxySubToken(input.id, data as any);
      return { success: true };
    }),

  /**
   * 重置令牌：旧地址立刻失效，用于设备丢失。设备列表一并清空 —— 旧地址上的设备和新地址没关系。
   * 短链（/s/<别名>）指的是同一条令牌，不清掉的话旧短链照样能拉；「最近一次没拉到」的记录、
   * 限流计数（按令牌 id 记）也一并清掉，免得新地址一导入就是 429。
   * 主人本身没资格（到期、超流量、权限收回）时换地址解决不了，照样重置，但把原因带回去。
   */
  rotateToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const existing = await assertOwnedToken(input.id, ctx);
      const token = nanoid(SUBSCRIPTION_TOKEN_LENGTH);
      await db.updateProxySubToken(input.id, {
        token,
        alias: null,
        accessCount: 0,
        lastClientFamily: null,
        lastClientVersion: null,
        lastFailureAt: null,
        lastFailureReason: null,
      } as any);
      await db.clearProxySubDevices(input.id);
      clearProxySubRateLimitForToken(input.id);
      const owner = await db.getUserById(Number(existing.userId));
      const warning = db.proxyCredentialRecipientActive(owner as any)
        ? null
        : "地址已重置，但账号目前没有订阅资格（到期、超流量或权限被收回），新地址也拉不到，先续费或联系管理员";
      return { token, warning };
    }),

  /** 这条令牌实际会发出去的内容：处理器跑完之后的节点名、组、信息节点、自定义规则报错。 */
  tokenPreview: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), format: z.enum(PROXY_SUBSCRIPTION_FORMATS).optional() }))
    .query(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const token = await assertOwnedToken(input.id, ctx);
      const context = await loadProxySubTokenContext(token);
      if (!context) throw new Error("令牌主人不存在");
      const template = await resolveTemplateForToken(context, input.format || "clash");
      const built = await db.buildProxySubscriptionForToken(Number(token.userId), {
        rulePreset: normalizeProxyRulePresetSafe(token.rulePreset),
        scope: context.scope,
        options: context.options,
        settings: context.settings,
        userCustomRules: String(context.owner.proxySubCustomRules || ""),
        template,
        info: infoNodesWanted(context) ? context.info : null,
        vars: { appName: context.appName, panelUrl: "", subUrl: "", username: context.username },
      });
      return {
        nodes: built.document.nodes.map((node) => ({ name: node.name, protocol: node.protocol, address: node.address, port: node.port, regionCode: node.regionCode || "" })),
        groups: built.document.groups.map((group) => ({ name: group.name, type: group.type, members: group.members })),
        infoNodes: built.infoNodes.map((node) => node.name),
        skipped: built.plan.skipped.map((item) => ({ ...item, label: SKIP_LABELS[item.reason] })),
        customRuleErrors: built.customRuleErrors,
        templateName: template?.name || "",
        deviceLimit: context.deviceLimit,
      };
    }),

  /** 这条令牌最近的拉取记录。 */
  tokenAccessLogs: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), limit: z.number().int().min(1).max(200).default(50), beforeMs: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedToken(input.id, ctx);
      const rows = await db.listProxySubAccessLogs({ tokenId: input.id, limit: input.limit, beforeMs: input.beforeMs });
      return (rows as any[]).map((row) => ({ ...row, clientLabel: row.clientFamily ? (PROXY_CLIENT_FAMILY_LABELS as any)[row.clientFamily] || row.clientFamily : "" }));
    }),

  /** 自己名下最近 N 天的拉取统计。 */
  accessStats: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(7) }).optional())
    .query(async ({ ctx, input }) => {
      if (!await hasProxySubscriptionPermission(ctx)) return { byResult: [], byFamily: [], total: 0, distinctIps: 0 };
      return db.proxySubAccessStats({ userId: ctx.user.id, days: input?.days || 7 });
    }),

  tokenDevices: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedToken(input.id, ctx);
      return db.listProxySubDevicesByToken(input.id);
    }),

  deleteDevice: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const device = await db.getProxySubDeviceById(input.id);
      if (!device) throw new Error("设备记录不存在");
      if (ctx.user.role !== "admin" && Number((device as any).userId) !== ctx.user.id) throw new Error("无权操作该设备");
      await db.deleteProxySubDevice(input.id);
      return { success: true };
    }),

  /** 校验一段自定义规则文本，界面上边写边报错。 */
  validateCustomRules: protectedProcedure
    .input(z.object({ text: z.string().max(20000) }))
    .query(({ input }) => {
      const parsed = parseProxyCustomRules(input.text);
      return { count: parsed.rules.length, errors: parsed.errors };
    }),

  /** 节点在面板里的顺序（订阅默认按它排）。 */
  reorderNodes: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await db.reorderProxyNodes(ctx.user.id, input.ids);
      return { success: true };
    }),

  // ==================== 外部订阅 ====================

  listSources: protectedProcedure.query(async ({ ctx }) => {
    if (!await hasProxySubscriptionPermission(ctx)) return [];
    const rows = await db.listProxySubSourcesByUser(ctx.user.id);
    return (rows as any[]).map((row) => ({
      ...row,
      upstream: safeJson(row.upstreamUserinfo),
    }));
  }),

  createSource: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(64),
      url: z.string().trim().min(1).max(2048),
      userAgent: z.string().trim().max(200).optional(),
      intervalSec: z.number().int().min(600).max(7 * 86400).optional(),
      mode: z.enum(PROXY_SUB_SOURCE_MODES).default("import"),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertExternalSourcesAllowed(ctx);
      const url = normalizeProxySubSourceUrl(input.url);
      if (!url) throw new Error("订阅地址要是 http(s) 开头的完整地址");
      const settings = await loadProxySubSettings();
      if (ctx.user.role !== "admin" && settings.externalSourceMaxPerUser > 0) {
        const used = await db.countProxySubSourcesByUser(ctx.user.id);
        if (used >= settings.externalSourceMaxPerUser) throw new Error(`外部订阅已达上限（${used}/${settings.externalSourceMaxPerUser}）`);
      }
      const id = await db.createProxySubSource({
        userId: ctx.user.id,
        name: input.name,
        url,
        userAgent: input.userAgent || null,
        intervalSec: normalizeProxySubSourceInterval(input.intervalSec),
        mode: input.mode,
        isEnabled: true,
      } as any);
      // 建完立刻拉一次：填错了地址当场就知道。
      const result = await syncProxySubSource(Number(id), { force: true });
      return { id, sync: result };
    }),

  updateSource: protectedProcedure
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(64).optional(),
      url: z.string().trim().min(1).max(2048).optional(),
      userAgent: z.string().trim().max(200).nullable().optional(),
      intervalSec: z.number().int().min(600).max(7 * 86400).optional(),
      mode: z.enum(PROXY_SUB_SOURCE_MODES).optional(),
      isEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedSource(input.id, ctx);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.url !== undefined) {
        const url = normalizeProxySubSourceUrl(input.url);
        if (!url) throw new Error("订阅地址要是 http(s) 开头的完整地址");
        data.url = url;
        data.lastContentHash = null;
      }
      if (input.userAgent !== undefined) data.userAgent = input.userAgent || null;
      if (input.intervalSec !== undefined) data.intervalSec = normalizeProxySubSourceInterval(input.intervalSec);
      if (input.mode !== undefined) data.mode = input.mode;
      if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
      if (Object.keys(data).length > 0) await db.updateProxySubSource(input.id, data as any);
      invalidateProxySubCacheForUser(ctx.user.id);
      return { success: true };
    }),

  deleteSource: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedSource(input.id, ctx);
      await db.deleteProxySubSource(input.id);
      return { success: true };
    }),

  syncSource: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedSource(input.id, ctx);
      return syncProxySubSource(input.id, { force: true });
    }),

  // ==================== 管理员 ====================

  adminListTokens: adminProcedure
    .input(z.object({
      search: z.string().trim().max(64).optional(),
      userId: z.number().int().positive().optional(),
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ input }) => {
      const result = await db.listAllProxySubTokens(input);
      return {
        total: result.total,
        items: (result.items as any[]).map((row) => ({
          ...row,
          lastClientLabel: row.lastClientFamily ? (PROXY_CLIENT_FAMILY_LABELS as any)[row.lastClientFamily] || row.lastClientFamily : "",
          scoped: !!row.scopeJson,
        })),
      };
    }),

  adminAccessStats: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(7), userId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => {
      const stats = await db.proxySubAccessStats({ days: input?.days || 7, userId: input?.userId });
      return {
        ...stats,
        byFamily: stats.byFamily.map((item) => ({ ...item, label: (PROXY_CLIENT_FAMILY_LABELS as any)[item.family] || item.family })),
      };
    }),

  adminAccessLogs: adminProcedure
    .input(z.object({
      tokenId: z.number().int().positive().optional(),
      userId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).default(100),
      beforeMs: z.number().int().positive().optional(),
    }))
    .query(async ({ input }) => {
      const rows = await db.listProxySubAccessLogs(input);
      return (rows as any[]).map((row) => ({ ...row, clientLabel: row.clientFamily ? (PROXY_CLIENT_FAMILY_LABELS as any)[row.clientFamily] || row.clientFamily : "" }));
    }),

  adminTokenDevices: adminProcedure
    .input(z.object({ tokenId: z.number().int().positive() }))
    .query(async ({ input }) => db.listProxySubDevicesByToken(input.tokenId)),

  adminGetSettings: adminProcedure.query(async () => loadProxySubSettings()),

  adminUpdateSettings: adminProcedure
    .input(z.object({
      updateIntervalHours: z.number().int().min(1).max(720).optional(),
      testUrl: z.string().trim().max(256).optional(),
      testIntervalSec: z.number().int().min(30).max(86400).optional(),
      toleranceMs: z.number().int().min(0).max(5000).optional(),
      rulesetIntervalSec: z.number().int().min(3600).max(86400 * 30).optional(),
      rulesetMirror: z.string().trim().max(256).optional(),
      announce: z.string().max(1000).optional(),
      supportUrl: z.string().trim().max(256).optional(),
      domains: z.array(z.string().trim().max(256)).max(10).optional(),
      rateLimitPerMinute: z.number().int().min(0).max(100000).optional(),
      ipRateLimitPerMinute: z.number().int().min(0).max(100000).optional(),
      cacheTtlSec: z.number().int().min(0).max(3600).optional(),
      deviceLimitEnabled: z.boolean().optional(),
      deviceLimitStrict: z.boolean().optional(),
      deviceLimitFallback: z.number().int().min(0).max(1000).optional(),
      deviceIpWindowHours: z.number().int().min(1).max(720).optional(),
      infoNodesDefault: z.boolean().optional(),
      nameTemplateDefault: z.string().trim().max(120).optional(),
      flagEmojiDefault: z.boolean().optional(),
      regionGroupsDefault: z.boolean().optional(),
      protocolPrefixDefault: z.boolean().optional(),
      accessLogRetentionDays: z.number().int().min(0).max(365).optional(),
      externalSourcesEnabled: z.boolean().optional(),
      externalSourceMaxPerUser: z.number().int().min(0).max(100).optional(),
      landingPageEnabled: z.boolean().optional(),
      xboardCompatEnabled: z.boolean().optional(),
      notifyFirstAccess: z.boolean().optional(),
      notifyNewDevice: z.boolean().optional(),
      notifyDeviceLimit: z.boolean().optional(),
      notifyFailures: z.boolean().optional(),
      customRulesPrepend: z.string().max(20000).optional(),
      customRulesAppend: z.string().max(20000).optional(),
    }))
    .mutation(async ({ input }) => {
      for (const key of ["customRulesPrepend", "customRulesAppend"] as const) {
        const text = input[key];
        if (text === undefined) continue;
        const parsed = parseProxyCustomRules(text);
        if (parsed.errors.length > 0) throw new Error(`${key === "customRulesPrepend" ? "前置" : "后置"}规则第 ${parsed.errors[0].line} 行：${parsed.errors[0].message}`);
      }
      if (input.nameTemplateDefault !== undefined && !input.nameTemplateDefault.trim()) input.nameTemplateDefault = PROXY_SUB_DEFAULT_SETTINGS.nameTemplateDefault;
      const normalized = normalizeProxySubSettings({ ...(await loadProxySubSettings()), ...input } as Partial<ProxySubSettings>);
      return saveProxySubSettings(normalized);
    }),

  adminListTemplates: adminProcedure.query(async () => ({
    templates: await db.listProxySubTemplates(),
    builtin: PROXY_SUB_BUILTIN_PRELUDES,
    targets: PROXY_SUB_TEMPLATE_TARGETS,
  })),

  adminCreateTemplate: adminProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(64),
      target: z.enum(PROXY_SUB_TEMPLATE_TARGETS),
      prelude: z.string().max(60000),
      customGroups: z.array(z.object({
        name: z.string().trim().max(64),
        type: z.enum(["select", "url-test", "fallback", "load-balance"]),
        filter: z.string().trim().max(200).default(""),
        match: z.enum(["regex", "any", "all"]).default("regex"),
        includeGroups: z.boolean().default(false),
      })).max(30).default([]),
      isDefault: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const customGroups = normalizeProxySubCustomGroups(input.customGroups);
      const verdict = validateProxySubTemplate({ target: input.target, prelude: input.prelude, customGroups });
      if (!verdict.ok) throw new Error(verdict.error);
      const id = await db.createProxySubTemplate({
        name: input.name,
        target: input.target,
        prelude: input.prelude,
        customGroupsJson: customGroups.length > 0 ? JSON.stringify(customGroups) : null,
        isDefault: input.isDefault,
      });
      return { id };
    }),

  adminUpdateTemplate: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(64).optional(),
      prelude: z.string().max(60000).optional(),
      customGroups: z.array(z.object({
        name: z.string().trim().max(64),
        type: z.enum(["select", "url-test", "fallback", "load-balance"]),
        filter: z.string().trim().max(200).default(""),
        match: z.enum(["regex", "any", "all"]).default("regex"),
        includeGroups: z.boolean().default(false),
      })).max(30).optional(),
      isDefault: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const existing = await db.getProxySubTemplateById(input.id);
      if (!existing) throw new Error("模板不存在");
      const customGroups = input.customGroups !== undefined ? normalizeProxySubCustomGroups(input.customGroups) : existing.customGroups;
      const verdict = validateProxySubTemplate({ target: existing.target, prelude: input.prelude ?? existing.prelude, customGroups });
      if (!verdict.ok) throw new Error(verdict.error);
      await db.updateProxySubTemplate(input.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prelude !== undefined ? { prelude: input.prelude } : {}),
        ...(input.customGroups !== undefined ? { customGroupsJson: customGroups.length > 0 ? JSON.stringify(customGroups) : null } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      });
      return { success: true };
    }),

  adminDeleteTemplate: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteProxySubTemplate(input.id);
      return { success: true };
    }),

  /** 某个用户的订阅侧配置：自定义规则、指定模板、设备数。管理员在用户页上改。 */
  adminGetUserConfig: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const user = await db.getUserById(input.userId) as any;
      if (!user) throw new Error("用户不存在");
      return {
        customRules: String(user.proxySubCustomRules || ""),
        templateId: Number(user.proxySubTemplateId || 0),
        maxProxyDevices: Number(user.maxProxyDevices || 0),
        manualMaxProxyDevices: Number(user.manualMaxProxyDevices || 0),
      };
    }),

  adminSetUserConfig: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      customRules: z.string().max(20000).optional(),
      templateId: z.number().int().min(0).optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.customRules !== undefined) {
        const parsed = parseProxyCustomRules(input.customRules);
        if (parsed.errors.length > 0) throw new Error(`第 ${parsed.errors[0].line} 行：${parsed.errors[0].message}`);
        await db.setUserProxySubCustomRules(input.userId, input.customRules.trim() || null);
      }
      if (input.templateId !== undefined) {
        if (input.templateId > 0 && !(await db.getProxySubTemplateById(input.templateId))) throw new Error("模板不存在");
        await db.setUserProxySubTemplate(input.userId, input.templateId);
      }
      return { success: true };
    }),

  /**
   * 落地出口检测：这个节点从哪台机器出去，那台出去以后到几个常用站点连不连得上、解锁了什么
   * （server/exitQualityView）。自建节点传 inboundId，粘贴节点传 nodeId；只能查自己的。
   */
  exitCheck: protectedProcedure
    .input(z.object({ inboundId: z.number().int().positive().optional(), nodeId: z.number().int().positive().optional() }).refine((value) => !!value.inboundId !== !!value.nodeId, "inboundId 和 nodeId 二选一"))
    .query(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const isAdmin = ctx.user.role === "admin";
      if (input.inboundId) {
        const inbound = await db.getProxyInboundById(input.inboundId);
        if (!inbound || (!isAdmin && Number(inbound.userId) !== Number(ctx.user.id))) throw new Error("落地节点不存在");
        return buildInboundExit(inbound);
      }
      const node = await db.getProxyNodeById(Number(input.nodeId));
      if (!node || (!isAdmin && Number(node.userId) !== Number(ctx.user.id))) throw new Error("节点不存在");
      return buildNodeExit(node, { id: Number(ctx.user.id), role: String(ctx.user.role) });
    }),

  /**
   * 节点菜单「出口检测」，节点的机器不是自己的：挑一台机器经这个节点检测（server/nodeCheckView）。
   * 只能查自己的节点（管理员看全部）。
   */
  nodeExitCheckStart: protectedProcedure
    .input(z.object({ nodeId: z.number().int().positive(), hostId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const node = await ownedNodeForCheck(ctx, input.nodeId);
      try {
        return await startExitCheckForNode(node, { id: Number(ctx.user.id), role: String(ctx.user.role) }, { hostId: input.hostId });
      } catch (error) {
        if (error instanceof NodeCheckError) throw new Error(error.message);
        throw error;
      }
    }),

  nodeExitCheckStatus: protectedProcedure
    .input(z.object({ nodeId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const node = await ownedNodeForCheck(ctx, input.nodeId);
      const status = await exitCheckStatusForNode(node, { id: Number(ctx.user.id), role: String(ctx.user.role) });
      const latest = status.latest;
      const viaHost = latest ? await db.getHostById(Number(latest.hostId)) : null;
      return {
        nodeName: String(node.name || ""),
        ...status,
        exitView: latest?.exit && viaHost
          ? exitCheckToHostView(latest.exit, { hostId: Number(viaHost.id), hostName: String(viaHost.name || ""), nodeName: String(node.name || ""), checkedAt: latest.checkedAt, countryCode: viaHost.countryCode ? String(viaHost.countryCode) : null })
          : null,
      };
    }),

  /**
   * 预览订阅里每条线路的「测速」：入口机连自己的入口走完整条链对 Cloudflare 测速
   * （server/nodeCheckView）。entryKey 是预览里的 rule-<id> / direct-<模板 id>。
   */
  entrySpeedTestStart: protectedProcedure
    .input(z.object({ entryKey: z.string().min(1).max(48) }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      try {
        return await startSpeedTestForEntry(Number(ctx.user.id), { id: Number(ctx.user.id), role: String(ctx.user.role) }, input);
      } catch (error) {
        if (error instanceof NodeCheckError) throw new Error(error.message);
        throw error;
      }
    }),

  entrySpeedTestStatus: protectedProcedure
    .input(z.object({ entryKey: z.string().min(1).max(48) }))
    .query(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const status = await speedTestStatusForEntry(Number(ctx.user.id), { id: Number(ctx.user.id), role: String(ctx.user.role) }, input.entryKey);
      const viaHost = status.latest ? await db.getHostById(Number(status.latest.hostId)) : null;
      return { ...status, viaHostName: viaHost ? String(viaHost.name || "") : "" };
    }),

  /** 订阅内容里点开一条中转：这条线路怎么走（server/subscriptionRouteView）。只能看自己的规则。 */
  previewRoute: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const rule = await db.getForwardRuleById(input.ruleId) as any;
      if (!rule || (ctx.user.role !== "admin" && Number(rule.userId) !== Number(ctx.user.id))) throw new Error("转发不存在");
      return buildSubscriptionRouteView(rule);
    }),

  deleteToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedToken(input.id, ctx);
      await db.deleteProxySubToken(input.id);
      // 和重置一样：按令牌 id 记的限流计数一起清，别让残留的计数挂在一个不存在的令牌上。
      clearProxySubRateLimitForToken(input.id);
      return { success: true };
    }),
});
