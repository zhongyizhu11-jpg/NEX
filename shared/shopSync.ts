/*
  商城对接（Xboard / V2Board / SSPanel → NEX）的纯逻辑：设置的规范化、入参时间的换算、
  乱序回调的取舍。库和接口在 server/shopSync/。

  方向只有一个：商城是账本的主人，NEX 跟着开通 / 续期 / 变更 / 停用。NEX 这边不回写商城 ——
  两边都当主人，迟早会为「到底谁说了算」打架。

  乱序怎么判：每个商城用户在 NEX 记两条时间，都是商城那边给的 occurredAt（事件发生时间）：
    · activatedAt：最近一次生效的开通 / 续期 / 变更发生在什么时候；
    · stoppedAt：最近一次生效的停用发生在什么时候。
  开通类事件发生得不晚于 stoppedAt → 是停用之前的旧事件迟到了，忽略；
  停用发生得早于 activatedAt → 是更早的停用迟到了，忽略。
  时间相同时停用说了算（宁可少开，不多开）。两条时间都只拿商城的时钟比，不和 NEX 的时钟混着比；
  商城不传 occurredAt 时用收到的时间兜底，这时乱序保护就退化了 —— 文档里要求一定传。
*/

export const SHOP_SYNC_SETTING_KEY = "shopSyncConfig";

export const SHOP_KINDS = ["xboard", "v2board", "sspanel", "other"] as const;
export type ShopKind = (typeof SHOP_KINDS)[number];

export const SHOP_KIND_LABELS: Record<ShopKind, string> = {
  xboard: "Xboard",
  v2board: "V2Board",
  sspanel: "SSPanel-UIM",
  other: "其他",
};

/** 商城那边「套餐」叫什么：SSPanel 没有套餐 id，用户身上只有等级（class）。 */
export function shopPlanIdLabel(kind: ShopKind) {
  return kind === "sspanel" ? "用户等级" : "商城套餐 ID";
}

export type ShopPlanMapping = {
  /** 商城那边的套餐 id（SSPanel 是等级 class），一律按字符串存，比较时去掉首尾空白。 */
  shopPlanId: string;
  /** NEX 的套餐 id。 */
  planId: number;
};

export type ShopSyncConfig = {
  /** 总开关，默认关：关着时入站接口一律拒绝。 */
  enabled: boolean;
  shop: ShopKind;
  /**
   * 商城用户第一次来、NEX 里已有同邮箱的账号时，要不要直接接管它。默认不：很多商城注册不验证邮箱，
   * 打开它等于让任何人在商城用别人的邮箱注册，就能改那个 NEX 账号的套餐。管理员账号永远不接管。
   */
  linkExistingByEmail: boolean;
  plans: ShopPlanMapping[];
};

export const DEFAULT_SHOP_SYNC_CONFIG: ShopSyncConfig = {
  enabled: false,
  shop: "xboard",
  linkExistingByEmail: false,
  plans: [],
};

export const SHOP_PLAN_MAPPING_MAX = 100;

export function normalizeShopPlanId(value: unknown): string {
  return String(value ?? "").trim().slice(0, 64);
}

function isShopKind(value: unknown): value is ShopKind {
  return typeof value === "string" && (SHOP_KINDS as readonly string[]).includes(value);
}

/** 库里 / 入参里的设置 → 规范形状。映射表去掉空行、重复的商城套餐只留第一条。 */
export function normalizeShopSyncConfig(value: unknown): ShopSyncConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const plans: ShopPlanMapping[] = [];
  for (const item of Array.isArray(raw.plans) ? raw.plans : []) {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const shopPlanId = normalizeShopPlanId(entry.shopPlanId);
    const planId = Math.floor(Number(entry.planId));
    if (!shopPlanId || !Number.isFinite(planId) || planId <= 0 || seen.has(shopPlanId)) continue;
    seen.add(shopPlanId);
    plans.push({ shopPlanId, planId });
    if (plans.length >= SHOP_PLAN_MAPPING_MAX) break;
  }
  return {
    enabled: raw.enabled === true,
    shop: isShopKind(raw.shop) ? raw.shop : DEFAULT_SHOP_SYNC_CONFIG.shop,
    linkExistingByEmail: raw.linkExistingByEmail === true,
    plans,
  };
}

export function parseShopSyncConfig(raw: string | null | undefined): ShopSyncConfig {
  if (!raw) return { ...DEFAULT_SHOP_SYNC_CONFIG, plans: [] };
  try {
    return normalizeShopSyncConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SHOP_SYNC_CONFIG, plans: [] };
  }
}

export function mappedPlanId(config: ShopSyncConfig, shopPlanId: unknown): number | null {
  const key = normalizeShopPlanId(shopPlanId);
  if (!key) return null;
  return config.plans.find((item) => item.shopPlanId === key)?.planId ?? null;
}

/*
  入站动作。open / renew / change 是同一件事的三个叫法：「这个用户现在该有这个套餐」——
  NEX 看自己这边的现状决定是新开、续期还是换套餐。这样商城那边只要把订单类型照搬过来，
  就算判断错了（比如 NEX 这边早已到期，商城还当续费发），结果也是对的。
*/
export const SHOP_SYNC_ACTIONS = ["activate", "open", "renew", "change", "stop"] as const;
export type ShopSyncAction = (typeof SHOP_SYNC_ACTIONS)[number];

export function isStopAction(action: ShopSyncAction) {
  return action === "stop";
}

/** 订单号 / 外部用户 id 允许的字符：够放 Xboard 的 trade_no、各种数字 id 和「state-12-1700000000」这类自拼的键。 */
export const SHOP_SYNC_KEY_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * 商城传来的时间 → 秒。接受秒、毫秒、ISO 字符串；认不出来返回 null。
 * 0 和负数也当认不出来：V2Board 的 expired_at 默认就是 0，表示「没设过」，不是 1970 年。
 */
export function shopTimeToSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 10_000_000_000 ? n / 1000 : n);
  }
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

export type ShopBindingClock = {
  activatedAt: number | null;
  stoppedAt: number | null;
};

export type ShopOrderingDecision = { apply: true } | { apply: false; reason: string };

function formatClock(seconds: number) {
  const date = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** 这条事件按发生时间看还该不该生效（见文件头的规则）。 */
export function decideShopEventOrdering(action: ShopSyncAction, occurredAt: number, clock: ShopBindingClock | null | undefined): ShopOrderingDecision {
  if (!clock) return { apply: true };
  if (isStopAction(action)) {
    if (clock.activatedAt && occurredAt < clock.activatedAt) {
      return { apply: false, reason: `这条停用发生在最近一次开通（${formatClock(clock.activatedAt)}）之前，已忽略` };
    }
    return { apply: true };
  }
  if (clock.stoppedAt && occurredAt <= clock.stoppedAt) {
    return { apply: false, reason: `商城在 ${formatClock(clock.stoppedAt)} 已停用这个用户，更早的开通不再生效` };
  }
  return { apply: true };
}

/** 往后挪的时间只许往前走：同一个用户的两条记录取较晚的那个。 */
export function laterClock(current: number | null | undefined, next: number) {
  return current && current > next ? current : next;
}

export const SHOP_SYNC_RECORD_STATUSES = ["processing", "applied", "ignored", "unmapped", "failed"] as const;
export type ShopSyncRecordStatus = (typeof SHOP_SYNC_RECORD_STATUSES)[number];

/** 已经有结论、同一个订单号再来就原样回给它的状态。unmapped / failed 允许重试：补好映射、腾出端口后商城重发能成。 */
export function isSettledShopRecord(status: string) {
  return status === "applied" || status === "ignored";
}

export const SHOP_SYNC_STATUS_LABELS: Record<ShopSyncRecordStatus, string> = {
  processing: "处理中",
  applied: "已生效",
  ignored: "已忽略",
  unmapped: "没映射",
  failed: "失败",
};

export type ShopSyncKind = "opened" | "renewed" | "changed" | "stopped" | "noop";

export const SHOP_SYNC_KIND_LABELS: Record<ShopSyncKind, string> = {
  opened: "开通",
  renewed: "续期",
  changed: "换套餐",
  stopped: "停用",
  noop: "无变化",
};

export const SHOP_SYNC_ACTION_LABELS: Record<ShopSyncAction, string> = {
  activate: "开通",
  open: "新购",
  renew: "续费",
  change: "变更",
  stop: "停用",
};
