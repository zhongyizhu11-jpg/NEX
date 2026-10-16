/*
  Google 登录（OAuth 2.0 / OpenID Connect）前后端共用的一小块：
  回调地址怎么拼、跳回哪个页面算安全、邮箱域名限制怎么判、失败码对应哪句中文。

  失败一律以 /login?googleError=<码>（绑定时是 /profile?googleError=<码>）跳回来，
  页面按码查这里的中文提示 —— URL 里只有一个短码，不会带任何令牌。
*/

export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";
export const GOOGLE_START_PATH = "/api/auth/google/start";

export type GoogleLoginMode = "login" | "link" | "app";

export const GOOGLE_LOGIN_ERROR_MESSAGES = {
  disabled: "管理员没有开启 Google 登录",
  not_configured: "Google 登录还没有配置完整，请联系管理员",
  cancelled: "已取消 Google 登录",
  state_invalid: "登录请求已过期或无效，请重新点「使用 Google 登录」",
  exchange_failed: "向 Google 换取登录凭据失败，请稍后重试（面板服务器需要能访问 Google）",
  token_invalid: "Google 返回的身份凭据没有通过校验，请重试",
  email_unverified: "这个 Google 账号的邮箱还没有验证，不能用来登录",
  domain_not_allowed: "这个 Google 账号的邮箱域名不在允许范围内",
  not_linked: "这个 Google 账号还没绑定面板账号：请先用密码登录，在 账号设置 里绑定 Google",
  email_in_use: "这个邮箱已经有面板账号：请先用密码登录，在 账号设置 里绑定 Google",
  registration_closed: "当前注册未开放，请联系管理员",
  invite_required: "当前仅支持邀请注册：请用邀请链接打开注册页，再点「使用 Google 登录」",
  account_disabled: "账户已被禁用，请联系管理员",
  maintenance: "面板维护中，请稍后再来",
  linked_elsewhere: "这个 Google 账号已经绑定了另一个面板账号",
  already_linked: "当前账号已经绑定了另一个 Google 账号，请先解除绑定",
  link_requires_login: "请先登录面板再绑定 Google（要在「面板公开地址」打开的面板里操作）",
  rate_limited: "操作太频繁，请稍后再试",
  app_flow_invalid: "App 登录请求已过期，请回到 App 重新点「使用 Google 登录」",
  server_error: "Google 登录失败，请稍后重试",
} as const;

export type GoogleLoginErrorCode = keyof typeof GOOGLE_LOGIN_ERROR_MESSAGES;

/** 邀请码只认字母数字（和注册页一样最长 32 位）；别的一律当没带。 */
export function sanitizeGoogleInviteCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9]{4,32}$/.test(code) ? code : null;
}

export function isGoogleLoginErrorCode(value: unknown): value is GoogleLoginErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GOOGLE_LOGIN_ERROR_MESSAGES, value);
}

/** 码 → 中文；认不出的码一律按「登录失败」说，不把 URL 里的任意文字原样显示出来。 */
export function googleLoginErrorMessage(code: unknown) {
  return isGoogleLoginErrorCode(code) ? GOOGLE_LOGIN_ERROR_MESSAGES[code] : GOOGLE_LOGIN_ERROR_MESSAGES.server_error;
}

/** 面板公开地址去掉末尾斜杠；不是 http(s) 绝对地址就当没配。 */
export function normalizePanelBaseUrl(panelPublicUrl: string | null | undefined) {
  const text = String(panelPublicUrl || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/** 要填进 Google Cloud Console「已获授权的重定向 URI」的那一串。没配面板公开地址时返回空串。 */
export function buildGoogleRedirectUri(panelPublicUrl: string | null | undefined) {
  const base = normalizePanelBaseUrl(panelPublicUrl);
  return base ? `${base}${GOOGLE_CALLBACK_PATH}` : "";
}

/** Google 只接受 https 的重定向地址（localhost 例外）。 */
export function isGoogleAcceptableRedirectBase(panelPublicUrl: string | null | undefined) {
  const base = normalizePanelBaseUrl(panelPublicUrl);
  if (!base) return false;
  const url = new URL(base);
  if (url.protocol === "https:") return true;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost");
}

const MAX_REDIRECT_PATH_LENGTH = 512;

/**
 * 登录成功后跳回去的地址：只接受本站的相对路径。
 *
 * 必须以单个 "/" 开头；"//evil.com"、"/\evil.com"（浏览器把反斜杠当斜杠）、带协议的、
 * 带控制字符的都不要 —— 那些都能把人带去别的网站（开放重定向）。/api/ 下的接口也不跳。
 * 不合格一律回首页。
 */
export function sanitizeRedirectPath(value: unknown, fallback = "/") {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!text || text.length > MAX_REDIRECT_PATH_LENGTH) return fallback;
  if (!text.startsWith("/") || text.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(text)) return fallback;
  try {
    const parsed = new URL(text, "http://panel.invalid");
    if (parsed.origin !== "http://panel.invalid") return fallback;
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!path.startsWith("/") || path.startsWith("//")) return fallback;
    if (/^\/api(?:\/|$)/i.test(parsed.pathname)) return fallback;
    return path;
  } catch {
    return fallback;
  }
}

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** 「example.com, @corp.example.org」→ ["example.com", "corp.example.org"]；格式不对的项丢掉。 */
export function parseEmailDomainList(value: string | null | undefined) {
  const items = String(value || "")
    .split(/[,，\s]+/)
    .map((item) => item.trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, ""))
    .filter(Boolean)
    .filter((item) => DOMAIN_PATTERN.test(item));
  return [...new Set(items)];
}

export function emailDomainOf(email: string | null | undefined) {
  const text = String(email || "").trim().toLowerCase();
  const at = text.lastIndexOf("@");
  return at > 0 ? text.slice(at + 1) : "";
}

/** 列表为空 = 不限；否则邮箱域名等于某一项，或是它的子域名。 */
export function isEmailDomainAllowed(email: string | null | undefined, domains: readonly string[]) {
  if (!domains.length) return true;
  const domain = emailDomainOf(email);
  if (!domain) return false;
  return domains.some((item) => domain === item || domain.endsWith(`.${item}`));
}
