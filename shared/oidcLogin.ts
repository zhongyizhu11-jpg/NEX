/*
  通用 OpenID Connect 登录（Pocket ID、Authentik、Keycloak、Authelia、Zitadel 这类自建身份提供方）
  前后端共用的一小块：入口 / 回调地址、失败码对应哪句中文、issuer 和 scope 怎么校验、按钮上写什么。

  失败一律以 /login?oidcError=<码>（绑定时是 /profile?oidcError=<码>）跳回来，页面按码查这里的中文提示 ——
  URL 里只有一个短码，不会带任何令牌。和 Google 登录（shared/googleLogin.ts）是同一套做法。
*/
import { normalizePanelBaseUrl } from "./googleLogin";

export const OIDC_CALLBACK_PATH = "/api/auth/oidc/callback";
export const OIDC_START_PATH = "/api/auth/oidc/start";
export const OIDC_DEFAULT_SCOPES = "openid email profile";
export const OIDC_DEFAULT_PROVIDER_NAME = "OIDC";
/** 库里 oidcIssuer 是 varchar(191)（和 oidcSub 一起建唯一索引，MySQL 索引长度有上限）。 */
export const OIDC_ISSUER_MAX_LENGTH = 191;

/** 通用 OIDC 只有网页登录和绑定：App 里的系统浏览器流程没有接（见 docs/guide/oidc-login.md）。 */
export type OidcLoginMode = "login" | "link";

export const OIDC_LOGIN_ERROR_MESSAGES = {
  disabled: "管理员没有开启 OIDC 登录",
  not_configured: "OIDC 登录还没有配置完整，请联系管理员",
  cancelled: "已取消登录",
  state_invalid: "登录请求已过期或无效，请回到登录页重新点一次",
  idp_error: "身份提供方拒绝了这次登录，请稍后重试或联系管理员",
  discovery_failed: "读取身份提供方的配置（discovery）失败，请联系管理员检查 Issuer 地址和网络",
  exchange_failed: "向身份提供方换取登录凭据失败，请稍后重试（面板服务器需要能访问身份提供方）",
  token_invalid: "身份提供方返回的身份凭据没有通过校验，请重试",
  email_missing: "身份提供方没有给出邮箱：请确认 scope 包含 email，且账号填了邮箱",
  email_unverified: "这个账号的邮箱在身份提供方那边还没有验证，不能用来登录",
  domain_not_allowed: "这个账号的邮箱域名不在允许范围内",
  not_linked: "这个账号还没绑定面板账号：请先用密码登录，在 个人资料 里绑定",
  email_in_use: "这个邮箱已经有面板账号：请先用密码登录，在 个人资料 里绑定",
  registration_closed: "当前注册未开放，请联系管理员",
  invite_required: "当前仅支持邀请注册：请用邀请链接打开注册页，再点登录按钮",
  account_disabled: "账户已被禁用，请联系管理员",
  maintenance: "面板维护中，请稍后再来",
  linked_elsewhere: "这个身份提供方账号已经绑定了另一个面板账号",
  already_linked: "当前账号已经绑定了另一个身份提供方账号，请先解除绑定",
  link_requires_login: "请先登录面板再绑定（要在「面板公开地址」打开的面板里操作）",
  rate_limited: "操作太频繁，请稍后再试",
  server_error: "登录失败，请稍后重试",
} as const;

export type OidcLoginErrorCode = keyof typeof OIDC_LOGIN_ERROR_MESSAGES;

export function isOidcLoginErrorCode(value: unknown): value is OidcLoginErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OIDC_LOGIN_ERROR_MESSAGES, value);
}

/** 码 → 中文；认不出的码一律按「登录失败」说，不把 URL 里的任意文字原样显示出来。 */
export function oidcLoginErrorMessage(code: unknown) {
  return isOidcLoginErrorCode(code) ? OIDC_LOGIN_ERROR_MESSAGES[code] : OIDC_LOGIN_ERROR_MESSAGES.server_error;
}

/** 回调地址：面板公开地址 + /api/auth/oidc/callback。没配面板公开地址时返回空串。 */
export function buildOidcRedirectUri(panelPublicUrl: string | null | undefined) {
  const base = normalizePanelBaseUrl(panelPublicUrl);
  return base ? `${base}${OIDC_CALLBACK_PATH}` : "";
}

/** 按钮上的名字：管理员填的「显示名称」，没填就叫 OIDC。只留一行、最多 32 个字。 */
export function normalizeOidcProviderName(value: unknown) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  return text || OIDC_DEFAULT_PROVIDER_NAME;
}

export function oidcButtonLabel(providerName: unknown) {
  return `使用 ${normalizeOidcProviderName(providerName)} 登录`;
}

/**
 * 校验管理员填的 Issuer。返回 null 表示没问题，否则是给管理员看的原因。
 *
 * - 必须是 https；只有勾了「IdP 在内网」才接受 http（局域网里的 Keycloak 常常没有证书）。
 * - 不能带账号密码、查询串、# 片段 —— OIDC 规定 issuer 只有协议、主机、端口和路径。
 * - **不改写**：末尾斜杠留不留由 IdP 决定，discovery 返回的 issuer 必须和这里一字不差（见 server/oidcClient.ts）。
 */
export function validateOidcIssuer(value: string, options: { allowHttp: boolean }): string | null {
  const text = String(value || "").trim();
  if (!text) return "请填写 Issuer 地址";
  if (text.length > OIDC_ISSUER_MAX_LENGTH) return `Issuer 地址太长（最多 ${OIDC_ISSUER_MAX_LENGTH} 个字符）`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Issuer 地址格式不对，应当形如 https://id.example.com";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Issuer 只支持 https 地址";
  if (url.protocol === "http:" && !options.allowHttp) return "Issuer 必须是 https 地址（IdP 在内网时可以勾选「IdP 在内网」后使用 http）";
  if (url.username || url.password) return "Issuer 地址里不能带账号密码";
  if (url.search || url.hash || text.includes("?") || text.includes("#")) return "Issuer 地址里不能带 ? 查询参数或 # 片段";
  return null;
}

/**
 * 「openid email profile」→ 去重后的 scope 列表；没写 openid 时补在最前面（不带 openid 就不是 OIDC，拿不到 ID Token）。
 * 只认 RFC 6749 允许的可见字符；格式不对返回 null。
 */
export function parseOidcScopes(value: string | null | undefined): string[] | null {
  const raw = String(value ?? "").trim() || OIDC_DEFAULT_SCOPES;
  const items = raw.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean);
  if (items.some((item) => item.length > 64 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(item))) return null;
  const unique = [...new Set(items)];
  if (!unique.includes("openid")) unique.unshift("openid");
  if (unique.length > 20) return null;
  return unique;
}
