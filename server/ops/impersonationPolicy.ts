/*
  代入用户后台时不能调什么。和 apiTokenPolicy.ts 一样是个不带依赖的文件：
  server/_core/trpc.ts 的中间件要引用它，不能把数据库层拖进 tRPC 的核心模块。

  代入是「管理员替用户看一眼、顺手帮他改改规则」，不是「变成这个用户」。下面这几类写操作一律拒掉：

  · 账号本身：改密码、改邮箱和资料、开关双重验证、通行密钥、已登录设备、API 令牌 ——
    代入的人不知道用户的密码，更不该能换掉它；这些要改，回管理员窗口在用户管理里改，那边有据可查。
  · 登录绑定：Telegram / Google / Discord 的绑定、解绑、设初始密码，以及各种登录入口本身
    （代入窗口里不该再登出一个新会话）。
  · 钱：发起支付、兑换码充值、用余额买套餐 / 流量包、开关自动续费。花的是用户的钱，得用户本人点。
  · 安装向导：本来就锁着，这里再挡一层。

  只挡写操作（mutation）：页面上这些区块的查询照常能看，管理员进来多半就是为了看用户眼里的样子。
  管理员过程（adminProcedure）不在这里列：代入的目标永远是普通用户，本来就调不动；
  trpc.ts 里另外再明确拒一次，不靠「目标恰好不是管理员」这一条兜着。
*/
import { IMPERSONATION_BLOCKED_MESSAGE } from "../../shared/userImpersonation";

export type ImpersonationContext = {
  /** user_impersonations.id */
  id: number;
  adminUserId: number;
  adminName: string;
  /** 到期时刻（毫秒时间戳） */
  expiresAt: number;
};

/** 以 . 结尾的是整个路由，否则是单个过程。 */
const IMPERSONATION_FORBIDDEN_MUTATIONS = [
  "auth.",
  "users.",
  "setup.",
  "telegram.",
  "googleAuth.",
  "discordAuth.",
  "ops.apiTokens.",
  "ops.passkeys.",
  "ops.sessions.",
  "payment.",
  "billing.",
  // 打开自动续费 = 以后按期从用户余额里扣钱，和付款是一回事。
  "plans.setAutoRenew",
];

/**
 * 上面整段禁掉的路由里放行的几个：
 * · auth.logout —— 代入窗口里的「退出」，只结束这一次代入（见 server/routers/auth.ts）；
 * · billing.previewDiscount —— 只是算个优惠后的价钱，不动钱。
 */
const IMPERSONATION_ALLOWED_MUTATIONS = new Set(["auth.logout", "billing.previewDiscount"]);

/** 代入会话能不能调这个过程。能返回 null，不能返回给人看的原因。 */
export function impersonationPolicyError(path: string, type: string): string | null {
  if (type === "query") return null;
  const normalizedPath = String(path || "");
  if (IMPERSONATION_ALLOWED_MUTATIONS.has(normalizedPath)) return null;
  const forbidden = IMPERSONATION_FORBIDDEN_MUTATIONS.some((rule) => (
    rule.endsWith(".") ? normalizedPath.startsWith(rule) : normalizedPath === rule
  ));
  return forbidden ? IMPERSONATION_BLOCKED_MESSAGE : null;
}
