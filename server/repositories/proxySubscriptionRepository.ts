import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import {
  forwardRules,
  hosts,
  proxyInbounds,
  proxyNodes,
  proxyNodeShares,
  proxySubTokens,
  subscriptionPlanProxyNodes,
  type InsertProxyNode,
  type InsertProxySubToken,
} from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";
import {
  buildProxySubscriptionDocument,
  buildProxySubscriptionPlan,
  type ProxySubscriptionDocument,
  type ProxySubscriptionPlan,
} from "../../shared/proxySubscriptionPlan";
import { PROXY_SUBSCRIPTION_GROUP_NAME } from "../../shared/proxySubscription";
import { normalizeProxyRulePreset } from "../../shared/proxyRuleset";
import { shareProxyNodeRow } from "../../shared/proxyNodeShare";
import { proxyInboundSupportsMultiUser } from "../../shared/proxyInbound";
import { type ProxySubTokenFailureReason } from "../../shared/proxySubTokenStatus";
import { getRuleEntryDomainRuntimeSettings } from "./ruleEntryDomainRepository";
import { getSetting, setSetting } from "./settingsRepository";
import { getUnreachableRuleIds } from "./metricsRepository";
import { signalRuleEntryDomainChanged } from "../ruleEntryDomainSignals";

// ==================== 客户端订阅：节点模板 ====================

export async function getProxyNodesByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxyNodes)
    .where(eq(proxyNodes.userId, userId))
    .orderBy(asc(proxyNodes.sortOrder), asc(proxyNodes.id));
}

/**
 * 所有设了总流量、并且已经到量的节点 —— 提醒用。
 *
 * 只查设了上限的：没填总量的节点谈不上「用了多少算多」，全查回来再过滤是白读一遍
 * 整张表（一个商家几十上百个节点，这个函数每轮定时任务都会跑）。
 */
export async function getProxyNodesWithTrafficQuota() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: proxyNodes.id,
      userId: proxyNodes.userId,
      name: proxyNodes.name,
      address: proxyNodes.address,
      port: proxyNodes.port,
      trafficLimit: proxyNodes.trafficLimit,
      trafficUsed: proxyNodes.trafficUsed,
      isEnabled: proxyNodes.isEnabled,
    })
    .from(proxyNodes)
    .where(gt(proxyNodes.trafficLimit, 0))
    .orderBy(asc(proxyNodes.id));
}

export async function getProxyNodeById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxyNodes).where(eq(proxyNodes.id, id)).limit(1);
  return rows[0];
}

export async function createProxyNode(data: InsertProxyNode) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("proxy_nodes", data as any);
}

export async function updateProxyNode(id: number, data: Partial<InsertProxyNode>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(proxyNodes).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxyNodes.id, id));
}

/**
 * 删除模板前先解绑引用它的转发，否则这些规则会留着一个指向不存在模板的
 * proxyNodeId，订阅里静默少节点且界面上看不出原因。
 */
export async function deleteProxyNode(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const unboundRules = await db
    .select({ id: forwardRules.id })
    .from(forwardRules)
    .where(eq(forwardRules.proxyNodeId, id));
  await db
    .update(forwardRules)
    .set({ proxyNodeId: null, updatedAt: nowDate() } as any)
    .where(eq(forwardRules.proxyNodeId, id));
  // 这些规则不再进订阅，它们的专属域名要撤掉（见 server/ruleEntryDomain.ts；漏了有定时对账兜底）。
  for (const rule of unboundRules as Array<{ id: number }>) signalRuleEntryDomainChanged(Number(rule.id), "proxy-node-deleted");
  // 分享记录跟着一起删：留着的话对方订阅里会指向一个不存在的节点 id，
  // 而管理端的「已分享给谁」还照旧显示，看不出人已经拿不到了。
  await db.delete(proxyNodeShares).where(eq(proxyNodeShares.nodeId, id));
  /**
   * 套餐里绑着它的那一行同理。
   *
   * 留着的话套餐会继续宣称带着一个已经不存在的落地节点：商店页上的「落地节点
   * 3 个」多算一个，管理端的套餐编辑里显示成「节点 #7」这样一个只有编号的空壳，
   * 而买了这个套餐的人会拿到一条指向不存在节点的授权。主机那一路一直是这么
   * 删的，节点这一路当初漏了。
   */
  await db.delete(subscriptionPlanProxyNodes).where(eq(subscriptionPlanProxyNodes.nodeId, id));
  await db.delete(proxyNodes).where(eq(proxyNodes.id, id));
}

/**
 * 有几个套餐正在卖这个节点。
 *
 * 删节点时会顺手把套餐里的绑定一起清掉（不清的话套餐会继续宣称带着一个不存在
 * 的节点）。但那一下是**静悄悄**的：管理员删的是一个节点，被改掉的是几个在卖
 * 的套餐 —— 商店页上的数量当场就变了，而他不知道。返回个数，和「解绑了几条
 * 转发」一样说出来。
 */
export async function countPlansUsingProxyNode(id: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ planId: subscriptionPlanProxyNodes.planId })
    .from(subscriptionPlanProxyNodes)
    .where(eq(subscriptionPlanProxyNodes.nodeId, Number(id)));
  return new Set((rows as any[]).map((row) => Number(row.planId))).size;
}

export async function countRulesUsingProxyNode(id: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: forwardRules.id })
    .from(forwardRules)
    .where(and(eq(forwardRules.proxyNodeId, id), eq(forwardRules.pendingDelete, false)));
  return rows.length;
}

/**
 * 一批节点各自被哪些转发绑定。
 *
 * 一次查完而不是每个节点查一遍：节点多起来之后，逐个 count 会把一次列表请求
 * 变成几十条查询。调用方拿到规则 id 之后还要用它去汇总流量和探测结果，
 * 所以这里返回 id 而不只是个数。
 */
export async function getRuleIdsUsingProxyNodes(
  nodeIds: readonly number[],
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  const ids = Array.from(new Set(nodeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  for (const id of ids) result.set(id, []);
  if (ids.length === 0) return result;

  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select({ id: forwardRules.id, proxyNodeId: forwardRules.proxyNodeId })
    .from(forwardRules)
    .where(and(inArray(forwardRules.proxyNodeId, ids), eq(forwardRules.pendingDelete, false)));

  for (const row of rows as any[]) {
    const nodeId = Number(row.proxyNodeId || 0);
    const list = result.get(nodeId);
    if (list) list.push(Number(row.id));
  }
  return result;
}

// ==================== 节点分享 ====================

/**
 * 分享的落点。
 *
 * 派生自「一个端口多份凭据」协议的节点，分享要按**入站**算：给某人分享
 * 不是把自己那份凭据抄给他，而是在那个端口上单独给他开一份。所以这类节点
 * 上的「分享给谁」其实是「这个入站上有谁的凭据」。
 *
 * 粘进来的节点、以及 Shadowsocks / Snell 这种一个端口只有一份 PSK 的，
 * 只能按节点算 —— 分享出去的就是同一份凭据，收回的唯一办法是换掉它，
 * 而那会把已经发出去的配置全部作废。界面上要把这个差别说清楚。
 */
/** 一条没生效的分享，以及为什么。界面据此说明白，而不是笼统报「已保存」。 */
export type ProxyNodeShareSkip = {
  nodeId: number;
  name?: string;
  /** self = 那是他自己的节点；missing = 节点已经没了；credential = 发不出凭据。 */
  reason: "self" | "missing" | "credential";
};

type ProxyNodeShareScope =
  | { kind: "node"; nodeId: number }
  | { kind: "inbound"; nodeId: number; inboundId: number; ownerUserId: number };

async function resolveProxyNodeShareScope(nodeId: number): Promise<ProxyNodeShareScope | null> {
  const node = await getProxyNodeById(nodeId);
  if (!node) return null;
  const inboundId = Number((node as any).inboundId || 0);
  const ownerUserId = Number((node as any).userId || 0);
  if (inboundId <= 0) return { kind: "node", nodeId };
  const { loadProxyInbound } = await import("./proxyInboundRepository");
  const inbound = await loadProxyInbound(inboundId);
  if (!inbound || !proxyInboundSupportsMultiUser(inbound.protocol)) return { kind: "node", nodeId };
  return { kind: "inbound", nodeId, inboundId, ownerUserId };
}

/**
 * 所有「为分享单独发的」凭据行 id。
 *
 * 用来把这类凭据派生出的节点从**主人自己**的订阅里摘掉：它们只为某个租户而
 * 存在，留在主人订阅里就是每多一个租户多一条垃圾节点。
 */
async function getSharedCredentialUserIds(onlyIds?: readonly number[]): Promise<Set<number>> {
  // 调用方只关心某几条凭据时（订阅：主人自己节点挂着的那几条），只查这几条，
  // 不用每拉一次订阅就把全站的分享凭据扫一遍。
  const candidateIds = onlyIds === undefined
    ? undefined
    : Array.from(new Set(onlyIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (candidateIds && candidateIds.length === 0) return new Set();
  const db = await getDb();
  if (!db) return new Set();
  const { proxyInboundUsers } = await import("../../drizzle/schema");
  const rows = await db
    .select({ id: proxyInboundUsers.id })
    .from(proxyInboundUsers)
    .where(candidateIds
      ? and(sql`${proxyInboundUsers.sharedUserId} > 0`, inArray(proxyInboundUsers.id, candidateIds))
      : sql`${proxyInboundUsers.sharedUserId} > 0`);
  return new Set((rows as any[]).map((row) => Number(row.id)).filter((id) => id > 0));
}

/** 这个入站上，各人各自那份凭据派生出来的节点：收件人 → 节点 id。 */
async function getSharedNodeIdsByInbound(inboundId: number): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const db = await getDb();
  if (!db) return result;
  const { getProxyInboundUsers } = await import("./proxyInboundRepository");
  const users = await getProxyInboundUsers(inboundId);
  const shared = users.filter((user) => Number(user.sharedUserId || 0) > 0);
  if (shared.length === 0) return result;
  const rows = await db
    .select({ id: proxyNodes.id, inboundUserId: proxyNodes.inboundUserId })
    .from(proxyNodes)
    .where(and(
      eq(proxyNodes.inboundId, inboundId),
      inArray(proxyNodes.inboundUserId, shared.map((user) => Number(user.id))),
    ));
  const nodeByUser = new Map((rows as any[]).map((row) => [Number(row.inboundUserId), Number(row.id)]));
  for (const user of shared) {
    const derived = nodeByUser.get(Number(user.id));
    if (derived) result.set(Number(user.sharedUserId), derived);
  }
  return result;
}

/**
 * 分享给某个用户的节点 id。
 */
export async function getProxyNodeIdsSharedToUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ nodeId: proxyNodeShares.nodeId })
    .from(proxyNodeShares)
    .where(eq(proxyNodeShares.userId, Number(userId)));
  return rows.map((row: any) => Number(row.nodeId)).filter((id: number) => id > 0);
}

/**
 * 一批节点各自分享给了谁。一次查完 —— 节点列表要给每一行标「已分享给 N 人」，
 * 逐行查会把一次列表请求变成几十条查询。
 */
export async function getProxyNodeShareUserIds(
  nodeIds: readonly number[],
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  const ids = Array.from(new Set(nodeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  for (const id of ids) result.set(id, []);
  if (ids.length === 0) return result;

  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select({ nodeId: proxyNodeShares.nodeId, userId: proxyNodeShares.userId })
    .from(proxyNodeShares)
    .where(inArray(proxyNodeShares.nodeId, ids));
  for (const row of rows as any[]) {
    result.get(Number(row.nodeId))?.push(Number(row.userId));
  }
  return result;
}

/**
 * 这个入站上「代表它」的那条节点：主人自己那份凭据派生的。
 *
 * 分享按端口算，但界面上挑的是节点。分享发出去的那些派生节点各自属于某个人，
 * 不能拿来当选项 —— 所以对外一律用这一条代表整个端口。
 */
async function anchorNodeIdForInbound(inboundId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const { getProxyInboundUsers } = await import("./proxyInboundRepository");
  const credentials = await getProxyInboundUsers(inboundId);
  const ownIds = new Set(credentials.filter((user) => !Number(user.sharedUserId || 0)).map((user) => Number(user.id)));
  const rows = await db
    .select({ id: proxyNodes.id, inboundUserId: proxyNodes.inboundUserId })
    .from(proxyNodes)
    .where(eq(proxyNodes.inboundId, inboundId))
    .orderBy(asc(proxyNodes.inboundUserId), asc(proxyNodes.id));
  const own = (rows as any[]).find((row) => ownIds.has(Number(row.inboundUserId || 0)));
  return Number(own?.id || (rows as any[])[0]?.id || 0);
}

/**
 * 管理端「分享给这个人哪些节点」选择框里该勾上哪些。
 *
 * 不能直接用 getProxyNodeIdsSharedToUser：那给的是**他自己那条**派生节点，
 * 而选项列表里放的是代表整个端口的那一条 —— 两边对不上，选择框就会显示成
 * 一个都没选，管理员一保存，他的凭据就被静默收走了。
 */
export async function getProxyNodeShareSelectionForUser(userId: number): Promise<number[]> {
  const ids = await getProxyNodeIdsSharedToUser(userId);
  const result: number[] = [];
  for (const id of ids) {
    const scope = await resolveProxyNodeShareScope(id);
    if (!scope) continue;
    if (scope.kind === "node") {
      result.push(scope.nodeId);
      continue;
    }
    const anchor = await anchorNodeIdForInbound(scope.inboundId);
    if (anchor) result.push(anchor);
  }
  return Array.from(new Set(result));
}

/**
 * 订阅行上冻结的那份套餐快照里记的节点清单。
 *
 * 管理员改套餐时可以勾掉「同步已有订阅者」，那一下会把套餐当时的内容冻进
 * user_subscriptions.planSnapshot。主机、隧道、转发组一直认这份快照，节点这
 * 一项以前不在里面 —— 所以老快照里没有这个字段，返回 null 表示「这条订阅没
 * 冻过节点」，让调用方退回按套餐当前内容算，也就是加这一列之前的行为。
 */
function snapshotProxyNodeIds(planSnapshot: unknown): number[] | null {
  if (!planSnapshot || typeof planSnapshot !== "string") return null;
  try {
    const parsed = JSON.parse(planSnapshot);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.proxyNodeIds)) return null;
    return Array.from(new Set(parsed.proxyNodeIds
      .map((id: unknown) => Number(id))
      .filter((id: number) => Number.isInteger(id) && id > 0)));
  } catch {
    return null;
  }
}

/**
 * 这个人的有效套餐一共带了哪些落地节点。
 *
 * 只算还生效的订阅 —— 到期那一条带的节点不该再算数，否则「到期自动收回」
 * 收完下一次同步又发回去了。
 *
 * 冻结过快照的订阅按快照算。不这样的话「不同步已有订阅者」只兑现了一半：
 * 主机、隧道、转发组都按老套餐留着，节点却跟着套餐当前内容走 —— 老客户身上
 * 随便发生一件小事（充值、流量重置）触发一次权益重算，就会把他买的时候送的
 * 节点悄悄收走，而管理员明明说了不要动老客户。
 */
export async function getPlanGrantedProxyNodeIdsForUser(
  userId: number,
): Promise<Array<{ nodeId: number; dedicated: boolean }>> {
  const db = await getDb();
  if (!db) return [];
  const { subscriptionPlanProxyNodes, subscriptionPlans, userSubscriptions } = await import("../../drizzle/schema");
  const nowSec = Math.floor(Date.now() / 1000);

  /** 这个人还生效的订阅，连同各自冻没冻过快照、是不是独享端口。 */
  const subscriptionRows = await db
    .select({
      planId: userSubscriptions.planId,
      planSnapshot: userSubscriptions.planSnapshot,
      dedicated: subscriptionPlans.dedicatedProxyPort,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, userSubscriptions.planId))
    .where(and(
      eq(userSubscriptions.userId, Number(userId)),
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  if ((subscriptionRows as any[]).length === 0) return [];

  /**
   * 没冻过快照的那些订阅，才需要去查套餐当前绑了哪些节点。一条都不需要时
   * 整个查询省掉 —— 冻结是管理员的常规操作，不该每次都白跑一条 join。
   */
  const livePlanIds = Array.from(new Set((subscriptionRows as any[])
    .filter((row) => snapshotProxyNodeIds(row.planSnapshot) === null)
    .map((row) => Number(row.planId))
    .filter((id) => id > 0)));
  const liveNodeIdsByPlan = new Map<number, number[]>();
  if (livePlanIds.length > 0) {
    const planRows = await db
      .select({ planId: subscriptionPlanProxyNodes.planId, nodeId: subscriptionPlanProxyNodes.nodeId })
      .from(subscriptionPlanProxyNodes)
      .where(inArray(subscriptionPlanProxyNodes.planId, livePlanIds));
    for (const row of planRows as any[]) {
      const planId = Number(row.planId);
      const nodeId = Number(row.nodeId);
      if (!(planId > 0) || !(nodeId > 0)) continue;
      const list = liveNodeIdsByPlan.get(planId) || [];
      list.push(nodeId);
      liveNodeIdsByPlan.set(planId, list);
    }
  }

  const byNode = new Map<number, boolean>();
  for (const row of subscriptionRows as any[]) {
    const frozen = snapshotProxyNodeIds(row.planSnapshot);
    const nodeIds = frozen ?? liveNodeIdsByPlan.get(Number(row.planId)) ?? [];
    const dedicated = row.dedicated === true || row.dedicated === 1;
    for (const nodeId of nodeIds) {
      // 两个套餐给了同一个节点、口径不同时按「独享」算：能分账的那种是花了钱的，
      // 降级成共享等于把已经卖出去的计量能力收回去。
      byNode.set(nodeId, (byNode.get(nodeId) || false) || dedicated);
    }
  }
  return Array.from(byNode.entries()).map(([nodeId, dedicated]) => ({ nodeId, dedicated }));
}

/**
 * 把某个人的分享重算一遍，手工的和套餐带的各算各的。
 *
 * 只传其中一路时，另一路沿用库里现有的 —— 套餐同步不能顺手删掉管理员手工
 * 分的，反过来也一样。
 *
 * 凭据的收发跟着这个并集走：并集里还有这个端口就留着，没有了才真收回。
 * 一个端口同时被手工分和套餐带的情况下，撤掉其中一路不该让他断线。
 */
export async function reconcileProxyNodeSharesForUser(
  userId: number,
  input: {
    manualNodeIds?: readonly number[];
    /** 套餐给的那一路。dedicated = 给他单开一个端口（能按人计量）。 */
    planNodeIds?: readonly (number | { nodeId: number; dedicated?: boolean })[];
    label?: string;
  },
): Promise<{ hostIds: number[]; skipped: ProxyNodeShareSkip[]; sharedOwnerCredential?: Array<{ nodeId: number; name: string }> }> {
  const db = await getDb();
  if (!db) return { hostIds: [], skipped: [] };
  const recipient = Number(userId);
  /**
   * 没生效的那些要报上去。
   *
   * 原来这里是静默 continue：管理员挑了几个节点、点保存、界面提示「已保存」，
   * 而实际上一条都没写进去 —— 他只能等租户来说「我这儿没有」才发现。
   */
  const skipped: ProxyNodeShareSkip[] = [];
  const label = String(input.label || "").trim() || `用户 #${recipient}`;
  const hostIds = new Set<number>();

  const current = await db
    .select({ nodeId: proxyNodeShares.nodeId, source: proxyNodeShares.source })
    .from(proxyNodeShares)
    .where(eq(proxyNodeShares.userId, recipient));
  const keepExisting = (want: "manual" | "plan") => (current as any[])
    .filter((row) => String(row.source || "manual") === want)
    .map((row) => Number(row.nodeId));

  const wanted: Array<{ nodeId: number; source: "manual" | "plan"; dedicated: boolean }> = [];
  for (const nodeId of input.manualNodeIds ?? keepExisting("manual")) {
    wanted.push({ nodeId: Number(nodeId), source: "manual", dedicated: false });
  }
  for (const item of input.planNodeIds ?? keepExisting("plan")) {
    const nodeId = typeof item === "number" ? item : Number(item.nodeId);
    const dedicated = typeof item === "number" ? false : !!item.dedicated;
    wanted.push({ nodeId, source: "plan", dedicated });
  }

  const {
    ensureDedicatedInboundForUser,
    ensureSharedInboundCredential,
    getDedicatedInboundIdsForUser,
    releaseDedicatedInboundForUser,
    releaseSharedInboundCredential,
  } = await import("./proxyInboundRepository");
  const resolved = new Map<number, "manual" | "plan">();
  const sharedOwnerCredential: Array<{ nodeId: number; name: string }> = [];
  const keepInboundIds = new Set<number>();
  const keepDedicatedSourceIds = new Set<number>();
  for (const item of wanted) {
    if (!Number.isInteger(item.nodeId) || item.nodeId <= 0) continue;
    const node = await getProxyNodeById(item.nodeId);
    if (!node) {
      skipped.push({ nodeId: item.nodeId, reason: "missing" });
      continue;
    }
    // 自己的节点不用分享：落进来的话订阅里会出现两份同名节点。
    if (Number((node as any).userId) === recipient) {
      skipped.push({ nodeId: item.nodeId, reason: "self", name: String((node as any).name || "") });
      continue;
    }
    const scope = await resolveProxyNodeShareScope(item.nodeId);
    if (!scope) {
      skipped.push({ nodeId: item.nodeId, reason: "missing", name: String((node as any).name || "") });
      continue;
    }

    /**
     * 独享端口：给他在同一台机器上克隆一个入站，归属直接落到他名下。
     *
     * 这条路不写 proxy_node_shares —— 那个端口本来就是他的，派生节点也归他，
     * 走「自己的节点」那条线进订阅。流量也因此自然算到他头上（面板按端口计数）。
     */
    if (item.dedicated && scope.kind === "inbound") {
      const dedicated = await ensureDedicatedInboundForUser(scope.inboundId, recipient, label);
      if (dedicated) {
        keepDedicatedSourceIds.add(scope.inboundId);
        hostIds.add(dedicated.hostId);
        continue;
      }
      // 克隆不成（比如源入站没了）就退回共享凭据，总比一点都拿不到强。
    }

    let targetNodeId = scope.kind === "node" ? scope.nodeId : 0;
    // 这类节点给出去的是主人自己的真实凭据（粘贴的节点、不支持多用户的入站）：
    // 取消分享或对方到期后，他手上那份照样能连，只能靠主人换密码收回。
    if (scope.kind === "node") sharedOwnerCredential.push({ nodeId: item.nodeId, name: String((node as any).name || "") });
    if (scope.kind === "inbound") {
      keepInboundIds.add(scope.inboundId);
      const provisioned = await ensureSharedInboundCredential(scope.inboundId, recipient, label);
      if (!provisioned) {
        skipped.push({ nodeId: item.nodeId, reason: "credential", name: String((node as any).name || "") });
        continue;
      }
      hostIds.add(provisioned.hostId);
      targetNodeId = provisioned.nodeId;
    }
    if (!targetNodeId) {
      skipped.push({ nodeId: item.nodeId, reason: "credential", name: String((node as any).name || "") });
      continue;
    }
    // 手工优先：同一条既手工分了又被套餐带上，记成手工，撤套餐不该把它撤掉。
    if (resolved.get(targetNodeId) !== "manual") resolved.set(targetNodeId, item.source);
  }

  for (const inboundId of await getSharedInboundIdsForUser(recipient)) {
    if (keepInboundIds.has(inboundId)) continue;
    const released = await releaseSharedInboundCredential(inboundId, recipient);
    if (released) {
      const hostId = await getInboundHostId(inboundId);
      if (hostId) hostIds.add(hostId);
    }
  }

  // 不再授权的专属端口要连端口一起收掉，否则他的订阅里那条节点还在、还能连。
  for (const { sourceInboundId } of await getDedicatedInboundIdsForUser(recipient)) {
    if (keepDedicatedSourceIds.has(sourceInboundId)) continue;
    const hostId = await releaseDedicatedInboundForUser(sourceInboundId, recipient);
    if (hostId) hostIds.add(hostId);
  }

  await db.delete(proxyNodeShares).where(eq(proxyNodeShares.userId, recipient));
  const values = Array.from(resolved.entries()).map(([nodeId, source]) => ({ nodeId, userId: recipient, source }));
  if (values.length > 0) await db.insert(proxyNodeShares).values(values as any);
  return { hostIds: Array.from(hostIds).filter((hostId) => hostId > 0), skipped, sharedOwnerCredential };
}

/**
 * 套餐带的节点重算一遍：买了自动发，到期 / 换套餐 / 被停用自动收。
 *
 * allowed = false 时一律收回。订阅地址那边到期就拉不动了，可手上那份凭据是
 * 落在落地机上的 —— 不主动收，它照连不误。
 */
export async function syncPlanProxyNodeSharesForUser(
  userId: number,
  label?: string,
  options: { allowed?: boolean } = {},
): Promise<{ hostIds: number[] }> {
  const allowed = options.allowed !== false;
  const planNodeIds = allowed ? await getPlanGrantedProxyNodeIdsForUser(userId) : [];
  // allowed=false 时传空数组，独享端口也会在对账里被一起收掉。
  return reconcileProxyNodeSharesForUser(userId, { planNodeIds, label });
}

/**
 * 设定「这个用户能拿到哪些节点」（全量替换），和主机权限那套一个路数。
 *
 * 自己的节点不用分享，落进来的话对方订阅里会出现两份同名节点，客户端里就是
 * 两条一模一样的线路 —— 这里直接滤掉。
 */
export async function setProxyNodeSharesForUser(
  userId: number,
  nodeIds: readonly number[],
  options: { label?: string } = {},
): Promise<{ hostIds: number[]; skipped: ProxyNodeShareSkip[]; sharedOwnerCredential?: Array<{ nodeId: number; name: string }> }> {
  // 手工那一路走同一个对账函数，套餐带的那些原样留着。
  return reconcileProxyNodeSharesForUser(userId, { manualNodeIds: nodeIds, label: options.label });
}

/** 这个人在哪些入站上有单独发的凭据。 */
async function getSharedInboundIdsForUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const { proxyInboundUsers } = await import("../../drizzle/schema");
  const rows = await db
    .select({ inboundId: proxyInboundUsers.inboundId })
    .from(proxyInboundUsers)
    .where(eq(proxyInboundUsers.sharedUserId, Number(userId)));
  return Array.from(new Set((rows as any[]).map((row) => Number(row.inboundId)).filter((id) => id > 0)));
}

async function getInboundHostId(inboundId: number): Promise<number> {
  const { getProxyInboundById } = await import("./proxyInboundRepository");
  const row = await getProxyInboundById(inboundId);
  return Number((row as any)?.hostId || 0);
}

/**
 * 可供分享的节点清单（管理端选人用）。
 *
 * 只取选择框要显示的几列 —— 这个接口是给管理员挑节点的，凭据没有任何理由
 * 跟着列表一起发出去。
 */
export async function getProxyNodeShareOptions() {
  const db = await getDb();
  if (!db) return [];
  /**
   * 为分享单独发出去的那些凭据不进清单：它们已经是某个人的了，再拿去分享给
   * 第二个人，等于两个人共用一份凭据，取消其中一个就把另一个也断了。要给第
   * 二个人，挑原来那条节点即可 —— 系统会另发一份。
   */
  const excludedSet = await getSharedCredentialUserIds();
  const rows = await db
    .select({
      id: proxyNodes.id,
      userId: proxyNodes.userId,
      name: proxyNodes.name,
      protocol: proxyNodes.protocol,
      address: proxyNodes.address,
      port: proxyNodes.port,
      inboundId: proxyNodes.inboundId,
      isEnabled: proxyNodes.isEnabled,
      inboundUserId: proxyNodes.inboundUserId,
    })
    .from(proxyNodes)
    .orderBy(asc(proxyNodes.sortOrder), asc(proxyNodes.id));
  if (excludedSet.size === 0) return rows;
  return (rows as any[]).filter((row) => !excludedSet.has(Number(row.inboundUserId || 0)));
}

/**
 * 设定「这个节点分享给了谁」（全量替换）。
 *
 * 和 setProxyNodeSharesForUser 是同一件事的两个入口：那个从用户出发挑节点，
 * 这个从节点出发挑人。站在节点这边想把它租出去时，绕到用户页去一个个找人
 * 是件很别扭的事。
 */
export async function setProxyNodeShareUsers(
  nodeId: number,
  userIds: readonly number[],
  options: { labels?: ReadonlyMap<number, string> } = {},
): Promise<{ hostIds: number[] }> {
  const db = await getDb();
  if (!db) return { hostIds: [] };
  const id = Number(nodeId);
  if (!Number.isInteger(id) || id <= 0) return { hostIds: [] };
  const scope = await resolveProxyNodeShareScope(id);
  if (!scope) return { hostIds: [] };

  const node = await getProxyNodeById(id);
  if (!node) return { hostIds: [] };
  const wanted = Array.from(new Set(userIds.map((value) => Number(value))))
    .filter((value) => Number.isInteger(value) && value > 0 && value !== Number((node as any).userId));

  if (scope.kind === "node") {
    await db.delete(proxyNodeShares).where(eq(proxyNodeShares.nodeId, id));
    if (wanted.length > 0) {
      await db.insert(proxyNodeShares).values(wanted.map((userId) => ({ nodeId: id, userId })) as any);
    }
    return { hostIds: [] };
  }

  /**
   * 多凭据入站：这里管的是「这个端口上有谁的凭据」，一人一份，各自派生一条
   * 节点。所以要按人增删凭据，而不是把当前这条节点的分享名单改一改。
   */
  const { ensureSharedInboundCredential, releaseSharedInboundCredential } = await import("./proxyInboundRepository");
  const hostIds = new Set<number>();
  const current = await getSharedNodeIdsByInbound(scope.inboundId);
  const target = new Set(wanted);

  for (const [recipient, sharedNodeId] of current) {
    if (target.has(recipient)) continue;
    await db.delete(proxyNodeShares).where(eq(proxyNodeShares.nodeId, sharedNodeId));
    const released = await releaseSharedInboundCredential(scope.inboundId, recipient);
    if (released) hostIds.add(await getInboundHostId(scope.inboundId));
  }

  for (const recipient of target) {
    const label = options.labels?.get(recipient) || `用户 #${recipient}`;
    const provisioned = await ensureSharedInboundCredential(scope.inboundId, recipient, label);
    if (!provisioned) continue;
    hostIds.add(provisioned.hostId);
    // 幂等：同一个人再点一次保存，不该多出一条分享记录。
    await db
      .delete(proxyNodeShares)
      .where(and(eq(proxyNodeShares.nodeId, provisioned.nodeId), eq(proxyNodeShares.userId, recipient)));
    await db.insert(proxyNodeShares).values([{ nodeId: provisioned.nodeId, userId: recipient }] as any);
  }

  /**
   * 这条节点本身上的分享记录一律清掉：多凭据入站上，任何人都该拿自己那份，
   * 而不是主人这一份。老版本留下的记录也在这里被顺手纠正。
   */
  await db.delete(proxyNodeShares).where(eq(proxyNodeShares.nodeId, id));
  return { hostIds: Array.from(hostIds).filter((hostId) => hostId > 0) };
}

/**
 * 节点被分享给的那些人。管理端展示用。
 *
 * 多凭据入站上，各人拿的是自己那条派生节点，所以要问的是「这个入站上有谁的
 * 凭据」——只查当前这条节点的分享记录会永远返回空，界面上就成了「谁都没分享」。
 */
export async function getProxyNodeShareRecipients(nodeId: number): Promise<number[]> {
  const scope = await resolveProxyNodeShareScope(Number(nodeId));
  if (scope?.kind === "inbound") {
    return Array.from((await getSharedNodeIdsByInbound(scope.inboundId)).keys());
  }
  const map = await getProxyNodeShareUserIds([Number(nodeId)]);
  return map.get(Number(nodeId)) || [];
}

/** 分享到某个用户名下的节点行（原样，未做分享改写）。 */
export async function getProxyNodesSharedToUser(userId: number) {
  const ids = await getProxyNodeIdsSharedToUser(userId);
  if (ids.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxyNodes)
    .where(and(inArray(proxyNodes.id, ids), eq(proxyNodes.isEnabled, true)))
    .orderBy(asc(proxyNodes.sortOrder), asc(proxyNodes.id));
}

/**
 * 订阅要用的节点：自己的，加上别人分享给我的。
 *
 * 订阅组装的每一处都得走这个函数，不能有的地方用 getProxyNodesByUser ——
 * 计划和文档两次取的模板集合一旦不一致，订阅里会出现「有节点名没节点」
 * 或者策略组指向不存在的节点这种坏配置。
 */
export async function getProxyNodesForSubscription(userId: number) {
  const [owned, shared] = await Promise.all([
    getProxyNodesByUser(userId),
    getProxyNodesSharedToUser(userId),
  ]);
  // 只可能摘掉主人自己节点挂着的凭据：自己没有节点就不用查，有就只查这几条凭据。
  const sharedCredentialIds = await getSharedCredentialUserIds(
    (owned as any[]).map((row) => Number(row.inboundUserId || 0)),
  );
  /**
   * 为别人单独发的凭据不进主人自己的订阅。
   *
   * 那条节点归属确实是主人（凭据长在他的端口上），但它只为某个租户而存在 ——
   * 留着的话，主人的客户端里每多一个租户就多一条一模一样、只有凭据不同的
   * 线路，十个租户就是十条垃圾。
   */
  const own = sharedCredentialIds.size === 0
    ? owned
    : (owned as any[]).filter((row) => !sharedCredentialIds.has(Number(row.inboundUserId || 0)));
  return [...own, ...shared.map((row: any) => shareProxyNodeRow(row))];
}

// ==================== 落地机的套餐用量 ====================

/**
 * 给一批落地节点累加已用流量。
 *
 * 为什么要单独存一列而不是查 traffic_stats 求和：那张表只保留 72 小时，
 * 过期行会被清掉。要显示「这个月用了 367G」就必须有一个不会被清的累计值。
 *
 * 口径要说清：这里只累加**经过面板转发规则**的流量。订阅里的「直连」条目是
 * 客户端直连落地机的，中转机不在路径上，面板看不见；这台机器上跑的别的服务
 * 同理。所以这个数只会小于等于机房账单，需要对齐时用 setProxyNodeTrafficUsed
 * 手工校准。
 */
export async function addProxyNodeTraffic(entries: ReadonlyMap<number, number>) {
  if (entries.size === 0) return;
  const db = await getDb();
  if (!db) return;
  for (const [nodeId, bytes] of entries) {
    const id = Number(nodeId);
    const delta = Number(bytes);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(delta) || delta <= 0) continue;
    await db.update(proxyNodes).set({
      trafficUsed: sql`${proxyNodes.trafficUsed} + ${delta}`,
      updatedAt: nowDate(),
    }).where(eq(proxyNodes.id, id));
  }
}

/** 手工校准已用量，用来跟机房的账单对齐。之后仍然继续累加。 */
export async function setProxyNodeTrafficUsed(id: number, bytes: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(proxyNodes).set({
    trafficUsed: Math.max(0, Math.floor(Number(bytes) || 0)),
    updatedAt: nowDate(),
  }).where(eq(proxyNodes.id, Number(id)));
}

/** 用量清零，并记下这次重置的时间（月度自动重置靠它判断本周期是否已经重置过）。 */
export async function resetProxyNodeTraffic(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(proxyNodes).set({
    trafficUsed: 0,
    lastTrafficReset: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(proxyNodes.id, Number(id)));
}

/**
 * 该做月度重置的节点。
 *
 * 只挑「开了自动重置、且今天已经到了重置日」的，重复触发由 lastTrafficReset
 * 挡住 —— 调度任务每小时跑一次，不挡的话一天会清零二十几次。
 */
export async function getProxyNodesForTrafficAutoReset(_reference = nowDate()) {
  const db = await getDb();
  if (!db) return [];
  /*
    只按「开了自动重置」过滤，到期与否交给调用方按当月天数判断。

    原来这里还带一条 `trafficResetDay <= 今天几号` 的预筛。那条在重置日只能填到
    28 时是对的，一旦放开到 31 就会漏：二月 28 号那天 `31 <= 28` 不成立，设成
    每月 31 号的节点整个二月都不会重置 —— 而用户看到的只是「设了自动重置却从来
    没重置过」，查不出原因。

    夹当月天数这件事 `billingMonthlyBoundary` 已经会做了，主机那一路也一直是
    「先取出开了开关的，再逐行判断」。少一条预筛换两条路算法一致，值得。
  */
  return db
    .select()
    .from(proxyNodes)
    .where(eq(proxyNodes.trafficAutoReset, true));
}

// ==================== 客户端订阅：令牌 ====================

/** 某个用户有几条订阅地址。配额检查用。 */
export async function countProxySubTokensByUser(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: proxySubTokens.id })
    .from(proxySubTokens)
    .where(eq(proxySubTokens.userId, Number(userId)));
  return rows.length;
}

export async function getProxySubTokensByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxySubTokens)
    .where(eq(proxySubTokens.userId, userId))
    .orderBy(asc(proxySubTokens.id));
}

export async function getProxySubTokenById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxySubTokens).where(eq(proxySubTokens.id, id)).limit(1);
  return rows[0];
}

export async function getProxySubTokenByToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxySubTokens).where(eq(proxySubTokens.token, token)).limit(1);
  return rows[0];
}

export async function createProxySubToken(data: InsertProxySubToken) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("proxy_sub_tokens", data as any);
}

/**
 * 订阅令牌的长度。地址里带着全部节点凭据，短了能被猜到。
 * 自动开的那条和手工建的那条必须一样长 —— 两处各写一个数字迟早会分叉。
 */
export const PROXY_SUB_TOKEN_LENGTH = 40;

/**
 * 没有订阅地址就自动开一条。
 *
 * 「买了套餐 → 进面板 → 还得自己点一下新建链接 → 才拿得到地址」，中间这一步
 * 对用户没有任何意义：他要的就是那条地址。开通即可用，才叫开通。
 *
 * 已经有地址（哪怕是停用的）就不动，免得他删掉之后又被自动加回来。
 */
export async function ensureDefaultProxySubToken(
  userId: number,
  name = "默认订阅",
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const existing = await countProxySubTokensByUser(userId);
  if (existing > 0) return 0;
  const { nanoid } = await import("nanoid");
  return Number(await insertAndGetId("proxy_sub_tokens", {
    userId,
    name,
    token: nanoid(PROXY_SUB_TOKEN_LENGTH),
    defaultFormat: "base64",
    rulePreset: "balanced",
  } as any));
}

export async function updateProxySubToken(id: number, data: Partial<InsertProxySubToken>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(proxySubTokens).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxySubTokens.id, id));
}

export async function deleteProxySubToken(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(proxySubTokens).where(eq(proxySubTokens.id, id));
}

/**
 * 记录一次订阅拉取。失败不应该影响订阅内容的返回，所以调用方按尽力而为处理。
 *
 * 次数交给数据库自己加，不先读出来再写回去：同一条订阅地址常常是好几个客户端同时
 * 在拉（手机、电脑、路由器各刷各的），先读后写的话它们会读到同一个旧值、写回同一个
 * 新值，二十次拉取只涨一次。商家看这个数就是想知道「客户端到底拉没拉过、拉得勤不勤」，
 * 少记的那些正是最该看见的那部分。
 */
export async function recordProxySubTokenAccess(id: number, info: { ip?: string; userAgent?: string }) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(proxySubTokens)
    .set({
      accessCount: sql`COALESCE(${proxySubTokens.accessCount}, 0) + 1`,
      lastAccessAt: nowDate(),
      lastAccessIp: (info.ip || "").slice(0, 64) || null,
      lastAccessUserAgent: (info.userAgent || "").slice(0, 200) || null,
      /*
        拉成功了就把上一次被拒清掉。
        「现在到底行不行」是这一行要回答的唯一问题，而清掉比留着靠时间先后去比更准 ——
        两列都是按秒存的，同一秒里先拒后成，比时间只会比出个平手。
      */
      lastFailureAt: null,
      lastFailureReason: null,
      updatedAt: nowDate(),
    } as any)
    .where(eq(proxySubTokens.id, id));
}

/**
 * 记一笔被拒的拉取。
 *
 * 和成功那一笔一样是「顺手记」，失败了也不影响给客户端的回应 —— 这是给商家看的
 * 线索，不是业务流程的一环。
 *
 * 令牌本身查不到（地址被改过、被重置过）时**记不了**：那时候没有任何一行能挂上
 * 这笔记录。界面上也不该假装能分辨那一种。
 */
export async function recordProxySubTokenFailure(
  id: number,
  reason: ProxySubTokenFailureReason,
  info: { ip?: string; userAgent?: string } = {},
) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(proxySubTokens)
    .set({
      lastFailureAt: nowDate(),
      lastFailureReason: reason,
      // 失败这一次的来路也留下：同一条地址是被一个客户端反复拉，还是好几个人在拉，
      // 排查时是两回事。
      lastAccessIp: (info.ip || "").slice(0, 64) || null,
      lastAccessUserAgent: (info.userAgent || "").slice(0, 200) || null,
      updatedAt: nowDate(),
    } as any)
    .where(eq(proxySubTokens.id, id));
}

// ==================== 组装订阅 ====================

/**
 * 取出该用户的转发、模板与入口主机，算出订阅节点列表。
 *
 * 主机不按 userId 过滤：转发可以建在共享主机上，那台主机未必属于这个用户，
 * 但入口地址仍然是它的。规则本身已按 userId 限定，不会越权。
 */
/**
 * 组装订阅要的两样东西：算好的 plan，和它用到的那份节点模板。
 *
 * 合成一个函数是因为它们**本来就是一次查出来的**。原来 plan 在里面查了一遍模板，
 * 外面渲染文档时又查了一遍（每遍三条查询：自己的、别人分享的、独立凭据的），
 * 一次订阅拉取白跑三条。客户端十二小时刷一次不觉得，可有人把间隔调到几分钟、
 * 一个商家几百个租户时，白跑的就是几百倍。
 */
async function buildProxySubscriptionContextForUser(userId: number): Promise<{
  plan: ProxySubscriptionPlan;
  templates: any[];
}> {
  const db = await getDb();
  if (!db) return { plan: { entries: [], skipped: [], warnings: [] }, templates: [] };

  const rules = await db
    .select({
      id: forwardRules.id,
      hostId: forwardRules.hostId,
      name: forwardRules.name,
      sourcePort: forwardRules.sourcePort,
      // 规则专属域名：开关开着、发布成功过就用它当节点地址，换入口时客户端不用刷新订阅。
      entryDomainEnabled: forwardRules.entryDomainEnabled,
      entryDomain: forwardRules.entryDomain,
      entryDomainValue: forwardRules.entryDomainValue,
      // QUIC 系节点绑到只放行 TCP 的转发上会静默连不上，订阅组装时要据此排除。
      protocol: forwardRules.protocol,
      proxyNodeId: forwardRules.proxyNodeId,
      proxyNodeVisible: forwardRules.proxyNodeVisible,
      proxyNodeName: forwardRules.proxyNodeName,
      isEnabled: forwardRules.isEnabled,
      pendingDelete: forwardRules.pendingDelete,
      sortOrder: forwardRules.sortOrder,
      // 核对「绑定还算不算真的」：目标已经不指向那个节点时要告警，见 proxyNodeBindingTruth。
      targetIp: forwardRules.targetIp,
      targetPort: forwardRules.targetPort,
      // 链 / 转发组 / 线路组拆出来的内部规则，主规则已绑节点时不再单独出节点。
      forwardGroupRuleId: forwardRules.forwardGroupRuleId,
      isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
      routeParentRuleId: forwardRules.routeParentRuleId,
    })
    .from(forwardRules)
    .where(and(eq(forwardRules.userId, userId), eq(forwardRules.pendingDelete, false)))
    .orderBy(asc(forwardRules.sortOrder), asc(forwardRules.id));

  const templates = await getProxyNodesForSubscription(userId) as any[];

  /**
   * 自建节点开在哪台机器上。
   *
   * proxy_nodes 上没有 hostId —— 它只记了自己是从哪个入站派生的。想知道「这条线路
   * 的机器连上没有」，得再走一步。粘来的、别人分享的没有 inboundId，也就没有机器，
   * 面板对那些机器的状态本来就无话可说。
   */
  const inboundIds = Array.from(new Set(templates
    .map((template) => Number(template?.inboundId || 0))
    .filter((id) => id > 0)));
  if (inboundIds.length > 0) {
    const inboundHosts = await db
      .select({ id: proxyInbounds.id, hostId: proxyInbounds.hostId })
      .from(proxyInbounds)
      .where(inArray(proxyInbounds.id, inboundIds));
    const hostIdByInbound = new Map((inboundHosts as any[]).map((row) => [Number(row.id), Number(row.hostId)]));
    for (const template of templates) {
      const hostId = hostIdByInbound.get(Number(template?.inboundId || 0));
      if (hostId) (template as any).hostId = hostId;
    }
  }

  /**
   * 只取真正用得上的那几台机器。
   *
   * 原来是 `select * from hosts` 不带条件 —— 一个商家几百台机器，每来一次订阅拉取
   * 就整表读一遍，而实际用到的只有「这些转发的入口机」加「这些自建节点所在的机器」。
   * 不按 userId 过滤是对的（转发可以建在共享主机上，那台机器未必属于他），但按
   * **用到的 id** 过滤既正确又省事。
   */
  const hostIds = Array.from(new Set([
    ...rules.map((rule: any) => Number(rule.hostId || 0)),
    ...templates.map((template: any) => Number(template.hostId || 0)),
  ].filter((id) => id > 0)));
  const hostRows = hostIds.length > 0
    ? await db
      .select({
        id: hosts.id,
        name: hosts.name,
        ip: hosts.ip,
        ipv4: hosts.ipv4,
        ipv6: hosts.ipv6,
        entryIp: hosts.entryIp,
        ddnsEnabled: hosts.ddnsEnabled,
        ddnsDomain: hosts.ddnsDomain,
        // 从没收过心跳 = Agent 还没装上，见 hostNeverConnected。
        lastHeartbeat: hosts.lastHeartbeat,
      })
      .from(hosts)
      .where(inArray(hosts.id, hostIds))
    : [];

  const { activeSuffix } = await getRuleEntryDomainRuntimeSettings();
  const unreachableRuleIds = await getProxySubHideUnreachable(userId)
    ? await getUnreachableRuleIds(rules.filter((rule: any) => Number(rule.proxyNodeId || 0) > 0).map((rule: any) => Number(rule.id)))
    : undefined;
  return {
    plan: buildProxySubscriptionPlan({
      rules: rules as any,
      templates: templates as any,
      hosts: hostRows as any,
      ruleEntryDomainSuffix: activeSuffix,
      unreachableRuleIds,
    }),
    templates,
  };
}

/*
  「自动隐藏不通的节点」：每个用户自己的开关，默认开。
  存在 system_settings 里（键带用户 id），不为一个布尔值去动订阅表结构。
*/
const HIDE_UNREACHABLE_KEY_PREFIX = "proxySubHideUnreachable:";

export async function getProxySubHideUnreachable(userId: number): Promise<boolean> {
  const value = await getSetting(`${HIDE_UNREACHABLE_KEY_PREFIX}${Number(userId)}`).catch(() => null);
  return value !== "false";
}

export async function setProxySubHideUnreachable(userId: number, enabled: boolean): Promise<void> {
  await setSetting(`${HIDE_UNREACHABLE_KEY_PREFIX}${Number(userId)}`, enabled ? "true" : "false");
}

/**
 * 取出该用户的转发、模板与入口主机，算出订阅节点列表。
 */
export async function buildProxySubscriptionPlanForUser(userId: number): Promise<ProxySubscriptionPlan> {
  return (await buildProxySubscriptionContextForUser(userId)).plan;
}

/**
 * 订阅实际要渲染的内容：去重后的节点、策略组、分流规则。
 *
 * 规则预设按订阅链接（即按设备）算，不同设备可以要不同的分流。
 */
export async function getProxySubscriptionDocumentForUser(
  userId: number,
  options: { rulePreset?: unknown } = {},
): Promise<ProxySubscriptionDocument> {
  return (await getProxySubscriptionPreviewForUser(userId, options)).document;
}

/**
 * 「订阅内容」那一屏要的两样：算出来的 plan（谁进了、谁没进、为什么），
 * 和渲染出来的 document（策略组长什么样）。
 *
 * 要合在一个函数里，是因为它们必须是**同一次读库**的结果。分两次要的话，
 * 中间只要有人删掉一条转发，这一屏就会自相矛盾：策略组里列着一个节点，
 * 底下的节点清单里却没有它。而这一屏存在的全部意义就是回答
 * 「我的订阅里到底有什么」—— 它自己前后不一致，比慢一点严重得多。
 * 顺带也省掉白跑的那一遍（原来一次预览要把整份订阅组装两遍）。
 */
export async function getProxySubscriptionPreviewForUser(
  userId: number,
  options: { rulePreset?: unknown } = {},
): Promise<{ plan: ProxySubscriptionPlan; document: ProxySubscriptionDocument }> {
  // plan 和它用到的模板一次查出来，不再各查一遍。
  const { plan, templates } = await buildProxySubscriptionContextForUser(userId);
  const document = buildProxySubscriptionDocument(plan, templates as any, {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
    rulePreset: normalizeProxyRulePreset(options.rulePreset),
  });
  return { plan, document };
}
