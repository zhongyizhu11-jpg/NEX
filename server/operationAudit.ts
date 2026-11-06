import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { clientIp } from "./clientIp";
import { afterDatabaseCommit, insertAndGetId, isDatabaseTransactionActive, queryRaw, quoteDbIdentifier, rawEpochToDate } from "./dbRuntime";
import { deleteExpiredHistoryRows } from "./repositories/historyRetention";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import {
  normalizeOperationAuditRetentionDays,
  operationAuditModule,
  serializeAuditInput,
  type OperationAuditChannel,
  type OperationAuditResult,
} from "../shared/operationAudit";

/*
  操作审计：登录用户的每一次写操作（tRPC mutation）记一行，谁、何时、从哪个入口、哪个 IP、调了哪个过程、
  参数（打过码，见 shared/operationAudit.ts）、成没成、花了多久。

  入口是 server/_core/trpc.ts 的 recordOperationAudit 中间件 —— 网页、API 令牌、MCP（appRouter.createCaller）、
  Telegram 机器人走的都是同一套过程，所以一个中间件全盖住，不用在三百个过程里一个个补。

  ── 和配置审计的关系 ──
  规则 / 主机 / 隧道 / 转发组的仓库层另记一份带 before / after 的 config_audit_events。这里给每次调用
  生成一个 requestId 放进 AsyncLocalStorage，runWithConfigAuditContext 优先用它，两边的行就用同一个
  requestId 串起来：列表里只有这一行，点开详情再把那几条字段差异一起列出来。

  ── 不记的 ──
  · 没登录的（登录、注册、验证码这些本身就是匿名调用；过期会话的 UNAUTHORIZED 也不记，免得刷屏）；
  · OPERATION_AUDIT_SKIPPED_PATHS 里的：只是发起一次测速 / 诊断 / 检查、轮询登录状态、算个预览，
    不改任何东西；
  · 嵌套调用：一个过程里再用 createCaller 调另一个 mutation（诊断面板、主机运维、异地备份恢复），
    外层已经在记，内层不再单独记一行。

  写库不阻塞请求：过程返回后才排队写，写失败只打一条 warn —— 审计挂了不能让用户的保存失败。
*/

/*
  active：这次写操作还没返回。过程里顺手拉起的后台循环（保存设置时拉起的 Telegram 轮询、定时器）会一直
  带着这个 store；返回时置成 false，它们以后再调的写操作就各记各的一行，也不会冒用这次的 requestId。
*/
type OperationAuditStore = { requestId: string; active: boolean };

const operationAuditStorage = new AsyncLocalStorage<OperationAuditStore>();

/** 当前这次写操作的 requestId（不在审计范围里时是 undefined）。configAudit.ts 用它串起两边的记录。 */
export function currentOperationAuditRequestId(): string | undefined {
  const store = operationAuditStorage.getStore();
  return store?.active ? store.requestId : undefined;
}

/*
  不记的写操作。都是「不改任何状态」或「登录流程的一步」：
    · 登录 / 注册 / 验证码 / 第三方登录的发起和轮询 —— 登录本身另有登录记录（由账号安全那边负责）；
    · 安装向导 setup.* —— 装好前没有用户，装好后整个路由锁死；
    · 发起一次测速、诊断、连通性检查、测试发送 —— 只读地「跑一下看看」，结果在各自的页面里；
    · 预览 / 解析 / 盯着看（watchMetrics、onlineIps.watch 每几秒续一次）、已读、用量上报。
  过程改名或删掉时 operationAudit.sqlite.test.ts 会报出这里的旧名字。
*/
export const OPERATION_AUDIT_SKIPPED_PATHS: ReadonlySet<string> = new Set([
  // 登录流程
  "auth.createCaptcha", "auth.sendEmailCode", "auth.login", "auth.verifyTwoFactorLogin", "auth.register",
  "telegram.startMobileLogin", "telegram.mobileLoginStatus", "telegram.login", "telegram.loginWithWidget", "telegram.loginWithWebApp",
  "ops.passkeys.loginOptions", "ops.passkeys.finishLogin", "ops.passkeys.registrationOptions",
  "googleAuth.appStart", "googleAuth.appStatus", "googleAuth.appCancel",
  "discordAuth.appStart", "discordAuth.appStatus", "discordAuth.appCancel",
  // 安装向导
  "setup.testDatabase", "setup.saveDatabase", "setup.testMysql", "setup.saveMysql", "setup.startMigration",
  "setup.useExistingData", "setup.resetExistingData", "setup.createAdmin", "setup.updateAdmin",
  // 只跑一下看看：测速、诊断、检测、测试发送
  "diagnostics.start", "diagnostics.latencyStart", "diagnostics.speedStart",
  "lookingGlass.start", "lookingGlass.pairSpeedStart", "lookingGlass.iperf3Start", "lookingGlass.iperf3Stop",
  "lineDiagnostics.segmentSpeedStart", "lineDiagnostics.segmentLatencyStart",
  "rules.startSelfTest", "rules.connectionsStart", "tunnels.test", "forwardGroups.test",
  "hosts.startSpeedTest", "hosts.startUnlockCheck", "netProfile.recheck", "proxySubscriptions.nodeExitCheckStart",
  "ipChange.accounts.test", "ops.webhooks.test", "ops.resourceAlert.test", "ops.digest.sendTest",
  "ops.offsiteBackup.testConnection", "telegram.testSend", "system.sendTestEmail", "discordAuth.testBot",
  "payment.testGmPayGateway", "system.testDatabaseSwitchTarget",
  "plugins.checkUpdate", "plugins.checkUpdates", "plugins.refreshStore", "plugins.refreshStoreSource",
  // 预览、解析、盯着看、已读、用量
  "billing.previewDiscount", "proxySubscriptions.parseLink", "lineDiagnostics.nodePoolSuggestDomain", "nodePools.suggestDomain",
  "hosts.watchMetrics", "ops.onlineIps.watch", "announcements.dismiss", "plugins.saveUsage",
  "ops.faultBoard.export", "ops.connStats.export",
]);

export function shouldSkipOperationAudit(path: string): boolean {
  return OPERATION_AUDIT_SKIPPED_PATHS.has(String(path || ""));
}

/** 用到的那几样请求字段（Express 的 Request 结构上兼容；Telegram / MCP 的上下文是拼出来的同形对象）。 */
type AuditRequest = {
  ip?: string | null;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
};

type AuditCtx = {
  req?: AuditRequest | null;
  user?: { id?: unknown; username?: unknown; name?: unknown; role?: unknown } | null;
  apiToken?: { id?: unknown; name?: unknown } | null;
};

/** 这次调用从哪儿来。MCP 也带令牌，按请求路径分开；Telegram 机器人的上下文 IP 写的是 "telegram"。 */
export function operationAuditChannel(ctx: AuditCtx): OperationAuditChannel {
  const req: AuditRequest = ctx.req || {};
  const url = String(req.originalUrl || req.url || "");
  if (ctx.apiToken) return /(^|\/)mcp(\/|$|\?)/.test(url) ? "mcp" : "api";
  if (req.ip === "telegram") return "telegram";
  if (!req.headers && !req.socket) return "internal";
  return "web";
}

/** tRPC 错误码 → 审计结果。权限类是「被拒绝」，其余（参数不对、找不到、内部错误）是「失败」。 */
export function operationAuditResultOf(ok: boolean, code?: string | null): OperationAuditResult {
  if (ok) return "ok";
  return code === "FORBIDDEN" || code === "UNAUTHORIZED" || code === "TOO_MANY_REQUESTS" ? "denied" : "error";
}

export type OperationAuditRow = {
  actorUserId: number | null;
  actorName: string | null;
  actorRole: string | null;
  apiTokenId: number | null;
  apiTokenName: string | null;
  channel: OperationAuditChannel;
  path: string;
  module: string;
  result: OperationAuditResult;
  errorCode: string | null;
  errorMessage: string | null;
  inputJson: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  durationMs: number;
  createdAt: number;
};

const pendingWrites = new Set<Promise<unknown>>();

/** 测试用：等排队中的审计写完。 */
export async function drainOperationAuditWrites() {
  while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites]);
}

function positiveId(value: unknown): number | null {
  const id = Math.floor(Number(value));
  return Number.isFinite(id) && id > 0 ? id : null;
}

function clip(value: unknown, max: number): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

export async function insertOperationAuditRow(row: OperationAuditRow) {
  try {
    return await insertAndGetId("operation_audit_events", row);
  } catch (error) {
    console.warn(`[OperationAudit] write failed path=${row.path}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

function queueWrite(row: OperationAuditRow) {
  const run = async () => {
    // 正处在某个事务里（极少：外层不是 mutation、里面又开了事务调 mutation）就等提交以后再写，
    // 和 configAudit 一样，审计这条语句失败不能把用户的事务带着一起作废。
    if (isDatabaseTransactionActive()) {
      await afterDatabaseCommit(async () => { await insertOperationAuditRow(row); });
      return;
    }
    await insertOperationAuditRow(row);
  };
  const promise = run().catch(() => undefined).finally(() => pendingWrites.delete(promise));
  pendingWrites.add(promise);
}

type MiddlewareResultLike = { ok: boolean; error?: { code?: string; message?: string } };

/**
 * 中间件主体：包住一次 mutation。返回 next() 的结果，原样交回 tRPC。
 * 不在审计范围里（不是 mutation、没登录、跳过名单、嵌套调用）时直接放行，什么也不记。
 */
export async function auditMutationCall<R extends MiddlewareResultLike>(opts: {
  type: string;
  path: string;
  ctx: AuditCtx;
  getRawInput: () => Promise<unknown>;
  next: () => Promise<R>;
  now?: () => number;
}): Promise<R> {
  const { ctx, path } = opts;
  const actorId = positiveId(ctx.user?.id);
  if (opts.type !== "mutation" || shouldSkipOperationAudit(path) || (!actorId && !ctx.apiToken) || operationAuditStorage.getStore()?.active) {
    return opts.next();
  }
  const now = opts.now || Date.now;
  const started = now();
  const store: OperationAuditStore = { requestId: randomUUID(), active: true };
  let result: R;
  try {
    result = await operationAuditStorage.run(store, () => opts.next());
  } finally {
    store.active = false;
  }
  let rawInput: unknown;
  try {
    rawInput = await opts.getRawInput();
  } catch {
    rawInput = undefined;
  }
  const req: AuditRequest = ctx.req || {};
  const code = result.ok ? null : String(result.error?.code || "INTERNAL_SERVER_ERROR");
  queueWrite({
    actorUserId: actorId,
    actorName: clip(ctx.user?.username || ctx.user?.name, 128),
    actorRole: clip(ctx.user?.role, 16),
    apiTokenId: positiveId(ctx.apiToken?.id),
    apiTokenName: clip(ctx.apiToken?.name, 64),
    channel: operationAuditChannel(ctx),
    path: String(path).slice(0, 128),
    module: operationAuditModule(path).slice(0, 96),
    result: operationAuditResultOf(result.ok, code),
    errorCode: code ? code.slice(0, 32) : null,
    errorMessage: result.ok ? null : clip(result.error?.message, 300),
    inputJson: serializeAuditInput(rawInput),
    ip: clip(req.ip === "telegram" ? "" : clientIp(req), 64),
    userAgent: clip(req.headers?.["user-agent"], 256),
    requestId: store.requestId,
    durationMs: Math.max(0, Math.round(now() - started)),
    createdAt: Math.floor(started / 1000),
  });
  return result;
}

// ── 保留天数 ────────────────────────────────────────────────────────────

export const OPERATION_AUDIT_RETENTION_SETTING = "operationAuditRetentionDays";

export async function getOperationAuditRetentionDays() {
  return normalizeOperationAuditRetentionDays(await getSetting(OPERATION_AUDIT_RETENTION_SETTING).catch(() => null));
}

export async function setOperationAuditRetentionDays(days: number) {
  const value = normalizeOperationAuditRetentionDays(days);
  await setSetting(OPERATION_AUDIT_RETENTION_SETTING, String(value));
  return value;
}

/** 删掉保留期以前的审计行（调度器每天的历史清理里跑）。 */
export async function pruneOperationAuditEvents(nowMs = Date.now()) {
  const days = await getOperationAuditRetentionDays();
  const cutoff = Math.floor(nowMs / 1000) - days * 86400;
  return deleteExpiredHistoryRows("operation_audit_events", "createdAt", cutoff);
}

// ── 查询 ──────────────────────────────────────────────────────────────

/** 列表上的一行：不带参数（inputJson 最长 4 KB，列表用不到，点开详情再读）。 */
export type OperationAuditListItem = Omit<OperationAuditRow, "createdAt" | "inputJson"> & {
  id: number;
  createdAt: Date;
};

export type OperationAuditEvent = OperationAuditListItem & { input: unknown };

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return String(value);
  }
}

type DbRow = Record<string, unknown>;

/** 库里可空的文本列读回来：null / 空串都当没有。 */
function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function rowToListItem(row: DbRow): OperationAuditListItem {
  return {
    id: Number(row.id),
    actorUserId: positiveId(row.actorUserId),
    actorName: nullableText(row.actorName),
    actorRole: nullableText(row.actorRole),
    apiTokenId: positiveId(row.apiTokenId),
    apiTokenName: nullableText(row.apiTokenName),
    channel: (row.channel || "web") as OperationAuditChannel,
    path: String(row.path || ""),
    module: String(row.module || ""),
    result: (row.result || "ok") as OperationAuditResult,
    errorCode: nullableText(row.errorCode),
    errorMessage: nullableText(row.errorMessage),
    ip: nullableText(row.ip),
    userAgent: nullableText(row.userAgent),
    requestId: String(row.requestId || ""),
    durationMs: Number(row.durationMs) || 0,
    createdAt: rawEpochToDate(row.createdAt) || new Date(0),
  };
}

function rowToEvent(row: DbRow): OperationAuditEvent {
  return { ...rowToListItem(row), input: parseJson(row.inputJson) };
}

const LIST_COLUMNS = [
  "id", "actorUserId", "actorName", "actorRole", "apiTokenId", "apiTokenName", "channel", "path", "module",
  "result", "errorCode", "errorMessage", "ip", "userAgent", "requestId", "durationMs", "createdAt",
] as const;

export type ListOperationAuditInput = {
  beforeId?: number | null;
  limit?: number;
  actorUserId?: number | null;
  module?: string | null;
  result?: OperationAuditResult | null;
  sinceSeconds?: number | null;
  untilSeconds?: number | null;
  search?: string | null;
};

/** LIKE 里的 % _ 当普通字符：转义符用 !，三种库的 ESCAPE 都认（反斜杠在 MySQL 字符串里本身就是转义符，不能用）。 */
function escapeLike(value: string) {
  return value.replace(/[!%_]/g, (char) => `!${char}`);
}

export async function listOperationAuditEvents(input: ListOperationAuditInput = {}): Promise<OperationAuditListItem[]> {
  const limit = Math.min(201, Math.max(1, Math.floor(Number(input.limit) || 50)));
  const q = quoteDbIdentifier;
  const where: string[] = [];
  const params: unknown[] = [];
  const beforeId = positiveId(input.beforeId);
  if (beforeId) { where.push(`${q("id")} < ?`); params.push(beforeId); }
  const actorUserId = positiveId(input.actorUserId);
  if (actorUserId) { where.push(`${q("actorUserId")} = ?`); params.push(actorUserId); }
  if (input.module) { where.push(`${q("module")} = ?`); params.push(String(input.module).slice(0, 96)); }
  if (input.result) { where.push(`${q("result")} = ?`); params.push(input.result); }
  if (Number(input.sinceSeconds) > 0) { where.push(`${q("createdAt")} >= ?`); params.push(Math.floor(Number(input.sinceSeconds))); }
  if (Number(input.untilSeconds) > 0) { where.push(`${q("createdAt")} < ?`); params.push(Math.floor(Number(input.untilSeconds))); }
  const search = String(input.search || "").trim().slice(0, 64);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    const fields = ["path", "actorName", "ip", "inputJson", "errorMessage", "apiTokenName"];
    where.push(`(${fields.map((field) => `${q(field)} LIKE ? ESCAPE '!'`).join(" OR ")})`);
    for (let index = 0; index < fields.length; index += 1) params.push(pattern);
  }
  const columns = LIST_COLUMNS.map((column) => q(column)).join(", ");
  const sql = `SELECT ${columns} FROM ${q("operation_audit_events")}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${q("id")} DESC LIMIT ${limit}`;
  const rows = await queryRaw<DbRow>(sql, params);
  return rows.map(rowToListItem);
}

export async function getOperationAuditEvent(id: number): Promise<OperationAuditEvent | null> {
  const q = quoteDbIdentifier;
  const rows = await queryRaw<DbRow>(`SELECT * FROM ${q("operation_audit_events")} WHERE ${q("id")} = ? LIMIT 1`, [id]);
  return rows[0] ? rowToEvent(rows[0]) : null;
}

export type LinkedConfigChange = {
  id: number;
  resourceType: string;
  resourceId: number;
  action: string;
  diff: unknown;
  createdAt: Date;
};

/**
 * 同一次请求在配置审计里留下的字段差异（规则 / 主机 / 隧道 / 转发组）。按 (actorUserId, id) 索引找，
 * requestId 再筛一遍；dispatch（下发给 Agent 的期望状态）不是用户改的，不列。
 */
export async function getLinkedConfigChanges(event: Pick<OperationAuditEvent, "actorUserId" | "requestId">): Promise<LinkedConfigChange[]> {
  if (!event.actorUserId || !event.requestId) return [];
  const q = quoteDbIdentifier;
  const rows = await queryRaw<DbRow>(
    `SELECT ${q("id")}, ${q("resourceType")}, ${q("resourceId")}, ${q("action")}, ${q("diffJson")}, ${q("createdAt")} FROM ${q("config_audit_events")}`
    + ` WHERE ${q("actorUserId")} = ? AND ${q("requestId")} = ? AND ${q("action")} <> ? ORDER BY ${q("id")} ASC LIMIT 20`,
    [event.actorUserId, event.requestId, "dispatch"],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    resourceType: String(row.resourceType || ""),
    resourceId: Number(row.resourceId) || 0,
    action: String(row.action || ""),
    diff: parseJson(row.diffJson),
    createdAt: rawEpochToDate(row.createdAt) || new Date(0),
  }));
}

export type OperationAuditFacets = {
  modules: Array<{ module: string; count: number }>;
  actors: Array<{ userId: number; name: string; count: number }>;
};

/** 筛选下拉的候选：出现过的模块、出现过的操作人（都按索引分组，量是保留期内的审计行数）。 */
export async function getOperationAuditFacets(): Promise<OperationAuditFacets> {
  const q = quoteDbIdentifier;
  const [modules, actors] = await Promise.all([
    queryRaw<DbRow>(`SELECT ${q("module")} AS m, COUNT(*) AS n FROM ${q("operation_audit_events")} GROUP BY ${q("module")} ORDER BY n DESC LIMIT 100`),
    queryRaw<DbRow>(`SELECT ${q("actorUserId")} AS u, MAX(${q("actorName")}) AS name, COUNT(*) AS n FROM ${q("operation_audit_events")} WHERE ${q("actorUserId")} IS NOT NULL GROUP BY ${q("actorUserId")} ORDER BY n DESC LIMIT 200`),
  ]);
  return {
    modules: modules.map((row) => ({ module: String(row.m || ""), count: Number(row.n) || 0 })).filter((row) => row.module),
    actors: actors.map((row) => ({ userId: Number(row.u) || 0, name: String(row.name || `#${row.u}`), count: Number(row.n) || 0 })).filter((row) => row.userId > 0),
  };
}
