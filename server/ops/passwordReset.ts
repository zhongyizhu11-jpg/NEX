/*
  登录页「忘记密码」（上游 v2.3.299：通过已验证邮箱或已绑定 Telegram 获取一次性密码重置链接，
  未配置找回方式时需联系管理员）。

  ── 申请 ──
  登录页填用户名或邮箱。回给页面的永远是同一句话（PASSWORD_RESET_REQUESTED_MESSAGE），
  账号存不存在、停没停用、绑没绑找回方式、是不是刚申请过，从响应里一概看不出来：
  查账号、发链接都放在响应之后做（schedule），连耗时都不带账号的信息。
  发到哪：这个账号「已验证的邮箱」+「已绑定的 Telegram」+「已绑定的 Discord」，有哪个发哪个，
  不让申请的人选 —— 也不告诉他发到了哪。

  ── 令牌 ──
  `nxr_` + 32 字节随机数，库里只存 sha256（password_reset_tokens，见 passwordResetTables.ts），
  30 分钟过期，绑定一个用户，只能用一次；再申请一次，之前没用掉的全部作废。
  链接用设置里的「面板公开访问地址」拼，没配就不发 —— 绝不拿请求的 Host 头拼：
  那是申请的人自己能填的，等于让他把别人的重置链接指到自己的域名上。
  令牌放在 # 后面，不进访问日志和 Referer。

  ── 重置 ──
  新密码和注册、改密码同一条规则。成功后这个人的所有登录会话、API 令牌全部作废，
  双重验证和通行密钥不动（忘了密码不等于丢了第二因素；用链接重置之后登录照样要过 2FA）。
  停用的账号申请不到链接，拿着旧链接也重置不了。

  ── 限流 ──
  申请：按来源 IP（明着拒）+ 按账号（悄悄不发，不然「这个账号被限流了」就是在说它存在）。
  重置：按来源 IP。计数用 server/authRateLimit.ts 里那份通用额度；全局接口限流（apiRateLimit）照常在外面再挡一层。

  依赖都从 createPasswordResetService 注入：测试里换掉发信和时钟，库操作用真的。
*/
import crypto from "node:crypto";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawAffectedRows, rawEpochToDate, withDatabaseTransaction } from "../dbRuntime";
import { getUserById, getUserByUsername } from "../repositories/userRepository";
import { revokeUserAuthSessions } from "../repositories/sessionRepository";
import { deleteExpiredHistoryRows } from "../repositories/historyRetention";
import { getSetting } from "../repositories/settingsRepository";
import { hashPassword } from "../password";
import { attemptBudgetState, consumeAttemptBudget } from "../authRateLimit";
import { ipRateLimitScope } from "../ipRateLimitScope";
import { normalizePanelUrl } from "../agentPanelUrl";
import {
  PASSWORD_RESET_CHANNELS,
  PASSWORD_RESET_CHANNEL_LABELS,
  PASSWORD_RESET_DISABLED_MESSAGE,
  PASSWORD_RESET_HASH_PARAM,
  PASSWORD_RESET_INVALID_MESSAGE,
  PASSWORD_RESET_MAX_LENGTH,
  PASSWORD_RESET_MIN_LENGTH,
  PASSWORD_RESET_RATE_LIMITED_MESSAGE,
  PASSWORD_RESET_REQUESTED_MESSAGE,
  PASSWORD_RESET_TOKEN_PREFIX,
  PASSWORD_RESET_TTL_MINUTES,
  PASSWORD_RESET_TTL_SECONDS,
  type PasswordResetChannel,
} from "../../shared/passwordReset";

/** 系统设置里的开关：默认开，只有明确存成 "false" 才关（和 authCaptchaEnabled 一个写法）。 */
export const PASSWORD_RESET_ENABLED_SETTING = "passwordResetEnabled";

export async function isPasswordResetEnabled(): Promise<boolean> {
  return (await getSetting(PASSWORD_RESET_ENABLED_SETTING)) !== "false";
}

// 申请：同一个来源半小时 6 次；同一个账号一分钟 1 次、一小时 3 次。重置：同一个来源 15 分钟 20 次。
export const PASSWORD_RESET_REQUEST_IP_MAX = 6;
export const PASSWORD_RESET_REQUEST_IP_WINDOW_MS = 30 * 60 * 1000;
export const PASSWORD_RESET_ACCOUNT_COOLDOWN_MS = 60 * 1000;
export const PASSWORD_RESET_ACCOUNT_MAX = 3;
export const PASSWORD_RESET_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_SUBMIT_IP_MAX = 20;
export const PASSWORD_RESET_SUBMIT_IP_WINDOW_MS = 15 * 60 * 1000;

/** 给人看的错误（页面原样显示）。code 对应 tRPC 的错误码，路由里转成 TRPCError。 */
export class PasswordResetError extends Error {
  constructor(public readonly code: "BAD_REQUEST" | "FORBIDDEN" | "TOO_MANY_REQUESTS", message: string) {
    super(message);
    this.name = "PasswordResetError";
  }
}

/** 找回密码只用到用户行上的这几列。 */
export type PasswordResetAccount = {
  id: number;
  username: string;
  name?: string | null;
  role?: string | null;
  password: string;
  accountEnabled?: unknown;
  email?: string | null;
  emailVerified?: unknown;
  telegramId?: string | null;
  discordId?: string | null;
  discordDmBlockedAt?: Date | string | number | null;
};

export type PasswordResetAvailability = Record<PasswordResetChannel, boolean> & {
  /** 设置里的面板公开访问地址；空 = 没配，发不了链接。 */
  panelUrl: string;
};

const TOKEN_PATTERN = new RegExp(`^${PASSWORD_RESET_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

export function generatePasswordResetToken(): { token: string; hash: string } {
  const token = `${PASSWORD_RESET_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  return { token, hash: hashPasswordResetToken(token) };
}

export function hashPasswordResetToken(token: string) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

/**
 * 签发那一刻这个账号的密码哈希的指纹。密码一变（本人改了、管理员重置了、这条链接已经用过），
 * 或者这个 id 换了主人，所有没用掉的旧链接就都对不上了。
 */
export function passwordResetCredentialMark(user: Pick<PasswordResetAccount, "id" | "password">) {
  return crypto.createHash("sha256").update(`password-reset-v1:${user.id}:${user.password}`, "utf8").digest("hex");
}

function accountEnabled(user: Pick<PasswordResetAccount, "accountEnabled"> | null | undefined) {
  return !!user && user.accountEnabled !== false && user.accountEnabled !== 0;
}

/** 这个账号的链接能发到哪几个渠道：停用的账号一个都没有；邮箱必须是验证过的。 */
export function passwordResetDestinations(user: PasswordResetAccount, availability: Record<PasswordResetChannel, boolean>): PasswordResetChannel[] {
  if (!accountEnabled(user)) return [];
  const destinations: PasswordResetChannel[] = [];
  const email = String(user.email || "").trim();
  const verified = user.emailVerified === true || user.emailVerified === 1;
  if (availability.email && verified && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) destinations.push("email");
  if (availability.telegram && /^[1-9]\d{0,19}$/.test(String(user.telegramId || ""))) destinations.push("telegram");
  if (availability.discord && /^\d{5,32}$/.test(String(user.discordId || ""))) destinations.push("discord");
  return destinations;
}

/** 重置链接。panelUrl 只能是设置里配的公开地址（调用方保证），不是请求头里来的。 */
export function passwordResetLink(panelUrl: string, token: string) {
  const base = normalizePanelUrl(panelUrl);
  if (!base) throw new Error("找回密码需要先在系统设置里配置面板公开访问地址");
  return `${base}/login#${PASSWORD_RESET_HASH_PARAM}=${encodeURIComponent(token)}`;
}

// ---------- 库操作 ----------

/** 给这个用户签一枚新令牌；他之前没用掉的全部作废。返回明文（只此一次）。 */
export async function issuePasswordResetToken(
  user: Pick<PasswordResetAccount, "id" | "password">,
  options: { ip?: string | null; channels?: readonly PasswordResetChannel[]; now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const { token, hash } = generatePasswordResetToken();
  const q = quoteDbIdentifier;
  await withDatabaseTransaction(async () => {
    await executeRaw(
      `UPDATE ${q("password_reset_tokens")} SET ${q("invalidatedAt")} = ? WHERE ${q("userId")} = ? AND ${q("usedAt")} IS NULL AND ${q("invalidatedAt")} IS NULL`,
      [nowSeconds, user.id],
    );
    await insertAndGetId("password_reset_tokens", {
      userId: user.id,
      tokenHash: hash,
      credentialMark: passwordResetCredentialMark(user),
      channels: (options.channels || []).join(",").slice(0, 64) || null,
      requestIp: String(options.ip || "").slice(0, 64) || null,
      createdAt: nowSeconds,
      expiresAt: nowSeconds + PASSWORD_RESET_TTL_SECONDS,
    });
  });
  return token;
}

export type UsablePasswordResetToken = { id: number; userId: number; credentialMark: string; channels: PasswordResetChannel[] };

/** 令牌 → 还能用的那一行（没用过、没作废、没过期）；否则 null。 */
export async function findUsablePasswordResetToken(token: string, now = Date.now()): Promise<UsablePasswordResetToken | null> {
  if (!TOKEN_PATTERN.test(String(token || ""))) return null;
  const q = quoteDbIdentifier;
  const rows = await queryRaw(`SELECT * FROM ${q("password_reset_tokens")} WHERE ${q("tokenHash")} = ? LIMIT 1`, [hashPasswordResetToken(token)]);
  const row = rows[0];
  if (!row || rawEpochToDate(row.usedAt) || rawEpochToDate(row.invalidatedAt)) return null;
  if ((rawEpochToDate(row.expiresAt)?.getTime() || 0) <= now) return null;
  const channels = String(row.channels || "").split(",").filter((item): item is PasswordResetChannel => (PASSWORD_RESET_CHANNELS as readonly string[]).includes(item));
  return { id: Number(row.id), userId: Number(row.userId), credentialMark: String(row.credentialMark || ""), channels };
}

/** 换密码那一步发现密码已经不是签发时那个：抛它让事务回滚。 */
class PasswordResetRaceError extends Error {}

/**
 * 用掉令牌、换密码、踢掉所有登录，三件事在一个事务里：要么都成，要么都不成。
 * 两个条件更新各自只认「还没被别人抢先」的状态 —— 同一条链接并发提交两次，只有一次返回 true。
 */
export async function consumePasswordResetToken(
  tokenId: number,
  user: Pick<PasswordResetAccount, "id" | "password">,
  newPasswordHash: string,
  now = Date.now(),
): Promise<boolean> {
  const nowSeconds = Math.floor(now / 1000);
  const q = quoteDbIdentifier;
  return withDatabaseTransaction(async () => {
    const used = await executeRaw(
      `UPDATE ${q("password_reset_tokens")} SET ${q("usedAt")} = ? WHERE ${q("id")} = ? AND ${q("userId")} = ? AND ${q("usedAt")} IS NULL AND ${q("invalidatedAt")} IS NULL AND ${q("expiresAt")} > ?`,
      [nowSeconds, tokenId, user.id, nowSeconds],
    );
    if (rawAffectedRows(used) !== 1) return false;
    // 密码还是签发时看到的那一个才换：中途被改过（本人改的、管理员重置的）就算这条链接作废。
    const changed = await executeRaw(
      `UPDATE ${q("users")} SET ${q("password")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("password")} = ?`,
      [newPasswordHash, nowSeconds, user.id, user.password],
    );
    if (rawAffectedRows(changed) !== 1) throw new PasswordResetRaceError();
    // 这个人别的没用掉的链接一起作废（正常只有这一条是活的，这里兜住并发申请留下的）。
    await executeRaw(
      `UPDATE ${q("password_reset_tokens")} SET ${q("invalidatedAt")} = ? WHERE ${q("userId")} = ? AND ${q("usedAt")} IS NULL AND ${q("invalidatedAt")} IS NULL`,
      [nowSeconds, user.id],
    );
    await revokeUserAuthSessions(user.id, { reason: "password_reset_link" });
    return true;
  }).catch((error) => {
    // 密码那一步没抢到：事务已经回滚（令牌没被标成用过），按「链接无效」回。
    if (error instanceof PasswordResetRaceError) return false;
    throw error;
  });
}

/** 过期超过 retainDays 天的重置令牌每天清一次（调度器的历史清理里跑）。 */
export async function prunePasswordResetTokens(retainDays = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, retainDays) * 86400;
  return deleteExpiredHistoryRows("password_reset_tokens", "expiresAt", cutoff);
}

// ---------- 流程 ----------

export type PasswordResetAuditEvent = {
  kind: "requested" | "completed";
  user: PasswordResetAccount;
  channels: PasswordResetChannel[];
  ip: string;
  userAgent: string;
};

export type PasswordResetDeps = {
  enabled(): Promise<boolean>;
  findUser(identifier: string): Promise<PasswordResetAccount | undefined | null>;
  getUser(id: number): Promise<PasswordResetAccount | undefined | null>;
  availability(): Promise<PasswordResetAvailability>;
  /** 把链接发到一个渠道；发出去了返回 true。失败返回 false 或抛错都行（只记日志）。 */
  send(user: PasswordResetAccount, channel: PasswordResetChannel, link: string): Promise<boolean>;
  hashPassword(password: string): Promise<string>;
  /** 重置成功后还要收掉的东西（API 令牌、等着输验证码的两步登录……）。 */
  afterReset(user: PasswordResetAccount): Promise<void>;
  /** 记操作审计和事件时间线。失败不影响流程。 */
  audit(event: PasswordResetAuditEvent): Promise<void>;
  /** 响应之后再做的事：默认直接跑、不等它；测试里可以接住这个 promise。 */
  schedule(work: () => Promise<void>): void;
  now(): number;
  log(level: "info" | "warn", message: string): void;
};

export type PasswordResetRequester = { ip: string; userAgent?: string };

function ipKey(prefix: string, ip: string) {
  return `${prefix}:${ipRateLimitScope(ip)}`;
}

export function createPasswordResetService(deps: PasswordResetDeps) {
  /** 登录页据此决定「忘记密码」里显示什么：开没开、面板这边有没有配好至少一个能发的渠道。不带任何账号的信息。 */
  async function options() {
    if (!(await deps.enabled())) return { enabled: false, available: false };
    const availability = await deps.availability();
    const anyChannel = PASSWORD_RESET_CHANNELS.some((channel) => availability[channel]);
    return { enabled: true, available: !!availability.panelUrl && anyChannel };
  }

  async function deliver(identifier: string, requester: PasswordResetRequester) {
    const user = await deps.findUser(identifier);
    if (!user || !accountEnabled(user)) return;
    const availability = await deps.availability();
    if (!availability.panelUrl) {
      deps.log("warn", "[PasswordReset] 没有配置面板公开访问地址，重置链接发不出去（系统设置 › 面板公开访问地址）");
      return;
    }
    const channels = passwordResetDestinations(user, availability);
    if (channels.length === 0) return;
    // 按账号的额度在这里才扣，而且超了也不吭声：响应早就回了，申请的人看不出区别。
    const now = deps.now();
    if (attemptBudgetState(`pwreset-account-hour:${user.id}`, PASSWORD_RESET_ACCOUNT_MAX, PASSWORD_RESET_ACCOUNT_WINDOW_MS, now).limited) return;
    if (consumeAttemptBudget(`pwreset-account-cooldown:${user.id}`, 1, PASSWORD_RESET_ACCOUNT_COOLDOWN_MS, now).limited) return;
    consumeAttemptBudget(`pwreset-account-hour:${user.id}`, PASSWORD_RESET_ACCOUNT_MAX, PASSWORD_RESET_ACCOUNT_WINDOW_MS, now);

    const token = await issuePasswordResetToken(user, { ip: requester.ip, channels, now });
    const link = passwordResetLink(availability.panelUrl, token);
    const sent: PasswordResetChannel[] = [];
    for (const channel of channels) {
      const ok = await deps.send(user, channel, link).catch((error) => {
        deps.log("warn", `[PasswordReset] 发送失败 userId=${user.id} channel=${channel}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
      if (ok) sent.push(channel);
    }
    deps.log("info", `[PasswordReset] link issued userId=${user.id} channels=${sent.join(",") || "none"} ip=${requester.ip}`);
    if (sent.length > 0) {
      await deps.audit({ kind: "requested", user, channels: sent, ip: requester.ip, userAgent: requester.userAgent || "" }).catch(() => undefined);
    }
  }

  /**
   * 申请重置链接。除了「功能关了」「这个来源申请太频繁」（都和账号无关）会报错，其余一律回同一句话。
   * 人机验证在路由里做（server/routers/auth.ts），到这里时已经过了。
   */
  async function request(identifier: string, requester: PasswordResetRequester) {
    if (!(await deps.enabled())) throw new PasswordResetError("FORBIDDEN", PASSWORD_RESET_DISABLED_MESSAGE);
    const limited = consumeAttemptBudget(ipKey("pwreset-request-ip", requester.ip), PASSWORD_RESET_REQUEST_IP_MAX, PASSWORD_RESET_REQUEST_IP_WINDOW_MS, deps.now());
    if (limited.limited) throw new PasswordResetError("TOO_MANY_REQUESTS", PASSWORD_RESET_RATE_LIMITED_MESSAGE);
    const normalized = String(identifier || "").trim();
    if (normalized) {
      deps.schedule(() => deliver(normalized, requester).catch((error) => {
        deps.log("warn", `[PasswordReset] delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      }));
    }
    return { success: true as const, message: PASSWORD_RESET_REQUESTED_MESSAGE };
  }

  /** 这个来源现在还能不能申请（路由在做人机验证之前先看一眼，不扣额度）。 */
  function requestLimited(ip: string) {
    return attemptBudgetState(ipKey("pwreset-request-ip", ip), PASSWORD_RESET_REQUEST_IP_MAX, PASSWORD_RESET_REQUEST_IP_WINDOW_MS, deps.now()).limited;
  }

  /** 拿链接里的令牌设新密码。 */
  async function reset(token: string, newPassword: string, requester: PasswordResetRequester) {
    if (!(await deps.enabled())) throw new PasswordResetError("FORBIDDEN", PASSWORD_RESET_DISABLED_MESSAGE);
    const now = deps.now();
    if (consumeAttemptBudget(ipKey("pwreset-submit-ip", requester.ip), PASSWORD_RESET_SUBMIT_IP_MAX, PASSWORD_RESET_SUBMIT_IP_WINDOW_MS, now).limited) {
      throw new PasswordResetError("TOO_MANY_REQUESTS", PASSWORD_RESET_RATE_LIMITED_MESSAGE);
    }
    const password = String(newPassword ?? "");
    if (password.length < PASSWORD_RESET_MIN_LENGTH) throw new PasswordResetError("BAD_REQUEST", `新密码至少${PASSWORD_RESET_MIN_LENGTH}个字符`);
    if (password.length > PASSWORD_RESET_MAX_LENGTH) throw new PasswordResetError("BAD_REQUEST", `新密码最多 ${PASSWORD_RESET_MAX_LENGTH} 个字符`);

    const invalid = () => new PasswordResetError("BAD_REQUEST", PASSWORD_RESET_INVALID_MESSAGE);
    const record = await findUsablePasswordResetToken(token, now);
    if (!record) throw invalid();
    const user = await deps.getUser(record.userId);
    // 账号没了、停用了、密码已经不是签发时那个：都按「链接无效」回，不多说。
    if (!user || !accountEnabled(user) || passwordResetCredentialMark(user) !== record.credentialMark) throw invalid();
    // scrypt 在事务外面算：SQLite 的事务拿着整库的写锁，不能让它等一次哈希。
    const passwordHash = await deps.hashPassword(password);
    if (!(await consumePasswordResetToken(record.id, user, passwordHash, now))) throw invalid();

    await deps.afterReset(user).catch((error) => {
      deps.log("warn", `[PasswordReset] post-reset cleanup failed userId=${user.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    deps.log("info", `[PasswordReset] password reset userId=${user.id} ip=${requester.ip}; sessions revoked`);
    await deps.audit({ kind: "completed", user, channels: record.channels, ip: requester.ip, userAgent: requester.userAgent || "" }).catch(() => undefined);
    return { success: true as const };
  }

  return { options, request, requestLimited, reset };
}

// ---------- 默认实现（真库、真邮件 / Telegram / Discord） ----------

function escapeTelegramHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function resetMessageLines(link: string) {
  return [
    "NEX 密码重置",
    "",
    `有人在登录页为你的账号申请了重置密码。点下面的链接设置新密码（${PASSWORD_RESET_TTL_MINUTES} 分钟内有效，只能用一次）：`,
    link,
    "",
    "不是你本人操作的话不用理会，密码不会变。不要把这条链接转发给别人。",
  ];
}

async function defaultAvailability(): Promise<PasswordResetAvailability> {
  const [{ getEmailConfig }, { telegramBotReady }, { isDiscordBotReady }, { getConfiguredPanelUrl }] = await Promise.all([
    import("../email"),
    import("../userNotify"),
    import("../discordNotify"),
    import("../agentPanelUrl"),
  ]);
  const [email, telegram, discord, panelUrl] = await Promise.all([
    getEmailConfig().then((config) => config.enabled && !!config.host && !!config.from).catch(() => false),
    telegramBotReady().catch(() => false),
    isDiscordBotReady().catch(() => false),
    getConfiguredPanelUrl().catch(() => ""),
  ]);
  return { email, telegram, discord, panelUrl };
}

async function defaultSend(user: PasswordResetAccount, channel: PasswordResetChannel, link: string): Promise<boolean> {
  const lines = resetMessageLines(link);
  if (channel === "email") {
    const { sendMail } = await import("../email");
    const result = await sendMail({ to: String(user.email || "").trim(), subject: "NEX 密码重置", text: lines.join("\n") });
    return !result.skipped;
  }
  // Telegram 和 Discord 共用一份 Telegram HTML（Discord 那边自己转成纯文字）。
  const html = lines.map(escapeTelegramHtml).join("\n");
  if (channel === "telegram") {
    const { sendTelegramMessage } = await import("../telegramBot");
    await sendTelegramMessage(String(user.telegramId), html);
    return true;
  }
  const { notifyDiscordUser } = await import("../discordNotify");
  const result = await notifyDiscordUser({ id: user.id, discordId: user.discordId, discordDmBlockedAt: user.discordDmBlockedAt }, html, { label: "password-reset" });
  return !!result && result.sent > 0;
}

async function defaultAfterReset(user: PasswordResetAccount) {
  const [{ revokeAllUserApiTokens }, { clearTwoFactorChallengesForUser }, { clearTwoFactorSetupChallengesForUser }] = await Promise.all([
    import("./apiTokens"),
    import("../twoFactorChallenges"),
    import("../twoFactorSetupChallenges"),
  ]);
  // 和改密码、管理员重置密码一样：名下的 API 令牌一起作废。
  await revokeAllUserApiTokens(user.id, "password_reset_link");
  // 用旧密码过了第一步、还在等输验证码的两步登录，以及绑到一半的双重验证，都不能再继续。
  clearTwoFactorChallengesForUser(user.id);
  clearTwoFactorSetupChallengesForUser(user.id);
}

async function defaultAudit(event: PasswordResetAuditEvent) {
  const [{ insertOperationAuditRow }, { recordPanelEvent }] = await Promise.all([
    import("../operationAudit"),
    import("./panelEvents"),
  ]);
  const requested = event.kind === "requested";
  const name = String(event.user.name || event.user.username || `#${event.user.id}`);
  const channelsText = event.channels.map((channel) => PASSWORD_RESET_CHANNEL_LABELS[channel]).join("、") || "未知渠道";
  const isAdmin = event.user.role === "admin";
  /*
    操作审计的中间件只记「登录用户」的写操作，找回密码是没登录时做的，这里自己补一行：
    操作人记这个账号（能收到链接的人就是它的主人），参数里只写发到了哪几个渠道。
  */
  await insertOperationAuditRow({
    actorUserId: event.user.id,
    actorName: String(event.user.username || event.user.name || "").slice(0, 128) || null,
    actorRole: String(event.user.role || "user").slice(0, 16),
    apiTokenId: null,
    apiTokenName: null,
    channel: "web",
    path: requested ? "auth.requestPasswordReset" : "auth.resetPasswordWithToken",
    module: "auth",
    result: "ok",
    errorCode: null,
    errorMessage: null,
    inputJson: JSON.stringify({ via: "找回密码", channels: event.channels }),
    ip: event.ip.slice(0, 64) || null,
    userAgent: event.userAgent.slice(0, 256) || null,
    requestId: crypto.randomUUID(),
    durationMs: 0,
    createdAt: Math.floor(Date.now() / 1000),
  });
  await recordPanelEvent({
    kind: requested ? "account.password_reset_requested" : "account.password_reset",
    // 管理员账号的密码被重置是整个面板的事，提一档。
    level: !requested && isAdmin ? "warn" : "info",
    userId: event.user.id,
    message: requested
      ? `${isAdmin ? "管理员" : "用户"} ${name} 申请了密码重置链接，已发到${channelsText}（${event.ip || "未知 IP"}）`
      : `${isAdmin ? "管理员" : "用户"} ${name} 通过重置链接改了密码，原有登录和 API 令牌已全部失效（${event.ip || "未知 IP"}）`,
    data: { ip: event.ip, channels: event.channels },
  });
}

export const passwordReset = createPasswordResetService({
  enabled: isPasswordResetEnabled,
  findUser: getUserByUsername,
  getUser: getUserById,
  availability: defaultAvailability,
  send: defaultSend,
  hashPassword,
  afterReset: defaultAfterReset,
  audit: defaultAudit,
  // 等这一轮事件循环过去再做：响应先发走，查账号、发链接花的时间不会带进响应耗时里。
  schedule: (work) => { setImmediate(() => { void work(); }); },
  now: () => Date.now(),
  log: (level, message) => { if (level === "warn") console.warn(message); else console.info(message); },
});
