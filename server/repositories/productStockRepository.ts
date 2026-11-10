import { boolLiteral } from "../dbCompat";
import {
  executeRaw,
  getDatabaseKind,
  isDatabaseTransactionActive,
  queryRaw,
  quoteDbIdentifier,
  rawAffectedRows,
  withDatabaseTransaction,
} from "../dbRuntime";
import { getSetting } from "./settingsRepository";

/**
 * 套餐与按量计费资源的库存（上游 2.3.289）。
 *
 * 两种商品的占用方式不一样，所以防超售的手法也不一样：
 *
 * - **套餐**卖的是「份数」，卖出去就不回来。占用数存在 subscription_plans.stockUsed 上，
 *   用一条带条件的 UPDATE 占额 —— 判断和加一是同一条语句，三种数据库都是原子的，
 *   不依赖事务隔离级别，也不依赖进程内的锁（多个面板实例共用一个库时一样成立）。
 * - **按量资源**卖的是「席位」，一个账号在一个资源上只占一席，规则删光就让出来。
 *   能让出席位的路径太多（删规则、删主机、删用户、转发组解散……），存一个计数迟早
 *   漏掉一条路径，席位就永远回不来。所以占用数不存，每次按现有规则现算；并发靠
 *   「先锁住这条计费配置，再数、再写」来串行化。
 *
 * 这个文件只依赖 dbRuntime 和设置表，不引用计费 / 规则仓库 —— 那两边都要调它，
 * 反过来引用会成环。
 */

const q = quoteDbIdentifier;

export const PLAN_STOCK_SOLD_OUT_MESSAGE = "套餐库存不足或已售罄";
export const TRAFFIC_STOCK_SOLD_OUT_MESSAGE = "该计费资源库存不足或已售罄";

// ==================== 套餐销售库存 ====================

/**
 * 占一份套餐库存。占到返回 true，卖完了返回 false（由调用方决定报什么错 ——
 * 在线支付的发货要报「永久失败」把钱转回余额，余额购买直接把话告诉用户）。
 *
 * 必须和「建订单 / 开订阅」在同一个事务里：后面任何一步失败，占的这一份跟着回滚。
 *
 * stockLimit = 0（不限）时照样累加 stockUsed：管理员之后想改成限量，能看到
 * 从启用库存起已经卖了多少，在这个数上设总量。
 */
export async function tryReservePlanStock(planId: number) {
  if (!isDatabaseTransactionActive()) throw new Error("套餐库存必须在数据库事务内占用");
  const result = await executeRaw(
    `UPDATE ${q("subscription_plans")}
        SET ${q("stockUsed")} = ${q("stockUsed")} + 1
      WHERE ${q("id")} = ?
        AND (${q("stockLimit")} = 0 OR ${q("stockUsed")} < ${q("stockLimit")})`,
    [planId],
  );
  return rawAffectedRows(result) === 1;
}

/** 退回一份套餐库存（只有没付款的订单关闭、或付了款却发不了货时才会走到）。 */
export async function releasePlanStock(planId: number) {
  if (!isDatabaseTransactionActive()) throw new Error("套餐库存必须在数据库事务内退回");
  await executeRaw(
    `UPDATE ${q("subscription_plans")}
        SET ${q("stockUsed")} = ${q("stockUsed")} - 1
      WHERE ${q("id")} = ? AND ${q("stockUsed")} > 0`,
    [planId],
  );
}

// ==================== 按量资源的账号库存 ====================

type TrafficStockResourceType = "forward_group" | "tunnel" | "host";

type TrafficStockConfig = {
  id: number;
  resourceType: TrafficStockResourceType;
  resourceId: number;
  enabled: boolean;
  stockLimit: number;
  maxRulesPerUser: number;
};

/** 库存判断只看规则上的这几列。 */
export type TrafficStockRule = {
  id?: number | null;
  userId?: number | null;
  hostId?: number | null;
  tunnelId?: number | null;
  forwardGroupId?: number | null;
  forwardGroupRuleId?: number | null;
  forwardGroupMemberId?: number | null;
  routeParentRuleId?: number | null;
  pendingDelete?: unknown;
};

/** 改了这几列之一，规则占的席位才可能变。 */
export const TRAFFIC_STOCK_RULE_KEYS = [
  "userId",
  "hostId",
  "tunnelId",
  "forwardGroupId",
  "forwardGroupRuleId",
  "forwardGroupMemberId",
  "routeParentRuleId",
  "pendingDelete",
] as const;

const RESOURCE_COLUMN: Record<TrafficStockResourceType, "forwardGroupId" | "tunnelId" | "hostId"> = {
  forward_group: "forwardGroupId",
  tunnel: "tunnelId",
  host: "hostId",
};

function positiveId(value: unknown) {
  const id = Math.floor(Number(value) || 0);
  return id > 0 ? id : 0;
}

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * 是不是用户自己建的那条「逻辑规则」。
 *
 * 转发组 / 多入口展开出来的子规则、线路组在中转机上生成的中继规则都是面板替他建的，
 * 一条逻辑规则能展开出几十条 —— 按它们数的话，一个人建一条规则就把「每账号规则上限」
 * 用完了。和规则数配额（getUserRuleCount）是同一个口径。已删除、只等 Agent 确认的
 * （pendingDelete）不算：席位在点删除的那一刻就让出来。
 */
export function isLogicalForwardRule(rule: TrafficStockRule | null | undefined) {
  return !!rule
    && !positiveId(rule.forwardGroupRuleId)
    && !positiveId(rule.forwardGroupMemberId)
    && !positiveId(rule.routeParentRuleId)
    && !truthy(rule.pendingDelete);
}

function logicalRuleCondition(alias: string) {
  return `COALESCE(${alias}.${q("forwardGroupRuleId")}, 0) = 0
    AND COALESCE(${alias}.${q("forwardGroupMemberId")}, 0) = 0
    AND COALESCE(${alias}.${q("routeParentRuleId")}, 0) = 0
    AND ${alias}.${q("pendingDelete")} = ${boolLiteral(false)}`;
}

function configKey(resourceType: string, resourceId: unknown) {
  return `${resourceType}:${positiveId(resourceId)}`;
}

/** 和计费找配置的顺序一致：转发组 → 隧道 → 主机，命中第一个启用的就是它。 */
function ruleConfigKeys(rule: TrafficStockRule) {
  const keys: string[] = [];
  if (positiveId(rule.forwardGroupId)) keys.push(configKey("forward_group", rule.forwardGroupId));
  if (positiveId(rule.tunnelId)) keys.push(configKey("tunnel", rule.tunnelId));
  if (positiveId(rule.hostId)) keys.push(configKey("host", rule.hostId));
  return keys;
}

type TrafficStockConfigRow = Record<"id" | "resourceType" | "resourceId" | "enabled" | "stockLimit" | "maxRulesPerUser", unknown>;

/** 按资源归属分组后的一行规则（各库返回的数字类型不一，统一当 unknown 再转）。 */
type TrafficStockRuleRow = TrafficStockRule & { userId: number; ruleCount?: number };

function normalizeConfig(row: TrafficStockConfigRow): TrafficStockConfig {
  return {
    id: Number(row.id),
    resourceType: String(row.resourceType) as TrafficStockResourceType,
    resourceId: Number(row.resourceId),
    enabled: truthy(row.enabled),
    stockLimit: Math.max(0, Math.floor(Number(row.stockLimit) || 0)),
    maxRulesPerUser: Math.max(0, Math.floor(Number(row.maxRulesPerUser) || 0)),
  };
}

const CONFIG_COLUMNS = ["id", "resourceType", "resourceId", "enabled", "stockLimit", "maxRulesPerUser"]
  .map((column) => `${q(column)} AS ${q(column)}`)
  .join(", ");

async function loadEnabledConfigs() {
  const rows = await queryRaw<TrafficStockConfigRow>(
    `SELECT ${CONFIG_COLUMNS} FROM ${q("traffic_billing_configs")} WHERE ${q("enabled")} = ${boolLiteral(true)}`,
  );
  return new Map(rows.map((row) => {
    const config = normalizeConfig(row);
    return [configKey(config.resourceType, config.resourceId), config] as const;
  }));
}

function effectiveConfig(rule: TrafficStockRule, configs: Map<string, TrafficStockConfig>) {
  for (const key of ruleConfigKeys(rule)) {
    const config = configs.get(key);
    if (config) return config;
  }
  return null;
}

async function trafficBillingEnabled() {
  return (await getSetting("trafficBillingEnabled")) === "true";
}

async function adminUserIds(userIds: number[]) {
  const ids = Array.from(new Set(userIds.map(positiveId).filter(Boolean)));
  if (ids.length === 0) return new Set<number>();
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} AS ${q("id")} FROM ${q("users")}
      WHERE ${q("role")} = 'admin' AND ${q("id")} IN (${ids.map(() => "?").join(", ")})`,
    ids,
  );
  return new Set(rows.map((row) => Number(row.id)));
}

export type TrafficStockUsage = {
  /** 计费配置 id → 占着席位的账号数。 */
  usedByConfigId: Map<number, number>;
  /** 计费配置 id → 查看者自己在这个资源上的逻辑规则数（没传查看者就是空的）。 */
  viewerRulesByConfigId: Map<number, number>;
};

/**
 * 各计费资源现在被几个账号占着，以及查看者自己占了几条规则。给管理页和商店展示用。
 *
 * 按（账号、转发组、隧道、主机）分组后在内存里归到各自生效的那条配置上 —— 一条规则
 * 同时落在转发组和主机两条配置里时只算优先级高的那条，和扣费走的是同一条配置。
 *
 * 管理员名下的规则不算：管理员用自己的资源不计费（见 agentReportRoutes 的扣费分支），
 * 不是买家，不该占客户的席位。
 */
export async function getTrafficStockUsage(viewerUserId?: number | null): Promise<TrafficStockUsage> {
  const usage: TrafficStockUsage = { usedByConfigId: new Map(), viewerRulesByConfigId: new Map() };
  if (!(await trafficBillingEnabled())) return usage;
  const configs = await loadEnabledConfigs();
  if (configs.size === 0) return usage;
  const idsOf = (resourceType: TrafficStockResourceType) => Array.from(configs.values())
    .filter((config) => config.resourceType === resourceType)
    .map((config) => config.resourceId);
  const conditions: string[] = [];
  const params: number[] = [];
  for (const resourceType of ["forward_group", "tunnel", "host"] as const) {
    const ids = idsOf(resourceType);
    if (ids.length === 0) continue;
    conditions.push(`r.${q(RESOURCE_COLUMN[resourceType])} IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }
  const rows = await queryRaw<TrafficStockRuleRow>(
    `SELECT r.${q("userId")} AS ${q("userId")},
            r.${q("forwardGroupId")} AS ${q("forwardGroupId")},
            r.${q("tunnelId")} AS ${q("tunnelId")},
            r.${q("hostId")} AS ${q("hostId")},
            COUNT(*) AS ${q("ruleCount")}
       FROM ${q("forward_rules")} r
       JOIN ${q("users")} u ON u.${q("id")} = r.${q("userId")}
      WHERE (${conditions.join(" OR ")})
        AND ${logicalRuleCondition("r")}
        AND u.${q("role")} <> 'admin'
      GROUP BY r.${q("userId")}, r.${q("forwardGroupId")}, r.${q("tunnelId")}, r.${q("hostId")}`,
    params,
  );
  const usersByConfigId = new Map<number, Set<number>>();
  const viewerId = positiveId(viewerUserId);
  for (const row of rows) {
    const config = effectiveConfig(row, configs);
    if (!config) continue;
    const userId = Number(row.userId);
    const holders = usersByConfigId.get(config.id) || new Set<number>();
    holders.add(userId);
    usersByConfigId.set(config.id, holders);
    if (viewerId && userId === viewerId) {
      usage.viewerRulesByConfigId.set(config.id, (usage.viewerRulesByConfigId.get(config.id) || 0) + Number(row.ruleCount || 0));
    }
  }
  for (const [configId, holders] of usersByConfigId) usage.usedByConfigId.set(configId, holders.size);
  return usage;
}

type TrafficStockCheckPlan = {
  next: TrafficStockRule;
  previous?: TrafficStockRule | null;
  /** 这条规则写下去之后会落在哪条计费配置上。 */
  configId: number;
  /** 规则原来落在哪条配置上（改规则时才有）；和目标一起锁，顺序固定，避免两条互换资源的修改互相等。 */
  previousConfigId: number;
};

/**
 * 不加锁先看一眼：这次写入要不要做库存校验。
 *
 * 绝大多数规则根本不落在限量的计费资源上，这一步让它们完全不受影响 —— 不开事务、
 * 不加行锁。这里读到的只用来决定「要不要进入加锁的那条路」，真正的判断在锁里重读。
 */
async function planTrafficRuleStockCheck(
  next: TrafficStockRule,
  previous?: TrafficStockRule | null,
): Promise<TrafficStockCheckPlan | null> {
  if (!isLogicalForwardRule(next)) return null;
  if (ruleConfigKeys(next).length === 0) return null;
  if (!(await trafficBillingEnabled())) return null;
  const configs = await loadEnabledConfigs();
  const config = effectiveConfig(next, configs);
  if (!config || (config.stockLimit === 0 && config.maxRulesPerUser === 0)) return null;
  const previousConfig = isLogicalForwardRule(previous) ? effectiveConfig(previous!, configs) : null;
  // 同一个账号、还在同一个资源上：只是改了端口 / 目标之类，席位和规则数都没变。
  if (previousConfig?.id === config.id && positiveId(previous?.userId) === positiveId(next.userId)) return null;
  // 管理员不是买家（不扣费），不占席位也不受每账号上限限制。
  if ((await adminUserIds([positiveId(next.userId)])).size > 0) return null;
  return { next, previous, configId: config.id, previousConfigId: previousConfig?.id || 0 };
}

/**
 * 在事务里、拿着计费配置的行锁做真正的校验。通不过就抛错，整个事务回滚。
 *
 * 三种数据库各自靠什么保证「数完再写」中间没人插进来：
 * - SQLite：事务是 BEGIN IMMEDIATE，整库只有一个写者，进到这里时别的写事务都在外面等。
 * - PostgreSQL：SELECT … FOR UPDATE 锁住配置行，同一资源的并发创建在这里排队；默认的
 *   READ COMMITTED 下，排到之后的每条语句都能看到前一个人已提交的规则。
 * - MySQL：同样先锁配置行。但 InnoDB 默认 REPEATABLE READ，普通 SELECT 读的是事务里
 *   第一次读时的快照 —— 排队等到锁之后，快照里仍然没有前一个人刚提交的规则，照着它
 *   数就会超售。所以数规则那条加共享锁做当前读，读到的是最新已提交的数据。
 *   （写 LOCK IN SHARE MODE 而不是 FOR SHARE：两者在 MySQL 8 里等价，前者 MariaDB 也认。）
 */
async function enforceTrafficRuleStock(plan: TrafficStockCheckPlan) {
  if (!isDatabaseTransactionActive()) throw new Error("按量库存校验必须在数据库事务内执行");
  const kind = getDatabaseKind();
  const rowLock = kind === "sqlite" ? "" : " FOR UPDATE";
  const lockIds = Array.from(new Set([plan.configId, plan.previousConfigId].filter(Boolean))).sort((left, right) => left - right);
  const locked = await queryRaw<TrafficStockConfigRow>(
    `SELECT ${CONFIG_COLUMNS} FROM ${q("traffic_billing_configs")}
      WHERE ${q("id")} IN (${lockIds.map(() => "?").join(", ")})
      ORDER BY ${q("id")}${rowLock}`,
    lockIds,
  );
  const lockedRow = locked.find((row) => Number(row.id) === plan.configId);
  const config = lockedRow ? normalizeConfig(lockedRow) : null;
  // 等锁的这段时间里配置被删、被停用或被改成不限：没有可校验的了。
  if (!config || !config.enabled || (config.stockLimit === 0 && config.maxRulesPerUser === 0)) return;

  const userId = positiveId(plan.next.userId);
  const column = RESOURCE_COLUMN[config.resourceType];
  // 库存不限时只需要数这个账号自己的规则；限量时要数全部占用者。
  const onlyOwn = config.stockLimit === 0;
  const currentRead = kind === "mysql" ? " LOCK IN SHARE MODE" : "";
  const rows = await queryRaw<TrafficStockRuleRow>(
    `SELECT r.${q("id")} AS ${q("id")},
            r.${q("userId")} AS ${q("userId")},
            r.${q("forwardGroupId")} AS ${q("forwardGroupId")},
            r.${q("tunnelId")} AS ${q("tunnelId")},
            r.${q("hostId")} AS ${q("hostId")}
       FROM ${q("forward_rules")} r
      WHERE r.${q(column)} = ?
        AND ${logicalRuleCondition("r")}
        AND r.${q("id")} <> ?
        ${onlyOwn ? `AND r.${q("userId")} = ?` : ""}${currentRead}`,
    [config.resourceId, positiveId(plan.previous?.id ?? plan.next.id), ...(onlyOwn ? [userId] : [])],
  );
  // 主机 / 隧道这两档是兜底价：同一台机器上被转发组或隧道单独计价的规则不归它管。
  const configs = config.resourceType === "forward_group" ? null : await loadEnabledConfigs();
  const occupying = configs
    ? rows.filter((row) => effectiveConfig(row, configs)?.id === config.id)
    : rows;
  const ownCount = occupying.filter((row) => Number(row.userId) === userId).length;
  if (config.maxRulesPerUser > 0 && ownCount >= config.maxRulesPerUser) {
    throw new Error(`已达到该计费资源的每账号规则上限（${config.maxRulesPerUser} 条）`);
  }
  // 已经占着席位的账号再建规则不重复占用，库存满了也照样能建（只受上面的每账号上限约束）。
  if (config.stockLimit > 0 && ownCount === 0) {
    const holders = new Set(occupying.map((row) => Number(row.userId)));
    for (const adminId of await adminUserIds(Array.from(holders))) holders.delete(adminId);
    if (holders.size >= config.stockLimit) throw new Error(TRAFFIC_STOCK_SOLD_OUT_MESSAGE);
  }
}

/**
 * 写一条规则（新建，或改动了账号 / 资源 / 删除标记）之前做按量库存校验，校验和写入
 * 在同一个事务里完成。
 *
 * `write` 收到的 `guarded` 为 true 表示这次写入是在库存锁里做的 —— 改规则的调用方据此
 * 再核对一遍规则行没被别人改过。不需要校验时 `write` 直接执行，不额外开事务。
 */
export async function withTrafficRuleStockGuard<T>(
  next: TrafficStockRule,
  previous: TrafficStockRule | null | undefined,
  write: (guarded: boolean) => Promise<T>,
): Promise<T> {
  const plan = await planTrafficRuleStockCheck(next, previous);
  if (!plan) return write(false);
  return withDatabaseTransaction(async () => {
    await enforceTrafficRuleStock(plan);
    return write(true);
  });
}
