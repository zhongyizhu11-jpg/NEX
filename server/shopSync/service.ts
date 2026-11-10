import crypto from "node:crypto";

import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { recordPanelEvent } from "../ops/panelEvents";
import {
  applySubscriptionToUser,
  cancelUserSubscription,
  extendUserSubscription,
  getSubscriptionPlanById,
  setUserSubscriptionExpiresAt,
} from "../repositories/billingRepository";
import { createUser, getUserById } from "../repositories/userRepository";
import { getSetting, setSetting } from "../repositories/settingsRepository";
import {
  SHOP_SYNC_KEY_PATTERN,
  SHOP_SYNC_SETTING_KEY,
  decideShopEventOrdering,
  isSettledShopRecord,
  isStopAction,
  laterClock,
  mappedPlanId,
  normalizeShopPlanId,
  normalizeShopSyncConfig,
  parseShopSyncConfig,
  shopTimeToSeconds,
  type ShopSyncAction,
  type ShopSyncConfig,
  type ShopSyncKind,
  type ShopSyncRecordStatus,
} from "../../shared/shopSync";

/*
  商城对接的入站处理（接口在 server/routers/shopSync.ts，表在 ./tables.ts，乱序规则在 shared/shopSync.ts）。

  一次回调的流程：
    1. 按订单号认领一行 shop_sync_orders。已有结论（applied / ignored）的原样回上次结果 —— 这就是幂等；
       unmapped / failed 的允许重试，同一行 attempts + 1。
    2. 找 / 建绑定（shop_sync_users），按乱序规则决定这条还生不生效。
    3. 调已有的计费层开通 / 续期 / 换套餐 / 停用：端口段、套餐快照、限速、可用资源这些全是套餐自己带的
       （applySubscriptionToUser），这里一行都不重写。开出来的订阅记成 admin 来源：钱是在商城收的，
       NEX 的账本里它是 0 元；用户也不能在 NEX 里自己续它 —— 续费得去商城，账本只有一个主人。
    4. 只动绑定里记着的那一条订阅。用户在 NEX 里自己买的、管理员手动给的，一概不碰。

  同一个商城用户的回调排队处理（进程内的键锁）；订单号的唯一索引兜住多实例同时认领的情况。
*/

const q = quoteDbIdentifier;
const DAY = 86_400;
/** processing 状态超过这么久还没结论，当作上次处理到一半进程没了，允许重试。 */
const STALE_PROCESSING_SECONDS = 120;

export class ShopSyncDisabledError extends Error {
  constructor() {
    super("商城对接没有开启：请在 设置 › 进阶 › 商城对接 里打开");
    this.name = "ShopSyncDisabledError";
  }
}

export class ShopSyncInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopSyncInputError";
  }
}

// ---------- 设置 ----------

export async function loadShopSyncConfig(): Promise<ShopSyncConfig> {
  return parseShopSyncConfig(await getSetting(SHOP_SYNC_SETTING_KEY));
}

export async function saveShopSyncConfig(input: unknown): Promise<ShopSyncConfig> {
  const next = normalizeShopSyncConfig(input);
  for (const item of next.plans) {
    const plan = await getSubscriptionPlanById(item.planId);
    if (!plan) throw new ShopSyncInputError(`映射里的 NEX 套餐 #${item.planId} 不存在`);
  }
  await setSetting(SHOP_SYNC_SETTING_KEY, JSON.stringify(next));
  return next;
}

// ---------- 入参 ----------

export type ShopSyncEventInput = {
  action: ShopSyncAction;
  orderId: string;
  user: { externalId: string; email?: string | null };
  shopPlanId?: string | number | null;
  /** 续多少天（叠加在现在的到期时间上）。和 expiresAt 都给时以 expiresAt 为准。 */
  durationDays?: number | null;
  /** 到期时间（秒 / 毫秒 / ISO）。给了 null 表示永久；不给（undefined）就按 durationDays 或套餐默认时长。 */
  expiresAt?: number | string | null;
  /** 事件在商城发生的时间，判乱序用。不给就用收到的时间。 */
  occurredAt?: number | string | null;
};

type NormalizedEvent = {
  action: ShopSyncAction;
  orderId: string;
  externalId: string;
  email: string | null;
  shopPlanId: string;
  durationDays: number | null;
  /** undefined = 没给；null = 永久；数字 = 秒。 */
  expiresAt: number | null | undefined;
  occurredAt: number;
};

function normalizeEmail(value: unknown): string | null {
  const text = String(value ?? "").trim().toLowerCase();
  return text && text.length <= 255 && /^[^\s@]+@[^\s@]+$/.test(text) ? text : null;
}

function normalizeEvent(input: ShopSyncEventInput, nowSec: number): NormalizedEvent {
  const orderId = String(input.orderId ?? "").trim();
  const externalId = String(input.user?.externalId ?? "").trim();
  if (!SHOP_SYNC_KEY_PATTERN.test(orderId)) throw new ShopSyncInputError("orderId 只能是 1–128 位字母、数字和 _ . : @ -");
  if (!SHOP_SYNC_KEY_PATTERN.test(externalId)) throw new ShopSyncInputError("user.externalId 只能是 1–128 位字母、数字和 _ . : @ -");
  const shopPlanId = normalizeShopPlanId(input.shopPlanId);
  if (!isStopAction(input.action) && !shopPlanId) throw new ShopSyncInputError("开通 / 续期 / 变更要带 shopPlanId");
  let expiresAt: number | null | undefined;
  if (input.expiresAt === undefined) expiresAt = undefined;
  else if (input.expiresAt === null) expiresAt = null;
  else {
    expiresAt = shopTimeToSeconds(input.expiresAt);
    if (expiresAt === null) throw new ShopSyncInputError("expiresAt 认不出来：传秒、毫秒或 ISO 时间；永久传 null");
  }
  const durationDays = input.durationDays === undefined || input.durationDays === null ? null : Math.floor(Number(input.durationDays));
  if (durationDays !== null && (!Number.isFinite(durationDays) || durationDays <= 0 || durationDays > 36_500)) {
    throw new ShopSyncInputError("durationDays 要在 1–36500 之间");
  }
  return {
    action: input.action,
    orderId,
    externalId,
    email: normalizeEmail(input.user?.email),
    shopPlanId,
    durationDays,
    expiresAt,
    occurredAt: shopTimeToSeconds(input.occurredAt) ?? nowSec,
  };
}

// ---------- 表读写 ----------

type BindingRow = {
  id: number;
  externalUserId: string;
  email: string | null;
  localUserId: number | null;
  createdByShop: boolean;
  subscriptionId: number | null;
  shopPlanId: string | null;
  status: string;
  activatedAt: number | null;
  stoppedAt: number | null;
};

type OrderRow = {
  id: number;
  orderId: string;
  externalUserId: string;
  status: string;
  kind: string | null;
  message: string | null;
  localUserId: number | null;
  subscriptionId: number | null;
  planId: number | null;
  expiresAt: number | null;
  attempts: number;
  updatedAt: number | null;
};

function seconds(value: unknown): number | null {
  const date = rawEpochToDate(value);
  return date ? Math.floor(date.getTime() / 1000) : null;
}

function optionalInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function toBinding(row: Record<string, unknown>): BindingRow {
  return {
    id: Number(row.id),
    externalUserId: String(row.externalUserId ?? ""),
    email: row.email ? String(row.email) : null,
    localUserId: optionalInt(row.localUserId),
    createdByShop: Number(row.createdByShop) === 1,
    subscriptionId: optionalInt(row.subscriptionId),
    shopPlanId: row.shopPlanId ? String(row.shopPlanId) : null,
    status: String(row.status ?? "active"),
    activatedAt: seconds(row.activatedAt),
    stoppedAt: seconds(row.stoppedAt),
  };
}

function toOrder(row: Record<string, unknown>): OrderRow {
  return {
    id: Number(row.id),
    orderId: String(row.orderId ?? ""),
    externalUserId: String(row.externalUserId ?? ""),
    status: String(row.status ?? ""),
    kind: row.kind ? String(row.kind) : null,
    message: row.message ? String(row.message) : null,
    localUserId: optionalInt(row.localUserId),
    subscriptionId: optionalInt(row.subscriptionId),
    planId: optionalInt(row.planId),
    expiresAt: seconds(row.expiresAt),
    attempts: Number(row.attempts || 1),
    updatedAt: seconds(row.updatedAt),
  };
}

async function findBinding(externalId: string): Promise<BindingRow | null> {
  const rows = await queryRaw(`SELECT * FROM ${q("shop_sync_users")} WHERE ${q("externalUserId")} = ? LIMIT 1`, [externalId]);
  return rows[0] ? toBinding(rows[0]) : null;
}

async function findBindingByLocalUser(localUserId: number): Promise<BindingRow | null> {
  const rows = await queryRaw(`SELECT * FROM ${q("shop_sync_users")} WHERE ${q("localUserId")} = ? LIMIT 1`, [localUserId]);
  return rows[0] ? toBinding(rows[0]) : null;
}

async function findOrder(orderId: string): Promise<OrderRow | null> {
  const rows = await queryRaw(`SELECT * FROM ${q("shop_sync_orders")} WHERE ${q("orderId")} = ? LIMIT 1`, [orderId]);
  return rows[0] ? toOrder(rows[0]) : null;
}

async function updateRow(table: string, id: number, values: Record<string, string | number | null>) {
  const keys = Object.keys(values);
  if (!keys.length) return;
  await executeRaw(
    `UPDATE ${q(table)} SET ${keys.map((key) => `${q(key)} = ?`).join(", ")} WHERE ${q("id")} = ?`,
    [...keys.map((key) => values[key]), id],
  );
}

type SubscriptionState = { id: number; userId: number; planId: number; status: string; expiresAt: number | null };

async function findSubscription(id: number | null): Promise<SubscriptionState | null> {
  if (!id) return null;
  const rows = await queryRaw(
    `SELECT ${q("id")}, ${q("userId")}, ${q("planId")}, ${q("status")}, ${q("expiresAt")} FROM ${q("user_subscriptions")} WHERE ${q("id")} = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: Number(row.id), userId: Number(row.userId), planId: Number(row.planId), status: String(row.status), expiresAt: seconds(row.expiresAt) };
}

/** 还在生效的那条：没取消、没到期。到期了的不拿来续 —— 它的端口段可能已经被别人占了，按新开处理。 */
function isLive(sub: SubscriptionState | null, nowSec: number): sub is SubscriptionState {
  return !!sub && sub.status === "active" && (sub.expiresAt === null || sub.expiresAt > nowSec);
}

// ---------- 结果 ----------

export type ShopSyncResult = {
  ok: boolean;
  status: ShopSyncRecordStatus;
  kind: ShopSyncKind | null;
  duplicate: boolean;
  message: string;
  orderId: string;
  user: { id: number; created: boolean; username?: string; initialPassword?: string } | null;
  subscription: { id: number; planId: number; expiresAt: string | null } | null;
};

function resultFromOrder(order: OrderRow, duplicate: boolean): ShopSyncResult {
  const status = order.status as ShopSyncRecordStatus;
  return {
    ok: status === "applied" || status === "ignored",
    status,
    kind: (order.kind as ShopSyncKind | null) ?? null,
    duplicate,
    message: order.message || "",
    orderId: order.orderId,
    user: order.localUserId ? { id: order.localUserId, created: false } : null,
    subscription: order.subscriptionId && order.planId
      ? { id: order.subscriptionId, planId: order.planId, expiresAt: order.expiresAt ? new Date(order.expiresAt * 1000).toISOString() : null }
      : null,
  };
}

type Outcome = {
  status: ShopSyncRecordStatus;
  kind: ShopSyncKind | null;
  message: string;
  planId?: number | null;
  localUserId?: number | null;
  subscriptionId?: number | null;
  expiresAt?: number | null;
  createdUser?: { username: string; initialPassword: string };
};

// ---------- 用户 ----------

function randomPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

async function usernameTaken(username: string) {
  const rows = await queryRaw(`SELECT ${q("id")} FROM ${q("users")} WHERE LOWER(${q("username")}) = ? LIMIT 1`, [username.toLowerCase()]);
  return rows.length > 0;
}

async function pickUsername(event: NormalizedEvent) {
  const candidates: string[] = [];
  if (event.email && event.email.length <= 64) candidates.push(event.email);
  const base = `shop_${event.externalId.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 56);
  candidates.push(base);
  for (const name of candidates) {
    if (!(await usernameTaken(name))) return name;
  }
  for (let i = 0; i < 5; i += 1) {
    const name = `${base}_${crypto.randomBytes(3).toString("hex")}`;
    if (!(await usernameTaken(name))) return name;
  }
  throw new Error("找不到可用的用户名");
}

type LocalUser = { id: number; role: string };

async function usersWithEmail(email: string): Promise<LocalUser[]> {
  const rows = await queryRaw(
    `SELECT ${q("id")}, ${q("role")} FROM ${q("users")} WHERE LOWER(${q("email")}) = ? OR LOWER(${q("username")}) = ? LIMIT 3`,
    [email, email],
  );
  return rows.map((row) => ({ id: Number(row.id), role: String(row.role || "user") }));
}

type ResolvedUser = { binding: BindingRow; userId: number; created?: { username: string; initialPassword: string } } | { error: string };

/**
 * 商城用户 → NEX 用户。绑定只认商城的用户 id：
 *   · 有绑定且本地用户还在：就是他；
 *   · 没有：同邮箱的本地账号只在打开「按邮箱认领」时接管，而且不接管管理员、不接管已绑给别的商城用户的；
 *     没有同邮箱的就新建一个普通用户（随机密码，只在这一次的返回里给商城）。
 */
async function resolveLocalUser(event: NormalizedEvent, binding: BindingRow | null, config: ShopSyncConfig, nowSec: number): Promise<ResolvedUser> {
  if (binding?.localUserId) {
    const user = await getUserById(binding.localUserId);
    if (user) return { binding, userId: binding.localUserId };
  }
  let userId: number;
  let createdByShop = 0;
  let created: { username: string; initialPassword: string } | undefined;
  const sameEmail = event.email ? await usersWithEmail(event.email) : [];
  if (sameEmail.length > 1) return { error: `本地有不止一个账号用着 ${event.email}，没法确定是哪一个` };
  if (sameEmail.length === 1) {
    const existing = sameEmail[0];
    if (!config.linkExistingByEmail) {
      return { error: `本地已有同邮箱账号（#${existing.id}）。要让商城接管它，请在设置里打开「按邮箱认领已有账号」` };
    }
    if (existing.role === "admin") return { error: "同邮箱的本地账号是管理员，不能交给商城管" };
    const other = await findBindingByLocalUser(existing.id);
    if (other && other.externalUserId !== event.externalId) {
      return { error: `本地账号 #${existing.id} 已经绑给商城用户 ${other.externalUserId}` };
    }
    userId = existing.id;
  } else {
    const username = await pickUsername(event);
    const initialPassword = randomPassword();
    userId = await createUser({ username, password: initialPassword, email: event.email ?? undefined, role: "user", canAddRules: false, allowProxySubscription: false });
    createdByShop = 1;
    created = { username, initialPassword };
    console.info(`[ShopSync] created local user userId=${userId} for external=${event.externalId}`);
  }
  if (binding) {
    await updateRow("shop_sync_users", binding.id, { localUserId: userId, createdByShop, email: event.email, subscriptionId: null, updatedAt: nowSec });
    return { binding: { ...binding, localUserId: userId, createdByShop: createdByShop === 1, subscriptionId: null }, userId, created };
  }
  const id = await insertAndGetId("shop_sync_users", {
    externalUserId: event.externalId,
    email: event.email,
    localUserId: userId,
    createdByShop,
    status: "active",
    createdAt: nowSec,
    updatedAt: nowSec,
  });
  const fresh = await findBinding(event.externalId);
  return { binding: fresh ?? { id, externalUserId: event.externalId, email: event.email, localUserId: userId, createdByShop: createdByShop === 1, subscriptionId: null, shopPlanId: null, status: "active", activatedAt: null, stoppedAt: null }, userId, created };
}

// ---------- 动作 ----------

function secondsToDate(value: number | null) {
  return value === null ? null : new Date(value * 1000);
}

async function activate(event: NormalizedEvent, binding: BindingRow | null, config: ShopSyncConfig, nowSec: number): Promise<Outcome> {
  const planId = mappedPlanId(config, event.shopPlanId);
  if (!planId) {
    return { status: "unmapped", kind: null, message: `商城套餐 ${event.shopPlanId} 没有对应的 NEX 套餐，已忽略。在设置的套餐映射里补上后，商城重发这个订单就会生效` };
  }
  const ordering = decideShopEventOrdering(event.action, event.occurredAt, binding);
  if (!ordering.apply) return { status: "ignored", kind: null, message: ordering.reason, planId };
  if (typeof event.expiresAt === "number" && event.expiresAt <= nowSec) {
    return { status: "ignored", kind: null, message: "给的到期时间已经过了，没有开通", planId };
  }
  const plan = await getSubscriptionPlanById(planId);
  if (!plan) return { status: "failed", kind: null, message: `映射到的 NEX 套餐 #${planId} 不存在`, planId };

  const resolved = await resolveLocalUser(event, binding, config, nowSec);
  if ("error" in resolved) return { status: "failed", kind: null, message: resolved.error, planId };
  const { userId, created } = resolved;
  try {
    return await provision(event, { planId, plan, userId, bound: resolved.binding, created }, nowSec);
  } catch (error) {
    // 账号这次刚建好、开通却失败了（端口不够之类）：初始密码照样带回去。下次重试时账号已经在了，
    // 不会再回密码 —— 这一次不给，商城就永远拿不到。
    if (!created) throw error;
    return { status: "failed", kind: null, message: error instanceof Error ? error.message : String(error), planId, localUserId: userId, createdUser: created };
  }
}

type ProvisionTarget = {
  planId: number;
  plan: NonNullable<Awaited<ReturnType<typeof getSubscriptionPlanById>>>;
  userId: number;
  bound: BindingRow;
  created?: { username: string; initialPassword: string };
};

async function provision(event: NormalizedEvent, target: ProvisionTarget, nowSec: number): Promise<Outcome> {
  const { planId, plan, userId, bound, created } = target;
  const current = await findSubscription(bound.subscriptionId);
  const live = isLive(current, nowSec) && current.userId === userId ? current : null;
  let kind: ShopSyncKind;
  let subscriptionId: number;
  let message: string;

  if (live && live.planId === planId) {
    subscriptionId = live.id;
    if (event.expiresAt !== undefined) {
      if (live.expiresAt === event.expiresAt) {
        kind = "noop";
        message = "到期时间和商城一致，无需改动";
      } else {
        await setUserSubscriptionExpiresAt(live.id, secondsToDate(event.expiresAt));
        kind = "renewed";
        message = event.expiresAt === null ? "已改为永久" : "到期时间已按商城对齐";
      }
    } else if (live.expiresAt === null) {
      kind = "noop";
      message = "这条订阅是永久的，不用续";
    } else {
      const days = event.durationDays ?? Number(plan.durationDays || 0);
      if (days > 0) {
        await extendUserSubscription(live.id, days);
        kind = "renewed";
        message = `续期 ${days} 天`;
      } else {
        await setUserSubscriptionExpiresAt(live.id, null);
        kind = "renewed";
        message = "套餐是永久的，已改为永久";
      }
    }
  } else {
    // 新开（或换套餐）：先把新的开出来再停旧的 —— 新的开不出来（端口不够之类）时，旧的还在，用户不会两头落空。
    const overrideDays = event.expiresAt === null
      ? 0
      : typeof event.expiresAt === "number"
        ? Math.max(1, Math.ceil((event.expiresAt - nowSec) / DAY))
        : event.durationDays;
    const opened = await applySubscriptionToUser(userId, planId, "admin", null, new Date(nowSec * 1000), overrideDays);
    subscriptionId = Number(opened.subscriptionId);
    if (typeof event.expiresAt === "number") await setUserSubscriptionExpiresAt(subscriptionId, secondsToDate(event.expiresAt));
    if (live) {
      await cancelUserSubscription(live.id);
      kind = "changed";
      message = `已从 NEX 套餐 #${live.planId} 换成「${plan.name}」`;
    } else {
      kind = "opened";
      message = `已开通「${plan.name}」`;
    }
  }

  const after = await findSubscription(subscriptionId);
  await updateRow("shop_sync_users", bound.id, {
    subscriptionId,
    shopPlanId: event.shopPlanId,
    status: "active",
    activatedAt: laterClock(bound.activatedAt, event.occurredAt),
    lastOrderId: event.orderId,
    lastError: null,
    email: event.email ?? bound.email,
    updatedAt: nowSec,
  });
  console.info(`[ShopSync] ${kind} external=${event.externalId} userId=${userId} plan=${planId} subscription=${subscriptionId} order=${event.orderId}`);
  return { status: "applied", kind, message, planId, localUserId: userId, subscriptionId, expiresAt: after?.expiresAt ?? null, createdUser: created };
}

async function stop(event: NormalizedEvent, binding: BindingRow | null, nowSec: number): Promise<Outcome> {
  const ordering = decideShopEventOrdering(event.action, event.occurredAt, binding);
  if (!ordering.apply) return { status: "ignored", kind: null, message: ordering.reason, localUserId: binding?.localUserId ?? null };
  if (!binding) {
    // 还没开通过就先收到停用（乱序）：记一个只有停用时间的绑定，挡住随后迟到的、更早的开通。
    await insertAndGetId("shop_sync_users", {
      externalUserId: event.externalId,
      email: event.email,
      createdByShop: 0,
      status: "stopped",
      stoppedAt: event.occurredAt,
      lastOrderId: event.orderId,
      createdAt: nowSec,
      updatedAt: nowSec,
    });
    return { status: "applied", kind: "noop", message: "这个商城用户还没开通过，已记下停用时间：之后到的、更早的开通会被忽略" };
  }
  const current = await findSubscription(binding.subscriptionId);
  let kind: ShopSyncKind = "noop";
  let message = "没有在生效的商城订阅，记下停用时间";
  if (current && current.status !== "cancelled" && (!binding.localUserId || current.userId === binding.localUserId)) {
    await cancelUserSubscription(current.id);
    kind = "stopped";
    message = "已停用这条商城订阅";
  }
  await updateRow("shop_sync_users", binding.id, {
    status: "stopped",
    stoppedAt: laterClock(binding.stoppedAt, event.occurredAt),
    lastOrderId: event.orderId,
    lastError: null,
    updatedAt: nowSec,
  });
  console.info(`[ShopSync] ${kind} external=${event.externalId} userId=${binding.localUserId ?? "-"} subscription=${current?.id ?? "-"} order=${event.orderId}`);
  return { status: "applied", kind, message, localUserId: binding.localUserId, subscriptionId: current?.id ?? null, expiresAt: current?.expiresAt ?? null };
}

// ---------- 入口 ----------

/**
 * 事件时间线里记一句：开通 / 换套餐 / 停用记 info，失败和没映射记 warn（会照常转发到 Telegram / Webhook，
 * 运维能及时发现「商城收了钱、NEX 没开出来」）。续期和无变化不记 —— 定时脚本每小时对一遍账，记了就是刷屏。
 */
function noteOutcome(event: NormalizedEvent, outcome: Outcome) {
  const who = event.email || `商城用户 ${event.externalId}`;
  let level: "info" | "warn";
  let message: string;
  if (outcome.status === "failed" || outcome.status === "unmapped") {
    level = "warn";
    message = `商城对接没能处理 ${who} 的订单 ${event.orderId}：${outcome.message}`;
  } else if (outcome.status === "applied" && (outcome.kind === "opened" || outcome.kind === "changed" || outcome.kind === "stopped")) {
    level = "info";
    message = `商城对接为 ${who} ${outcome.message}`;
  } else {
    return;
  }
  void recordPanelEvent({
    kind: "ops.shop_sync",
    level,
    userId: outcome.localUserId ?? null,
    message,
    data: { orderId: event.orderId, externalUserId: event.externalId, action: event.action, status: outcome.status, kind: outcome.kind, planId: outcome.planId ?? null, subscriptionId: outcome.subscriptionId ?? null },
  });
}

/** 认领订单号：已有结论的直接返回；没有的插一行 processing（或把可重试的那行改回 processing）。 */
async function claimOrder(event: NormalizedEvent, nowSec: number): Promise<{ settled: ShopSyncResult } | { orderRowId: number }> {
  const existing = await findOrder(event.orderId);
  if (existing) {
    if (existing.externalUserId !== event.externalId) {
      throw new ShopSyncInputError(`订单号 ${event.orderId} 已经用在商城用户 ${existing.externalUserId} 上了，不能再给别人用`);
    }
    if (isSettledShopRecord(existing.status)) return { settled: resultFromOrder(existing, true) };
    if (existing.status === "processing" && existing.updatedAt && nowSec - existing.updatedAt < STALE_PROCESSING_SECONDS) {
      return { settled: { ...resultFromOrder(existing, true), ok: false, message: "这个订单正在处理，请稍后再发" } };
    }
    await updateRow("shop_sync_orders", existing.id, { status: "processing", attempts: existing.attempts + 1, action: event.action, updatedAt: nowSec });
    return { orderRowId: existing.id };
  }
  const id = await insertAndGetId("shop_sync_orders", {
    orderId: event.orderId,
    externalUserId: event.externalId,
    email: event.email,
    action: event.action,
    shopPlanId: event.shopPlanId || null,
    status: "processing",
    occurredAt: event.occurredAt,
    attempts: 1,
    createdAt: nowSec,
    updatedAt: nowSec,
  });
  return { orderRowId: id };
}

export async function applyShopSyncEvent(input: ShopSyncEventInput, options: { now?: number } = {}): Promise<ShopSyncResult> {
  const config = await loadShopSyncConfig();
  if (!config.enabled) throw new ShopSyncDisabledError();
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  const event = normalizeEvent(input, nowSec);
  return withKeyedTaskLock(`shop-sync:user:${event.externalId}`, async () => {
    const claimed = await claimOrder(event, nowSec);
    if ("settled" in claimed) return claimed.settled;
    const binding = await findBinding(event.externalId);
    let outcome: Outcome;
    try {
      outcome = isStopAction(event.action) ? await stop(event, binding, nowSec) : await activate(event, binding, config, nowSec);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ShopSync] failed external=${event.externalId} order=${event.orderId}: ${message}`);
      outcome = { status: "failed", kind: null, message };
    }
    await updateRow("shop_sync_orders", claimed.orderRowId, {
      status: outcome.status,
      kind: outcome.kind,
      message: outcome.message.slice(0, 1000),
      planId: outcome.planId ?? null,
      localUserId: outcome.localUserId ?? binding?.localUserId ?? null,
      subscriptionId: outcome.subscriptionId ?? null,
      expiresAt: outcome.expiresAt ?? null,
      occurredAt: event.occurredAt,
      updatedAt: nowSec,
    });
    if ((outcome.status === "failed" || outcome.status === "unmapped") && binding) {
      await updateRow("shop_sync_users", binding.id, { lastError: outcome.message.slice(0, 1000), updatedAt: nowSec });
    }
    noteOutcome(event, outcome);
    const userId = outcome.localUserId ?? null;
    return {
      ok: outcome.status === "applied" || outcome.status === "ignored",
      status: outcome.status,
      kind: outcome.kind,
      duplicate: false,
      message: outcome.message,
      orderId: event.orderId,
      user: userId
        ? outcome.createdUser
          ? { id: userId, created: true, username: outcome.createdUser.username, initialPassword: outcome.createdUser.initialPassword }
          : { id: userId, created: false }
        : null,
      subscription: outcome.subscriptionId && outcome.planId
        ? { id: outcome.subscriptionId, planId: outcome.planId, expiresAt: outcome.expiresAt ? new Date(outcome.expiresAt * 1000).toISOString() : null }
        : null,
    };
  });
}

// ---------- 设置页用 ----------

export type ShopSyncRecord = {
  id: number;
  orderId: string;
  externalUserId: string;
  email: string | null;
  action: string;
  shopPlanId: string | null;
  planId: number | null;
  status: string;
  kind: string | null;
  message: string | null;
  localUserId: number | null;
  attempts: number;
  updatedAt: Date | null;
};

export async function listShopSyncRecords(limit = 20): Promise<ShopSyncRecord[]> {
  const rows = await queryRaw(
    // LIMIT 直接拼数字（已夹在 1–100）：MySQL 的预处理语句对 LIMIT ? 传数字参数会报错。
    // 续费、停用的回调常常不带邮箱：从绑定里补上，列表里认得出是谁。
    `SELECT o.*, COALESCE(o.${q("email")}, u.${q("email")}) AS ${q("displayEmail")} FROM ${q("shop_sync_orders")} o LEFT JOIN ${q("shop_sync_users")} u ON u.${q("externalUserId")} = o.${q("externalUserId")} ORDER BY o.${q("updatedAt")} DESC, o.${q("id")} DESC LIMIT ${Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)))}`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    orderId: String(row.orderId ?? ""),
    externalUserId: String(row.externalUserId ?? ""),
    email: row.displayEmail ? String(row.displayEmail) : null,
    action: String(row.action ?? ""),
    shopPlanId: row.shopPlanId ? String(row.shopPlanId) : null,
    planId: optionalInt(row.planId),
    status: String(row.status ?? ""),
    kind: row.kind ? String(row.kind) : null,
    message: row.message ? String(row.message) : null,
    localUserId: optionalInt(row.localUserId),
    attempts: Number(row.attempts || 1),
    updatedAt: rawEpochToDate(row.updatedAt),
  }));
}

export async function shopSyncStats(): Promise<{ boundUsers: number; activeUsers: number }> {
  const rows = await queryRaw<{ n: number; active: number }>(
    `SELECT COUNT(${q("localUserId")}) AS ${q("n")}, SUM(CASE WHEN ${q("status")} = 'active' AND ${q("localUserId")} IS NOT NULL THEN 1 ELSE 0 END) AS ${q("active")} FROM ${q("shop_sync_users")}`,
  );
  return { boundUsers: Number(rows[0]?.n || 0), activeUsers: Number(rows[0]?.active || 0) };
}

/** 对接新建的账号（且还在生效）才回订阅地址用的绑定信息；认领来的老账号不回。 */
export async function shopCreatedUserId(externalId: string): Promise<number | null> {
  const binding = await findBinding(externalId);
  return binding && binding.createdByShop && binding.status === "active" ? binding.localUserId : null;
}
