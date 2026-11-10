/*
  登录页「忘记密码」（上游 v2.3.299），服务端和页面共用的几个常量。

  流程：登录页填用户名或邮箱 → 服务端把一次性重置链接发到这个账号「已验证的邮箱」和 / 或
  「已绑定的 Telegram / Discord」→ 点开链接设新密码。逻辑在 server/ops/passwordReset.ts。
*/

/** 重置链接多久过期（秒）。 */
export const PASSWORD_RESET_TTL_SECONDS = 30 * 60;
export const PASSWORD_RESET_TTL_MINUTES = PASSWORD_RESET_TTL_SECONDS / 60;

/** 重置令牌的前缀（库里只存 sha256）。 */
export const PASSWORD_RESET_TOKEN_PREFIX = "nxr_";

/** 重置链接里带令牌的那一段（放在 # 后面：不进访问日志、不进 Referer，也不会发给服务器）。 */
export const PASSWORD_RESET_HASH_PARAM = "password-reset";

/** 新密码的长度范围，和注册、改密码同一条规则（server/routers/auth.ts）。 */
export const PASSWORD_RESET_MIN_LENGTH = 6;
export const PASSWORD_RESET_MAX_LENGTH = 256;

/*
  申请之后给人看的话。账号存不存在、有没有绑找回方式，回的都是这同一句 ——
  不然谁都能拿这个接口来试「这个邮箱在不在这个面板上」。
*/
export const PASSWORD_RESET_REQUESTED_MESSAGE = `申请已提交。如果这个账号有已验证的邮箱或已绑定的 Telegram / Discord，重置链接会在几分钟内送达，${PASSWORD_RESET_TTL_MINUTES} 分钟内有效；一直没有收到，说明账号没有配置找回方式，请联系管理员重置密码。`;
export const PASSWORD_RESET_INVALID_MESSAGE = "重置链接无效、已经用过或已过期，请重新申请，或联系管理员";
export const PASSWORD_RESET_DISABLED_MESSAGE = "管理员没有开放自助找回密码，请联系管理员重置密码";
export const PASSWORD_RESET_RATE_LIMITED_MESSAGE = "操作太频繁了，请稍后再试，或联系管理员";

export type PasswordResetChannel = "email" | "telegram" | "discord";

export const PASSWORD_RESET_CHANNELS: readonly PasswordResetChannel[] = ["email", "telegram", "discord"];

export const PASSWORD_RESET_CHANNEL_LABELS: Record<PasswordResetChannel, string> = {
  email: "邮箱",
  telegram: "Telegram",
  discord: "Discord",
};
