/*
  Google 登录「换回来一个 Google 身份之后，该让谁登录」的规则，和 App 里那条轮询流程。

  认人只认 Google 的 sub（账号的永久 ID），不认邮箱：
  - sub 已经绑在某个账号上 → 就是这个人（停用的账号拒绝，和密码登录一样）。
  - sub 没绑过、是在「登录」：**绝不按邮箱自动并到已有账号上**。Google 账号的邮箱可以是任何人
    随手注册的别名（比如一个从没验证过所有权的企业域名），按邮箱合并等于把账号送人。
    管理员允许 Google 注册、且注册本身开着（开放注册、邮箱白名单、允许的域名都过）时，建一个
    新账号；这个邮箱已经是某个账号的用户名 / 邮箱时也不建，提示去账号设置里绑定。
  - sub 没绑过、是在「绑定」：绑到发起绑定的那个登录着的账号上；这个 sub 已经在别人那里就拒绝。

  这里只做判断，读写都通过 deps 注入（测试里换成内存实现）。规则本体在 server/oauthSignIn.ts，
  和 Discord 登录共用。
*/
import { isEmailDomainAllowed, type GoogleLoginErrorCode, type GoogleLoginMode } from "../shared/googleLogin";
import type { GoogleIdTokenClaims } from "./googleOidc";
import {
  allocateUsername,
  deriveUsernameBase,
  OAUTH_APP_FLOW_TTL_MS,
  OAuthAppFlowStore,
  resolveOAuthSignIn,
  type OAuthAppFlow,
  type OAuthAppFlowStatus,
  type OAuthAppPollResult,
} from "./oauthSignIn";

// 规则本身在 server/oauthSignIn.ts（Google 和 Discord 共用一份），这里只把 Google 的列名翻译过去。
export { allocateUsername, deriveUsernameBase };

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

export async function resolveGoogleSignIn<U extends GoogleUserLike>(
  input: GoogleSignInInput,
  deps: GoogleSignInDeps<U>,
): Promise<GoogleSignInOutcome<U>> {
  // 域名限制先在这里判一次（和原来一样在任何读库之前），共用规则里还会再判，结果一致。
  if (!isEmailDomainAllowed(input.claims.email, input.allowedDomains)) return { kind: "error", code: "domain_not_allowed" };
  return resolveOAuthSignIn<U>({
    mode: input.mode,
    identity: { id: input.claims.sub, email: input.claims.email, name: input.claims.name ?? null },
    allowRegistration: input.allowRegistration,
    allowedDomains: input.allowedDomains,
    linkUserId: input.linkUserId,
    sessionUserId: input.sessionUserId,
    inviteCode: input.inviteCode ?? null,
  }, {
    // deps 每次现取：测试会在调用之间替换单个函数。
    getUserByProviderId: (sub) => deps.getUserByGoogleSub(sub),
    getUserById: (id) => deps.getUserById(id),
    linkedProviderIdOf: (user) => user.googleSub,
    linkProviderAccount: (userId, identity) => deps.linkGoogleAccount(userId, identity.id, identity.email),
    isEmailTakenByAnyUser: (email) => deps.isEmailTakenByAnyUser(email),
    isUsernameTaken: (username) => deps.isUsernameTaken(username),
    registerUser: (data, identity) => deps.registerUser({ ...data, googleSub: identity.id, googleEmail: identity.email }),
    resolveInviter: (code) => deps.resolveInviter(code),
    getRegistrationPolicy: () => deps.getRegistrationPolicy(),
  });
}

// ---------- App 里的 Google 登录（系统浏览器 + 轮询） ----------
// 流程说明见 server/oauthSignIn.ts 的 OAuthAppFlowStore（Google 和 Discord 共用）。

export const GOOGLE_APP_FLOW_TTL_MS = OAUTH_APP_FLOW_TTL_MS;

export type GoogleAppFlowStatus = OAuthAppFlowStatus;
export type GoogleAppFlow = OAuthAppFlow<GoogleLoginErrorCode>;
export type GoogleAppPollResult = OAuthAppPollResult<GoogleLoginErrorCode>;

export class GoogleAppFlowStore extends OAuthAppFlowStore<GoogleLoginErrorCode> {
  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    super({ ...options, fallbackCode: "server_error" });
  }
}
