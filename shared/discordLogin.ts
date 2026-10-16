/*
  Discord 登录（OAuth 2.0 授权码）前后端共用的一小块：回调地址怎么拼、失败码对应哪句中文。

  失败一律以 /login?discordError=<码>（绑定时是 /profile?discordError=<码>）跳回来，
  页面按码查这里的中文提示 —— URL 里只有一个短码，不会带任何令牌。

  跳回地址清洗、邮箱域名判断、面板地址归一化和 Google 登录用的是同一套（shared/googleLogin.ts）。
*/
import { isGoogleAcceptableRedirectBase, normalizePanelBaseUrl, sanitizeGoogleInviteCode } from "./googleLogin";

export const DISCORD_CALLBACK_PATH = "/api/auth/discord/callback";
export const DISCORD_START_PATH = "/api/auth/discord/start";
export const DISCORD_APP_CONFIRM_PATH = "/api/auth/discord/app-confirm";

export type DiscordLoginMode = "login" | "link" | "app";

export const DISCORD_LOGIN_ERROR_MESSAGES = {
  disabled: "管理员没有开启 Discord 登录",
  not_configured: "Discord 登录还没有配置完整，请联系管理员",
  cancelled: "已取消 Discord 登录",
  state_invalid: "登录请求已过期或无效，请重新点「使用 Discord 登录」",
  exchange_failed: "向 Discord 换取登录凭据失败，请稍后重试（面板服务器需要能访问 discord.com）",
  profile_invalid: "Discord 返回的账号信息不完整，请重试",
  email_unverified: "这个 Discord 账号的邮箱还没有验证（或没有授权邮箱），不能用来登录",
  domain_not_allowed: "这个 Discord 账号的邮箱域名不在允许范围内",
  not_linked: "这个 Discord 账号还没绑定面板账号：请先用密码登录，在 账号设置 里绑定 Discord",
  email_in_use: "这个邮箱已经有面板账号：请先用密码登录，在 账号设置 里绑定 Discord",
  registration_closed: "当前注册未开放，请联系管理员",
  invite_required: "当前仅支持邀请注册：请用邀请链接打开注册页，再点「使用 Discord 登录」",
  account_disabled: "账户已被禁用，请联系管理员",
  maintenance: "面板维护中，请稍后再来",
  linked_elsewhere: "这个 Discord 账号已经绑定了另一个面板账号",
  already_linked: "当前账号已经绑定了另一个 Discord 账号，请先解除绑定",
  link_requires_login: "请先登录面板再绑定 Discord（要在「面板公开地址」打开的面板里操作）",
  rate_limited: "操作太频繁，请稍后再试",
  app_flow_invalid: "App 登录请求已过期，请回到 App 重新点「使用 Discord 登录」",
  server_error: "Discord 登录失败，请稍后重试",
} as const;

export type DiscordLoginErrorCode = keyof typeof DISCORD_LOGIN_ERROR_MESSAGES;

export function isDiscordLoginErrorCode(value: unknown): value is DiscordLoginErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DISCORD_LOGIN_ERROR_MESSAGES, value);
}

/** 码 → 中文；认不出的码一律按「登录失败」说，不把 URL 里的任意文字原样显示出来。 */
export function discordLoginErrorMessage(code: unknown) {
  return isDiscordLoginErrorCode(code) ? DISCORD_LOGIN_ERROR_MESSAGES[code] : DISCORD_LOGIN_ERROR_MESSAGES.server_error;
}

/** 邀请码规则和 Google 登录、注册页一样：字母数字 4~32 位，别的一律当没带。 */
export const sanitizeDiscordInviteCode = sanitizeGoogleInviteCode;

/** 要填进 Discord Developer Portal › OAuth2 › Redirects 的那一串。没配面板公开地址时返回空串。 */
export function buildDiscordRedirectUri(panelPublicUrl: string | null | undefined) {
  const base = normalizePanelBaseUrl(panelPublicUrl);
  return base ? `${base}${DISCORD_CALLBACK_PATH}` : "";
}

/**
 * 回调地址只接受 https（localhost / 127.0.0.1 例外，本机调试用）。
 * Discord 自己允许 http 回调，但授权码和登录 cookie 走明文太容易被截，面板这边不放行。
 */
export function isDiscordAcceptableRedirectBase(panelPublicUrl: string | null | undefined) {
  return isGoogleAcceptableRedirectBase(panelPublicUrl);
}

/** Discord 的用户 ID / 应用 ID 是「雪花」：一串十进制数字（现在是 17~20 位）。 */
export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{15,25}$/.test(value);
}
