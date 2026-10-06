import { nanoid } from "nanoid";
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
      (rules as any[]).map((rule) => ({
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
    const nodes = await db.getProxyNodesByUser(ctx.user.id);
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
      };
    });

    /**
     * 别人分享给我的节点也列出来，否则订阅里凭空多出几条，用户在管理页找不到
     * 它们是哪来的。这些行是只读的 —— 编辑与删除在服务端本来就按 userId 挡着，
     * 界面据 sharedFrom 把入口收起来，别让人点进去才发现改不了。
     */
    const shared = await db.getProxyNodesSharedToUser(ctx.user.id);
    if (shared.length === 0) return owned;
    const sharedRows = shared.map((node: any) => ({
      ...redactSharedProxyNodeRow(node),
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
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      const parsed = parseProxyNodeLink(input.link);
      if (!parsed.ok) throw new Error(parsed.error);
      const id = await db.createProxyNode({
        userId: ctx.user.id,
        name: input.name,
        remark: input.remark || null,
        publicLabel: input.publicLabel || null,
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
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedNode(input.id, ctx);
      const data: Record<string, unknown> = {};
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
      await db.updateProxyNode(input.id, data as any);
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
        .map((group) => ({ name: group.name, type: group.type, members: group.members })),
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
    return db.getProxySubTokensByUser(ctx.user.id);
  }),

  createToken: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(64),
      defaultFormat: z.enum(PROXY_SUBSCRIPTION_FORMATS).default("base64"),
      rulePreset: z.enum(PROXY_RULE_PRESETS).default("balanced"),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
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
    }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedToken(input.id, ctx);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.defaultFormat !== undefined) data.defaultFormat = input.defaultFormat;
      if (input.rulePreset !== undefined) data.rulePreset = input.rulePreset;
      if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
      if (Object.keys(data).length === 0) return { success: true };
      await db.updateProxySubToken(input.id, data as any);
      return { success: true };
    }),

  /** 重置令牌：旧地址立刻失效，用于设备丢失。 */
  rotateToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedToken(input.id, ctx);
      const token = nanoid(SUBSCRIPTION_TOKEN_LENGTH);
      await db.updateProxySubToken(input.id, { token, accessCount: 0 } as any);
      return { token };
    }),

  deleteToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertProxySubscriptionAllowed(ctx);
      await assertOwnedToken(input.id, ctx);
      await db.deleteProxySubToken(input.id);
      return { success: true };
    }),
});
