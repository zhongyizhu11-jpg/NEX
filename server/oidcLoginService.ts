/*
  通用 OIDC 登录「换回来一个身份之后，该让谁登录」的规则。规则本体在 server/oauthSignIn.ts（和 Google、Discord 共用）：

  - 认人只认 (issuer, sub)：同一个 sub 在另一个 IdP 那里是另一个人。管理员换了 Issuer，
    旧 Issuer 下的绑定自然就不再能登录（也不会被新 IdP 里恰好同 sub 的人接管）。
  - **绝不按邮箱自动并到已有账号上**：自建 IdP 的管理员（或者任何能在 IdP 里改自己邮箱的人）
    想填什么邮箱就填什么，按邮箱合并等于把账号送人。没绑定过的身份只能「注册新账号」（管理员允许时）
    或者「先用密码登录、再在个人资料里绑定」。
  - 绑定：只绑到发起绑定、回调时还登录着的那个人；这个身份已经在别人那里就拒绝。
    账号身上已经绑着**同一个 Issuer** 的另一个身份时拒绝（先解绑）；绑着的是旧 Issuer 的身份时允许覆盖 ——
    那个绑定已经不能用来登录了，留着只会让用户没法重新绑。

  这里只做判断，读写都通过 deps 注入（测试里换成内存实现）。
*/
import { isEmailDomainAllowed } from "../shared/googleLogin";
import type { OidcLoginErrorCode, OidcLoginMode } from "../shared/oidcLogin";
import { resolveOAuthSignIn, type OAuthRegisterData } from "./oauthSignIn";
import type { OidcIdTokenClaims } from "./oidcClient";

export type OidcUserLike = {
  id: number;
  username: string;
  accountEnabled?: boolean | null;
  oidcIssuer?: string | null;
  oidcSub?: string | null;
};

export type OidcSignInDeps<U extends OidcUserLike> = {
  getUserByOidcIdentity(issuer: string, sub: string): Promise<U | undefined>;
  getUserById(id: number): Promise<U | undefined>;
  linkOidcAccount(userId: number, issuer: string, sub: string, email: string): Promise<boolean>;
  isEmailTakenByAnyUser(email: string): Promise<boolean>;
  isUsernameTaken(username: string): Promise<boolean>;
  /** 和密码注册同一个 db.registerUser；绑定列和建号在同一条 INSERT 里（(issuer, sub) 有唯一索引）。 */
  registerUser(data: OAuthRegisterData & { oidcIssuer: string; oidcSub: string; oidcEmail: string }): Promise<number>;
  resolveInviter(inviteCode: string | null): Promise<number | null>;
  getRegistrationPolicy(): Promise<{ registrationEnabled: boolean; emailWhitelist: string[] }>;
};

export type OidcSignInInput = {
  mode: OidcLoginMode;
  issuer: string;
  claims: Pick<OidcIdTokenClaims, "sub" | "name" | "preferredUsername">;
  /** 已经过 evaluateOidcEmail 的邮箱。 */
  email: string;
  emailVerified: boolean;
  allowRegistration: boolean;
  allowedDomains: readonly string[];
  linkUserId: number | null;
  sessionUserId: number | null;
  inviteCode?: string | null;
};

export type OidcSignInOutcome<U> =
  | { kind: "signed_in"; user: U; created: boolean }
  | { kind: "linked"; user: U; alreadyLinked: boolean }
  | { kind: "error"; code: OidcLoginErrorCode };

/** 这个账号身上「对当前 Issuer 有效」的绑定（旧 Issuer 的不算）。 */
export function activeOidcSubOf(user: Pick<OidcUserLike, "oidcIssuer" | "oidcSub">, issuer: string) {
  return user.oidcSub && user.oidcIssuer === issuer ? user.oidcSub : null;
}

export async function resolveOidcSignIn<U extends OidcUserLike>(
  input: OidcSignInInput,
  deps: OidcSignInDeps<U>,
): Promise<OidcSignInOutcome<U>> {
  if (!input.issuer) return { kind: "error", code: "server_error" };
  if (!isEmailDomainAllowed(input.email, input.allowedDomains)) return { kind: "error", code: "domain_not_allowed" };
  const issuer = input.issuer;
  return resolveOAuthSignIn<U>({
    mode: input.mode,
    identity: {
      id: input.claims.sub,
      email: input.email,
      emailVerified: input.emailVerified,
      name: input.claims.name ?? null,
      // IdP 里的用户名（Pocket ID / Keycloak 都有）比邮箱前缀更像用户自己起的名字；重名照样加数字。
      usernameHint: input.claims.preferredUsername ?? null,
    },
    allowRegistration: input.allowRegistration,
    allowedDomains: input.allowedDomains,
    linkUserId: input.linkUserId,
    sessionUserId: input.sessionUserId,
    inviteCode: input.inviteCode ?? null,
  }, {
    getUserByProviderId: (sub) => deps.getUserByOidcIdentity(issuer, sub),
    getUserById: (id) => deps.getUserById(id),
    linkedProviderIdOf: (user) => activeOidcSubOf(user, issuer),
    linkProviderAccount: (userId, identity) => deps.linkOidcAccount(userId, issuer, identity.id, identity.email),
    isEmailTakenByAnyUser: (email) => deps.isEmailTakenByAnyUser(email),
    isUsernameTaken: (username) => deps.isUsernameTaken(username),
    registerUser: (data, identity) => deps.registerUser({ ...data, oidcIssuer: issuer, oidcSub: identity.id, oidcEmail: identity.email }),
    resolveInviter: (code) => deps.resolveInviter(code),
    getRegistrationPolicy: () => deps.getRegistrationPolicy(),
  });
}
