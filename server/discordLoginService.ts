/*
  Discord 登录「换回来一个 Discord 身份之后，该让谁登录」。

  规则和 Google 登录是同一份（server/oauthSignIn.ts 的 resolveOAuthSignIn）：
  - 认人只认 Discord 用户 ID（雪花），不认邮箱；
  - 没绑定过的 Discord 账号**绝不按邮箱自动并到已有账号上**；
  - 注册要同时过「允许 Discord 注册」「开放注册」、邮箱白名单、允许的域名和邀请码；
  - 绑定只绑到发起绑定、回调时还登录着的那个人；停用的账号一律拒绝。
  这里只把 Discord 的列名翻译成共用规则的 deps。
*/
import type { DiscordLoginErrorCode, DiscordLoginMode } from "../shared/discordLogin";
import type { DiscordProfile } from "./discordOAuth";
import { OAuthAppFlowStore, resolveOAuthSignIn, type OAuthSignInOutcome } from "./oauthSignIn";

export type DiscordUserLike = {
  id: number;
  username: string;
  accountEnabled?: boolean | null;
  discordId?: string | null;
};

export type DiscordSignInDeps<U extends DiscordUserLike> = {
  getUserByDiscordId(discordId: string): Promise<U | undefined>;
  getUserById(id: number): Promise<U | undefined>;
  linkDiscordAccount(userId: number, discordId: string, username: string | null, email: string | null): Promise<boolean>;
  isEmailTakenByAnyUser(email: string): Promise<boolean>;
  isUsernameTaken(username: string): Promise<boolean>;
  /** 和密码注册同一个 db.registerUser。 */
  registerUser(data: {
    username: string;
    password: string;
    name?: string;
    email?: string;
    emailVerified?: boolean;
    emailVerifiedAt?: Date | null;
    unusablePassword?: boolean;
    discordId?: string | null;
    discordUsername?: string | null;
    discordEmail?: string | null;
    inviterId?: number | null;
  }): Promise<number>;
  /** 邀请返利：和密码注册、Google 注册同一个 resolveRegistrationInviter。 */
  resolveInviter(inviteCode: string | null): Promise<number | null>;
  getRegistrationPolicy(): Promise<{ registrationEnabled: boolean; emailWhitelist: string[] }>;
};

export type DiscordSignInInput = {
  mode: DiscordLoginMode;
  profile: Pick<DiscordProfile, "id" | "username" | "globalName" | "email">;
  allowRegistration: boolean;
  allowedDomains: readonly string[];
  linkUserId: number | null;
  sessionUserId: number | null;
  inviteCode?: string | null;
};

export type DiscordSignInOutcome<U> = OAuthSignInOutcome<U>;

export async function resolveDiscordSignIn<U extends DiscordUserLike>(
  input: DiscordSignInInput,
  deps: DiscordSignInDeps<U>,
): Promise<DiscordSignInOutcome<U>> {
  const { profile } = input;
  return resolveOAuthSignIn<U>({
    mode: input.mode,
    // 新账号的用户名优先取 Discord 用户名（本来就是小写字母数字和 . _），取不出再用邮箱前缀
    identity: { id: profile.id, email: profile.email, name: profile.globalName || profile.username, usernameHint: profile.username },
    allowRegistration: input.allowRegistration,
    allowedDomains: input.allowedDomains,
    linkUserId: input.linkUserId,
    sessionUserId: input.sessionUserId,
    inviteCode: input.inviteCode ?? null,
  }, {
    getUserByProviderId: (id) => deps.getUserByDiscordId(id),
    getUserById: (id) => deps.getUserById(id),
    linkedProviderIdOf: (user) => user.discordId,
    linkProviderAccount: (userId, identity) => deps.linkDiscordAccount(userId, identity.id, profile.username, identity.email),
    isEmailTakenByAnyUser: (email) => deps.isEmailTakenByAnyUser(email),
    isUsernameTaken: (username) => deps.isUsernameTaken(username),
    registerUser: (data, identity) => deps.registerUser({ ...data, discordId: identity.id, discordUsername: profile.username, discordEmail: identity.email }),
    resolveInviter: (code) => deps.resolveInviter(code),
    getRegistrationPolicy: () => deps.getRegistrationPolicy(),
  });
}

/** App 里的 Discord 登录（系统浏览器 + 轮询），流程见 server/oauthSignIn.ts。 */
export class DiscordAppFlowStore extends OAuthAppFlowStore<DiscordLoginErrorCode> {
  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    super({ ...options, fallbackCode: "server_error" });
  }
}
