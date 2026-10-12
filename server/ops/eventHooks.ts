/*
  事件时间线的「挂钩」：面板里原本就会察觉到的那些时刻（主机掉线 / 恢复、Agent 重启、
  机器重启、规则出错 / 恢复、线路切换、用户流量用完 / 到期、管理员登录与连续登录失败），
  在原来的地方加一行调用这里，记成一句人话。

  约定：
  - 这里的每个函数都**不抛错、不阻塞调用方**：返回 void，内部异步做完。事件是旁路，
    哪怕数据库写不进去，原来的通知、状态更新照常走（recordPanelEvent 自己也吞错）。
  - 调用方可能正处在数据库事务里（例如 setUserForwardAccess 在计费锁里被调用）：写事件
    走 afterDatabaseCommit，等事务提交后再写 —— 不能借事务的连接（提交后连接已经还回池里），
    回滚了也不该留下一条「已暂停」的记录。
  - 去重只做最必要的那一点（同一条规则同一个错误五分钟一条、同一个 IP 的连续失败按档记），
    别的交给调用方原有的「状态有没有变」判断。
*/
import { afterDatabaseCommit, quoteDbIdentifier, queryRaw } from "../dbRuntime";
import { describeRouteReason } from "../../shared/routeGroup";
import { formatOutageDuration } from "../../shared/opsEvents";
import { listPanelEvents, prunePanelEvents, recordPanelEvent, type PanelEventInput } from "./panelEvents";

const EVENT_RETAIN_DAYS = 90;

function warnHook(label: string, error: unknown) {
  console.warn(`[PanelEvents] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
}

/** 事务提交后再写；不在事务里就直接写。永远不抛。 */
function recordSoon(input: PanelEventInput | (() => Promise<PanelEventInput | null>)) {
  void afterDatabaseCommit(() => {
    void (async () => {
      const resolved = typeof input === "function" ? await input() : input;
      if (resolved) await recordPanelEvent(resolved);
    })().catch((error) => warnHook("record", error));
  }).catch((error) => warnHook("schedule", error));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function epochSecondsOf(value: unknown): number {
  if (!value) return 0;
  const n = value instanceof Date ? value.getTime() : typeof value === "number" ? (value > 10_000_000_000 ? value : value * 1000) : new Date(String(value)).getTime();
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : 0;
}

function shortName(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, 60);
}

function hostLabel(host: any) {
  return shortName(host?.name, `主机 #${Number(host?.id) || "?"}`);
}

/** 有界 Map：超过上限时先丢最早写入的那些，避免长时间运行后无限增长。 */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max = 5_000) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// ---------------- 主机上下线 ----------------

/** 这台机器最近一次「掉线」事件还没有配对的「恢复」吗？有就返回那条事件的时间和掉线起点。 */
async function openOutageFor(hostId: number): Promise<{ since: number } | null> {
  const q = quoteDbIdentifier;
  const rows = await queryRaw<any>(
    `SELECT ${q("kind")}, ${q("createdAt")}, ${q("dataJson")} FROM ${q("panel_events")}
      WHERE ${q("hostId")} = ? AND ${q("kind")} IN ('host.offline', 'host.online')
      ORDER BY ${q("id")} DESC LIMIT 1`,
    [hostId],
  );
  const row = rows[0];
  if (!row || String(row.kind) !== "host.offline") return null;
  let since = epochSecondsOf(Number(row.createdAt));
  try {
    const data = row.dataJson ? JSON.parse(String(row.dataJson)) : null;
    const lastSeen = Number(data?.lastSeenAt || 0);
    if (lastSeen > 0 && lastSeen <= since) since = lastSeen;
  } catch {
    // dataJson 坏了就用事件时间
  }
  return since > 0 ? { since } : null;
}

/**
 * 主机上线 / 掉线（hostStatusNotifier 判定「这次状态真的变了、该通知」时调用，与 Telegram
 * 是否开启无关）。掉线记下最后一次心跳的时间；恢复时找上一条没配对的掉线，算出断了多久。
 */
export function recordHostStatusEvent(host: any, status: "online" | "offline") {
  const hostId = Number(host?.id || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return;
  const name = hostLabel(host);
  if (status === "offline") {
    const lastSeenAt = epochSecondsOf(host?.lastHeartbeat);
    recordSoon({
      kind: "host.offline",
      level: "warn",
      hostId,
      message: `${name} 断线`,
      data: lastSeenAt > 0 ? { lastSeenAt } : null,
    });
    return;
  }
  recordSoon(async () => {
    const open = await openOutageFor(hostId).catch(() => null);
    if (!open) return { kind: "host.online", level: "info", hostId, message: `${name} 上线` };
    const outageSeconds = Math.max(0, nowSeconds() - open.since);
    return {
      kind: "host.online",
      level: "info",
      hostId,
      message: `${name} 断线 ${formatOutageDuration(outageSeconds)}后恢复`,
      data: { outageSeconds, offlineSince: open.since },
    };
  });
}

// ---------------- Agent 重启 / 机器重启 ----------------

/**
 * 心跳里发现 boot_id 变了（机器重启）或 Agent 进程号 / 启动时间变了（Agent 重启）。
 * 升级 Agent 也会让进程重启，那种情况说成「升级到 x 并重启」。
 */
export function recordHostRestartEvent(host: any, info: { reboot: boolean; processRestart: boolean; upgradedTo?: string | null }) {
  const hostId = Number(host?.id || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return;
  if (!info.reboot && !info.processRestart) return;
  const name = hostLabel(host);
  if (info.reboot) {
    recordSoon({ kind: "host.rebooted", level: "warn", hostId, message: `${name} 机器重启了` });
    return;
  }
  const version = String(info.upgradedTo || "").trim().slice(0, 32);
  recordSoon({
    kind: "host.agent_restarted",
    level: "info",
    hostId,
    message: version ? `${name} 的 Agent 升级到 ${version} 并重启` : `${name} 的 Agent 重启了`,
    data: version ? { agentVersion: version } : null,
  });
}

// ---------------- 规则出错 / 恢复 ----------------

const RULE_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
/** ruleId → 最近一次记「出错」的时间和原因。在这里的规则恢复时才记「恢复」。 */
const erroredRules = new Map<number, { at: number; message: string }>();

function ruleLabel(rule: any) {
  return `「${shortName(rule?.name, `#${Number(rule?.id) || "?"}`)}」`;
}

/**
 * Agent 上报一条规则的运行状态之后调用（agentStatusRoutes）。
 *
 * - 出错：原来在跑、现在停了，或者带着错误信息。同一条规则同一个原因五分钟内只记一次 ——
 *   出错的规则每个心跳都会带着同一句错误再报一遍。
 * - 恢复：之前在这里记过出错，这次报告在跑。面板重启后这份记忆没了，那次恢复就不记（不会误报）。
 */
export function recordRuleStatusEvent(input: { rule: any; host: any; wasRunning: boolean; isRunning: boolean; message?: string | null }) {
  const rule = input.rule;
  const ruleId = Number(rule?.id || 0);
  if (!ruleId || !rule?.isEnabled || rule?.pendingDelete) return;
  const hostId = Number(input.host?.id || rule?.hostId || 0) || null;
  const userId = Number(rule?.userId || 0) || null;
  const where = `${hostLabel(input.host)}${Number(rule?.sourcePort) > 0 ? ` :${Number(rule.sourcePort)}` : ""}`;
  if (input.isRunning) {
    if (!erroredRules.has(ruleId)) return;
    erroredRules.delete(ruleId);
    recordSoon({ kind: "rule.recovered", level: "info", hostId, userId, ruleId, message: `规则${ruleLabel(rule)}（${where}）恢复运行` });
    return;
  }
  const reason = String(input.message || "").trim().replace(/\s+/g, " ").slice(0, 200);
  if (!input.wasRunning && !reason) return;
  const previous = erroredRules.get(ruleId);
  const now = Date.now();
  if (previous && previous.message === reason && now - previous.at < RULE_ERROR_COOLDOWN_MS) return;
  boundedSet(erroredRules, ruleId, { at: now, message: reason });
  recordSoon({
    kind: "rule.error",
    level: "warn",
    hostId,
    userId,
    ruleId,
    message: `规则${ruleLabel(rule)}（${where}）出错${reason ? `：${reason}` : "，已停止运行"}`,
  });
}

// ---------------- 线路切换 ----------------

const ROUTE_SWITCH_COOLDOWN_MS = 30 * 1000;
const lastRouteSwitchAt = new Map<string, number>();

/** 规则级线路组（主备 / 时段表 / 评分）切了线，或者计划里的切换因为预检没过而没切。 */
export function recordRouteSwitchEvent(input: {
  rule: any;
  hostId?: number | null;
  kind: string;
  fromLabel?: string | null;
  toLabel?: string | null;
  reason?: string | null;
}) {
  const ruleId = Number(input.rule?.id || 0);
  if (!ruleId || (input.kind !== "switch" && input.kind !== "precheck_failed")) return;
  const key = `${ruleId}:${input.kind}`;
  const now = Date.now();
  if (now - (lastRouteSwitchAt.get(key) || 0) < ROUTE_SWITCH_COOLDOWN_MS) return;
  boundedSet(lastRouteSwitchAt, key, now);
  const from = shortName(input.fromLabel, "原线路");
  const to = shortName(input.toLabel, "另一条线路");
  const reason = describeRouteReason(input.reason);
  const base = {
    hostId: Number(input.hostId || input.rule?.hostId || 0) || null,
    userId: Number(input.rule?.userId || 0) || null,
    ruleId,
    data: { from: input.fromLabel || null, to: input.toLabel || null, reason: input.reason || null },
  };
  if (input.kind === "precheck_failed") {
    recordSoon({ ...base, kind: "route.precheck_failed", level: "warn", message: `规则${ruleLabel(input.rule)}计划切到 ${to}，预检没过，继续走 ${from}` });
    return;
  }
  recordSoon({ ...base, kind: "route.switched", level: "info", message: `规则${ruleLabel(input.rule)}从 ${from} 切到 ${to}${reason ? `（${reason}）` : ""}` });
}

/** 转发组 / 入口组（DNS 那套）自动切换。 */
export function recordForwardGroupSwitchEvent(input: {
  group: any;
  mode: "failover" | "entry";
  fromLabel?: string | null;
  toLabel?: string | null;
  reason?: string | null;
}) {
  const groupId = Number(input.group?.id || 0);
  if (!groupId) return;
  const name = `「${shortName(input.group?.name, `#${groupId}`)}」`;
  const reason = String(input.reason || "").trim().slice(0, 120);
  const message = input.mode === "entry"
    ? `入口组${name}的解析变成 ${shortName(input.toLabel, "新的入口集合")}${reason ? `（${reason}）` : ""}`
    : `转发组${name}从 ${shortName(input.fromLabel, "原成员")} 切到 ${shortName(input.toLabel, "新成员")}${reason ? `（${reason}）` : ""}`;
  recordSoon({
    kind: "route.group_switched",
    level: "info",
    userId: Number(input.group?.userId || 0) || null,
    message,
    data: { forwardGroupId: groupId, mode: input.mode },
  });
}

// ---------------- 用户流量 / 到期 ----------------

async function userDisplayName(userId: number) {
  const { getUserDisplayNamesByIds } = await import("../repositories/userRepository");
  const names = await getUserDisplayNamesByIds([userId]).catch(() => new Map<number, string>());
  return names.get(userId) || `#${userId}`;
}

/**
 * setUserForwardAccess 真的暂停了一个用户（权限或暂停原因变了）时调用。
 * 只记流量用完和到期两种自动暂停；管理员手动暂停在操作审计里有。
 */
export function recordUserAccessPausedEvent(userId: number, reason: string | null | undefined) {
  const id = Number(userId || 0);
  if (!id || (reason !== "traffic_limit" && reason !== "expired")) return;
  recordSoon(async () => {
    const name = await userDisplayName(id);
    return reason === "traffic_limit"
      ? { kind: "user.quota_exhausted", level: "warn", userId: id, message: `用户 ${name} 流量用完，转发已暂停` }
      : { kind: "user.expired", level: "warn", userId: id, message: `用户 ${name} 已到期，转发已暂停` };
  });
}

/**
 * 每天一次：三天内到期的用户各记一条「快到期」。同一个人 20 小时内记过就不再记
 * （面板重启后这一轮会再跑一次，不能重复）。
 */
export async function recordExpiringUsersEvents(now = Date.now()) {
  const q = quoteDbIdentifier;
  const nowSec = Math.floor(now / 1000);
  const horizon = nowSec + 3 * 86400;
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("username")}, ${q("name")}, ${q("expiresAt")} FROM ${q("users")}
      WHERE ${q("expiresAt")} IS NOT NULL AND ${q("expiresAt")} > ? AND ${q("expiresAt")} <= ?
        AND ${q("role")} <> 'admin'`,
    [nowSec, horizon],
  );
  if (rows.length === 0) return 0;
  const recent = await listPanelEvents({ kindPrefix: "user.expiring", sinceSeconds: nowSec - 20 * 3600, limit: 500 });
  const done = new Set(recent.map((event) => event.userId).filter(Boolean));
  let recorded = 0;
  for (const row of rows) {
    const userId = Number(row.id);
    if (done.has(userId)) continue;
    const expiresAt = epochSecondsOf(Number(row.expiresAt));
    const days = Math.max(0, Math.ceil((expiresAt - nowSec) / 86400));
    const name = shortName(row.name || row.username, `#${userId}`);
    await recordPanelEvent({
      kind: "user.expiring",
      level: "info",
      userId,
      message: days <= 1 ? `用户 ${name} 将在 24 小时内到期` : `用户 ${name} 将在 ${days} 天后到期`,
      data: { expiresAt },
    });
    recorded += 1;
  }
  return recorded;
}

// ---------------- 登录 ----------------

/** 管理员登录成功（普通用户登录太多，不记）。 */
export function recordLoginSuccessEvent(user: any, ip: string) {
  if (String(user?.role || "") !== "admin") return;
  const userId = Number(user?.id || 0) || null;
  const name = shortName(user?.name || user?.username, `#${userId || "?"}`);
  recordSoon({ kind: "account.login", level: "info", userId, message: `管理员 ${name} 登录（${String(ip || "未知 IP").slice(0, 64)}）`, data: { ip } });
}

const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
/** 同一个 IP 连续失败到这几次时各记一条；一两次输错密码不值得进时间线。 */
const LOGIN_FAIL_THRESHOLDS = new Set([5, 20, 100]);
const loginFailures = new Map<string, { count: number; firstAt: number; lastAt: number }>();

function maskUsername(value: string) {
  const text = String(value || "").trim().slice(0, 64);
  if (text.length <= 2) return text ? `${text[0]}*` : "-";
  return `${text.slice(0, 2)}${"*".repeat(Math.min(4, text.length - 2))}`;
}

/** 一次登录失败（密码错、两步验证码错）。返回这次有没有记事件（测试用）。 */
export function recordLoginFailureEvent(ip: string, username: string, now = Date.now()) {
  const key = String(ip || "unknown").slice(0, 64);
  const current = loginFailures.get(key);
  const entry = current && now - current.lastAt < LOGIN_FAIL_WINDOW_MS
    ? { count: current.count + 1, firstAt: current.firstAt, lastAt: now }
    : { count: 1, firstAt: now, lastAt: now };
  boundedSet(loginFailures, key, entry, 2_000);
  if (!LOGIN_FAIL_THRESHOLDS.has(entry.count)) return false;
  const minutes = Math.max(1, Math.round((now - entry.firstAt) / 60_000));
  recordSoon({
    kind: "account.login_failed",
    level: "warn",
    message: `${key} 在 ${minutes} 分钟内登录失败 ${entry.count} 次（最近尝试的账号：${maskUsername(username)}）`,
    data: { ip: key, count: entry.count },
  });
  return true;
}

/** 测试用。 */
export function resetEventHookMemory() {
  erroredRules.clear();
  lastRouteSwitchAt.clear();
  loginFailures.clear();
}

// ---------------- 每天一次的维护 ----------------

/** 调度器每天跑一次：删掉 90 天前的事件，再记一遍「快到期」的用户。 */
export async function runPanelEventsDailyMaintenance() {
  try {
    const pruned = await prunePanelEvents(EVENT_RETAIN_DAYS);
    if (pruned > 0) console.log(`[PanelEvents] Pruned ${pruned} event(s) older than ${EVENT_RETAIN_DAYS} days`);
  } catch (error) {
    warnHook("prune", error);
  }
  try {
    await recordExpiringUsersEvents();
  } catch (error) {
    warnHook("expiring scan", error);
  }
}
