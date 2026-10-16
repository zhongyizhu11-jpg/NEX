/*
  Google 登录「换回来一个 Google 身份之后，该让谁登录」的规则，和 App 里那条轮询流程。

  认人只认 Google 的 sub（账号的永久 ID），不认邮箱：
  - sub 已经绑在某个账号上 → 就是这个人（停用的账号拒绝，和密码登录一样）。
  - sub 没绑过、是在「登录」：**绝不按邮箱自动并到已有账号上**。Google 账号的邮箱可以是任何人
    随手注册的别名（比如一个从没验证过所有权的企业域名），按邮箱合并等于把账号送人。
    管理员允许 Google 注册、且注册本身开着（开放注册、邮箱白名单、允许的域名都过）时，建一个
    新账号；这个邮箱已经是某个账号的用户名 / 邮箱时也不建，提示去账号设置里绑定。
  - sub 没绑过、是在「绑定」：绑到发起绑定的那个登录着的账号上；这个 sub 已经在别人那里就拒绝。

  这里只做判断，读写都通过 deps 注入（测试里换成内存实现）。
*/
import crypto from "node:crypto";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { isEmailDomainAllowed, type GoogleLoginErrorCode, type GoogleLoginMode } from "../shared/googleLogin";
import type { GoogleIdTokenClaims } from "./googleOidc";
import { sha256Base64Url, timingSafeEqualText } from "./googleOidc";

export type GoogleUserLike = {
  id: number;
  username: string;
  accountEnabled?: boolean | null;
  googleSub?: string | null;
};

export type GoogleSignInDeps<U extends GoogleUserLike> = {
  getUserByGoogleSub(sub: string): Promise<U | undefined>;
  getUserById(id: number): Promise<U | undefined>;
  linkGoogleAccount(userId: number, sub: string, email: string): Promise<boolean>;
  isEmailTakenByAnyUser(email: string): Promise<boolean>;
  isUsernameTaken(username: string): Promise<boolean>;
  /** 和密码注册同一个 db.registerUser（以后注册加的规则，比如邀请码，在这条路上也要接上）。 */
  registerUser(data: {
    username: string;
    password: string;
    name?: string;
    email?: string;
    emailVerified?: boolean;
    emailVerifiedAt?: Date | null;
    unusablePassword?: boolean;
    googleSub?: string | null;
    googleEmail?: string | null;
    inviterId?: number | null;
  }): Promise<number>;
  /**
   * 邀请返利：按邀请码找邀请人，和密码注册的 resolveRegistrationInviter 同一个函数。
   * 管理员开了「必须邀请注册」而邀请码无效时抛错 —— 这里翻成 invite_required。
   */
  resolveInviter(inviteCode: string | null): Promise<number | null>;
  /** 注册开没开、邮箱白名单（白名单没开就是空数组）。 */
  getRegistrationPolicy(): Promise<{ registrationEnabled: boolean; emailWhitelist: string[] }>;
};

export type GoogleSignInInput = {
  mode: GoogleLoginMode;
  claims: Pick<GoogleIdTokenClaims, "sub" | "email" | "name">;
  allowRegistration: boolean;
  allowedDomains: readonly string[];
  /** 绑定模式：发起绑定时登录着的用户（存在 state 里）。 */
  linkUserId: number | null;
  /** 回调这一刻浏览器里登录着的用户。绑定模式下必须和 linkUserId 是同一个人。 */
  sessionUserId: number | null;
  /** 从邀请链接进来时带的邀请码（发起时存在 state 里），只在 Google 注册新账号时用。 */
  inviteCode?: string | null;
};

export type GoogleSignInOutcome<U> =
  | { kind: "signed_in"; user: U; created: boolean }
  | { kind: "linked"; user: U; alreadyLinked: boolean }
  | { kind: "error"; code: GoogleLoginErrorCode };

const USERNAME_MAX_LENGTH = 32;

/** 邮箱 @ 前面那段，只留字母数字和 . _ -，去掉首尾的点和横线；剩不下就叫 user。 */
export function deriveUsernameBase(email: string) {
  const local = String(email || "").split("@")[0] || "";
  const cleaned = local
    .toLowerCase()
    .replace(/\+.*$/, "")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, USERNAME_MAX_LENGTH)
    .replace(/[._-]+$/g, "");
  return cleaned || "user";
}

/** alice → alice、alice2、alice3……都被占了就 alice-<随机>。 */
export async function allocateUsername(base: string, isTaken: (name: string) => Promise<boolean>) {
  const trimmed = base.slice(0, USERNAME_MAX_LENGTH);
  if (!(await isTaken(trimmed))) return trimmed;
  for (let index = 2; index <= 50; index += 1) {
    const suffix = String(index);
    const candidate = `${trimmed.slice(0, USERNAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = `-${crypto.randomBytes(3).toString("hex")}`;
    const candidate = `${trimmed.slice(0, USERNAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error("无法分配用户名");
}

function isUniqueViolation(error: unknown) {
  const text = error instanceof Error ? `${(error as any).code || ""} ${error.message}` : String(error);
  return /unique|duplicate|ER_DUP_ENTRY|23505|SQLITE_CONSTRAINT/i.test(text);
}

export async function resolveGoogleSignIn<U extends GoogleUserLike>(
  input: GoogleSignInInput,
  deps: GoogleSignInDeps<U>,
): Promise<GoogleSignInOutcome<U>> {
  const { claims } = input;
  if (!isEmailDomainAllowed(claims.email, input.allowedDomains)) return { kind: "error", code: "domain_not_allowed" };

  if (input.mode === "link") {
    if (!input.linkUserId || input.sessionUserId !== input.linkUserId) return { kind: "error", code: "link_requires_login" };
    const user = await deps.getUserById(input.linkUserId);
    if (!user) return { kind: "error", code: "link_requires_login" };
    if (user.accountEnabled === false) return { kind: "error", code: "account_disabled" };
    const owner = await deps.getUserByGoogleSub(claims.sub);
    if (owner) {
      return owner.id === user.id
        ? { kind: "linked", user, alreadyLinked: true }
        : { kind: "error", code: "linked_elsewhere" };
    }
    if (user.googleSub) return { kind: "error", code: "already_linked" };
    try {
      if (await deps.linkGoogleAccount(user.id, claims.sub, claims.email)) {
        return { kind: "linked", user: (await deps.getUserById(user.id)) || user, alreadyLinked: false };
      }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return { kind: "error", code: "linked_elsewhere" };
    }
    // 没写进去：排队期间这个账号绑上了别的 Google，或者这个 sub 被别人抢先绑了。
    const after = await deps.getUserByGoogleSub(claims.sub);
    if (after && after.id !== user.id) return { kind: "error", code: "linked_elsewhere" };
    if (after?.id === user.id) return { kind: "linked", user: after, alreadyLinked: true };
    return { kind: "error", code: "already_linked" };
  }

  // 登录（网页或 App）
  const existing = await deps.getUserByGoogleSub(claims.sub);
  if (existing) {
    if (existing.accountEnabled === false) return { kind: "error", code: "account_disabled" };
    return { kind: "signed_in", user: existing, created: false };
  }
  if (!input.allowRegistration) return { kind: "error", code: "not_linked" };
  const policy = await deps.getRegistrationPolicy();
  if (!policy.registrationEnabled) return { kind: "error", code: "registration_closed" };
  if (!isEmailDomainAllowed(claims.email, policy.emailWhitelist)) return { kind: "error", code: "domain_not_allowed" };
  // 这个邮箱已经属于某个账号：不合并、也不再建一个同邮箱的账号（「用户名或邮箱」登录会撞车）。
  if (await deps.isEmailTakenByAnyUser(claims.email)) return { kind: "error", code: "email_in_use" };

  // 邀请注册和密码注册同一条规则：开了「必须邀请注册」时没有有效邀请码就不建号。
  let inviterId: number | null;
  try {
    inviterId = await deps.resolveInviter(input.inviteCode ?? null);
  } catch {
    return { kind: "error", code: "invite_required" };
  }

  const username = await allocateUsername(deriveUsernameBase(claims.email), deps.isUsernameTaken);
  let id: number;
  try {
    id = await deps.registerUser({
      username,
      password: "",
      name: (claims.name || username).slice(0, 24),
      email: claims.email,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      unusablePassword: true,
      googleSub: claims.sub,
      googleEmail: claims.email,
      inviterId,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // 同一个 Google 账号两个回调同时到：另一个已经建好了，就用那一个。
    const raced = await deps.getUserByGoogleSub(claims.sub);
    if (raced) return raced.accountEnabled === false ? { kind: "error", code: "account_disabled" } : { kind: "signed_in", user: raced, created: false };
    return { kind: "error", code: "server_error" };
  }
  const created = await deps.getUserById(id);
  if (!created) return { kind: "error", code: "server_error" };
  return { kind: "signed_in", user: created, created: true };
}

// ---------- App 里的 Google 登录（系统浏览器 + 轮询） ----------

/*
  App 的 WebView 里不能直接走 Google 授权（Google 拦截内嵌 WebView：disallowed_useragent），
  而且 App 的页面不在面板域名下，回调设的 cookie 也到不了 App。所以和 Telegram 的 App 登录一样：

  1. App 调 googleAuth.appStart，拿到 flowId + pollToken + 一个面板上的 start 地址；
  2. App 用系统浏览器打开 start 地址，用户在浏览器里完成 Google 授权；
  3. 回调里认出这个人以后，不在浏览器里发会话，只把结果记到这条流程上，页面提示「回到 App」；
  4. App 拿 pollToken 轮询 googleAuth.appStatus，成功时拿到 App 用的会话令牌（要 2FA 就先弹验证码）。

  防「把登录链接发给别人点」：发起流程的 App 和完成授权的浏览器通常在同一台手机上，来源 IP
  一样（IPv6 按 /64）。对不上时浏览器里先显示一页确认，写明发起设备的 IP，用户点了确认才算数。
*/

export const GOOGLE_APP_FLOW_TTL_MS = 10 * 60 * 1000;
const GOOGLE_APP_FLOW_MAX = 10_000;

export type GoogleAppFlowStatus = "pending" | "started" | "awaiting_confirm" | "done" | "failed";

export type GoogleAppFlow = {
  flowId: string;
  pollTokenHash: string;
  ip: string;
  ipScope: string;
  status: GoogleAppFlowStatus;
  userId: number | null;
  errorCode: GoogleLoginErrorCode | null;
  confirmIdHash: string | null;
  createdAt: number;
  expiresAt: number;
};

export type GoogleAppPollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "failed"; code: GoogleLoginErrorCode }
  | { status: "done"; userId: number };

export class GoogleAppFlowStore {
  private readonly flows = new Map<string, GoogleAppFlow>();

  constructor(private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {}

  private now() {
    return (this.options.now || Date.now)();
  }

  private live(flowId: unknown) {
    if (typeof flowId !== "string" || flowId.length < 16 || flowId.length > 64) return null;
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    if (flow.expiresAt <= this.now()) {
      this.flows.delete(flowId);
      return null;
    }
    return flow;
  }

  create(ip: string) {
    const now = this.now();
    pruneMapEntries(this.flows, (flow) => flow.expiresAt <= now);
    const flowId = crypto.randomBytes(18).toString("base64url");
    const pollToken = crypto.randomBytes(32).toString("base64url");
    const flow: GoogleAppFlow = {
      flowId,
      pollTokenHash: sha256Base64Url(pollToken),
      ip: String(ip || "unknown"),
      ipScope: ipRateLimitScope(ip),
      status: "pending",
      userId: null,
      errorCode: null,
      confirmIdHash: null,
      createdAt: now,
      expiresAt: now + (this.options.ttlMs ?? GOOGLE_APP_FLOW_TTL_MS),
    };
    setBoundedMapValue(this.flows, flowId, flow, this.options.maxEntries ?? GOOGLE_APP_FLOW_MAX);
    return { flowId, pollToken, expiresInSeconds: Math.floor((flow.expiresAt - now) / 1000) };
  }

  /** start 地址只能打开一次：第二次打开（比如链接被转发出去）直接作废。 */
  markStarted(flowId: unknown) {
    const flow = this.live(flowId);
    if (!flow || flow.status !== "pending") return false;
    flow.status = "started";
    return true;
  }

  get(flowId: unknown) {
    return this.live(flowId);
  }

  /** 浏览器的来源和发起流程的 App 是不是同一处（IPv4 同地址 / IPv6 同 /64）。 */
  sameOrigin(flowId: unknown, ip: string) {
    const flow = this.live(flowId);
    if (!flow) return false;
    const scope = ipRateLimitScope(ip);
    if (flow.ipScope === "unknown" || scope === "unknown") return false;
    return flow.ipScope === scope;
  }

  complete(flowId: unknown, userId: number) {
    const flow = this.live(flowId);
    if (!flow || (flow.status !== "started" && flow.status !== "awaiting_confirm")) return false;
    flow.status = "done";
    flow.userId = userId;
    flow.confirmIdHash = null;
    return true;
  }

  fail(flowId: unknown, code: GoogleLoginErrorCode) {
    const flow = this.live(flowId);
    if (!flow || flow.status === "done") return false;
    flow.status = "failed";
    flow.errorCode = code;
    flow.userId = null;
    return true;
  }

  /** IP 对不上：先挂起，等浏览器里点确认。返回确认用的一次性 ID。 */
  requireConfirm(flowId: unknown, userId: number) {
    const flow = this.live(flowId);
    if (!flow || flow.status !== "started") return null;
    const confirmId = crypto.randomBytes(24).toString("base64url");
    flow.status = "awaiting_confirm";
    flow.userId = userId;
    flow.confirmIdHash = sha256Base64Url(confirmId);
    return confirmId;
  }

  confirm(flowId: unknown, confirmId: unknown) {
    const flow = this.live(flowId);
    if (!flow || flow.status !== "awaiting_confirm" || !flow.confirmIdHash || flow.userId === null) return false;
    if (typeof confirmId !== "string" || !timingSafeEqualText(sha256Base64Url(confirmId), flow.confirmIdHash)) return false;
    return this.complete(flowId, flow.userId);
  }

  /** App 轮询。成功或失败的结果只交出去一次（交出去就删掉这条流程）。 */
  poll(flowId: unknown, pollToken: unknown): GoogleAppPollResult {
    const flow = this.live(flowId);
    if (!flow) return { status: "expired" };
    if (typeof pollToken !== "string" || !timingSafeEqualText(sha256Base64Url(pollToken), flow.pollTokenHash)) {
      return { status: "pending" };
    }
    if (flow.status === "done" && flow.userId !== null) {
      this.flows.delete(flow.flowId);
      return { status: "done", userId: flow.userId };
    }
    if (flow.status === "failed") {
      this.flows.delete(flow.flowId);
      return { status: "failed", code: flow.errorCode || "server_error" };
    }
    return { status: "pending" };
  }

  cancel(flowId: unknown, pollToken: unknown) {
    const flow = this.live(flowId);
    if (!flow || typeof pollToken !== "string" || !timingSafeEqualText(sha256Base64Url(pollToken), flow.pollTokenHash)) return false;
    this.flows.delete(flow.flowId);
    return true;
  }
}
