/*
  管理员「进入用户后台」（代入），服务端和页面共用的几个常量。

  代入凭据是一枚只活在那个新标签页里的令牌（`nxu_` 开头），不是 cookie：管理员自己的登录 cookie
  一个字节都不动，原来的标签页照常是管理员。令牌的校验、能做什么不能做什么都在服务端
  （server/ops/impersonation.ts、server/ops/impersonationPolicy.ts）。
*/

/** 代入令牌的前缀。和 API 令牌的 `nex_`、App 会话的 JWT（eyJ…）都对不上，服务端一眼分得开。 */
export const IMPERSONATION_TOKEN_PREFIX = "nxu_";
/** 一次代入最长多久（秒）。到点作废，要继续看得回用户管理重新进。 */
export const IMPERSONATION_TTL_SECONDS = 60 * 60;

/** 代入已经结束（到期、管理员退出登录、目标账号被停用……）。页面靠这句话认出来，显示「已结束」而不是跳登录页。 */
export const IMPERSONATION_ENDED_MESSAGE = "代入已结束，请回到用户管理重新进入";
/** 代入时碰了账号安全 / 支付类操作。 */
export const IMPERSONATION_BLOCKED_MESSAGE = "代入用户后台时不能改账号安全设置或替用户付款，请让用户本人操作，或回到管理员窗口在用户管理里处理";

/** 新标签页地址里带令牌的那一段（放在 # 后面：不进访问日志、不进 Referer）。 */
export const IMPERSONATION_HASH_PARAM = "user-session";
