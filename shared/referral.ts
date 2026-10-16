/**
 * 邀请返利：前后端共用的那一部分纯逻辑。
 *
 * 钱全程用整数「分」，比例用整数「基点」（1 bps = 0.01%，10000 bps = 100%）。
 * 管理员在套餐编辑里填的是「12.5」这样的百分比字符串 —— 这里按字符串解析，
 * 不经过浮点：Number("0.07") * 100 是 7.000000000000001，四舍五入能糊过去，
 * 但「看起来对」和「一定对」在算钱这件事上不是一回事。
 */

/** 返利比例的上限：100%。 */
export const REFERRAL_MAX_RATE_BPS = 10_000;

export const REFERRAL_MODES = ["first", "recurring"] as const;
export type ReferralMode = typeof REFERRAL_MODES[number];

export const REFERRAL_MODE_LABELS: Record<ReferralMode, string> = {
  first: "仅首单返利",
  recurring: "每单返利（含续费）",
};

export function normalizeReferralMode(value: unknown): ReferralMode {
  return value === "recurring" ? "recurring" : "first";
}

/** 返利来源：在线支付的套餐订单 / 余额买套餐（含自动续费）。 */
export const REFERRAL_SOURCE_TYPES = ["payment_order", "balance_purchase"] as const;
export type ReferralSourceType = typeof REFERRAL_SOURCE_TYPES[number];

/**
 * 邀请码字母表：去掉了容易认错的 0 / O / 1 / I / L。
 * 邀请码常被人念出来、抄在截图里，认错一个字就绑不上。
 */
export const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 8;

const INVITE_CODE_PATTERN = new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

/**
 * 把用户输入 / 链接里带的邀请码洗成标准形式。格式不对返回 null。
 *
 * 大小写不敏感、去掉空白和连字符 —— 人手抄的时候常这么写。
 */
export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!cleaned) return null;
  return INVITE_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/**
 * 生成一个邀请码。随机源由调用方给（服务端传 crypto.randomBytes），
 * 便于测试也避免在共享代码里绑定 Node 的 crypto。
 *
 * 拒绝采样：31 个字符，256 % 31 = 8，直接取模会让前 8 个字符多出现一点。
 */
export function generateInviteCode(randomBytes: (size: number) => Uint8Array): string {
  const alphabetSize = INVITE_CODE_ALPHABET.length;
  const limit = 256 - (256 % alphabetSize);
  let code = "";
  while (code.length < INVITE_CODE_LENGTH) {
    const bytes = randomBytes(INVITE_CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      code += INVITE_CODE_ALPHABET[byte % alphabetSize];
      if (code.length === INVITE_CODE_LENGTH) break;
    }
  }
  return code;
}

/** 从注册链接的查询串里取邀请码：?invite=CODE，兼容 ?ref=CODE。 */
export function readInviteCodeFromSearch(search: string | null | undefined): string | null {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  return normalizeInviteCode(params.get("invite")) || normalizeInviteCode(params.get("ref"));
}

/** 邀请链接：注册页就是登录页的注册模式。 */
export function buildInviteLink(origin: string, code: string) {
  const base = String(origin || "").trim().replace(/\/+$/, "");
  return `${base}/login?mode=register&invite=${encodeURIComponent(code)}`;
}

/**
 * 「12.5」→ 1250 bps。允许 0 ~ 100，最多两位小数；空串按 0。
 * 解析不了（负数、三位小数、科学计数法、超过 100）返回 null，由调用方报错。
 */
export function parseRatePercentToBps(input: unknown): number | null {
  const text = String(input ?? "").trim();
  if (text === "") return 0;
  const match = /^(\d{1,5})(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) return null;
  const whole = Number.parseInt(match[1], 10);
  const fraction = Number.parseInt((match[2] || "").padEnd(2, "0"), 10);
  const bps = whole * 100 + fraction;
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > REFERRAL_MAX_RATE_BPS) return null;
  return bps;
}

/** 1250 bps →「12.5」，去掉多余的 0；用于表单回填和展示。 */
export function formatRateBps(bps: unknown): string {
  const value = normalizeRateBps(bps);
  const whole = Math.floor(value / 100);
  const fraction = value % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

/** 库里读出来的比例收进 0 ~ 10000 的整数；脏值按 0（不返利）算。 */
export function normalizeRateBps(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(REFERRAL_MAX_RATE_BPS, Math.max(0, Math.floor(numeric)));
}

/**
 * 返利金额 = floor(实付 × 比例 / 10000)，单位分。
 *
 * 向下取整：多给一分钱是平台白掏的，少给一分钱谁都不会来找。用 BigInt 乘，
 * 实付再大也不会在乘法这一步丢精度。
 */
export function computeCommissionCents(baseAmountCents: unknown, rateBps: unknown): number {
  const base = Number(baseAmountCents);
  if (!Number.isSafeInteger(base) || base <= 0) return 0;
  const rate = normalizeRateBps(rateBps);
  if (rate <= 0) return 0;
  return Number((BigInt(base) * BigInt(rate)) / BigInt(REFERRAL_MAX_RATE_BPS));
}

/**
 * 被邀请人的账号打码后再给邀请人看：alice@example.com → a***e。
 *
 * 只留本地部分的首尾两个字符，域名也不给 —— 邀请人知道「有人买了」就够了，
 * 没必要知道是谁。
 */
export function maskUsername(username: unknown): string {
  const text = String(username ?? "").trim();
  const local = text.includes("@") ? text.slice(0, text.indexOf("@")) : text;
  const chars = Array.from(local);
  if (chars.length === 0) return "***";
  if (chars.length === 1) return `${chars[0]}***`;
  return `${chars[0]}***${chars[chars.length - 1]}`;
}

export type ReferralSkipReason =
  | "disabled"
  | "no_inviter"
  | "self"
  | "inviter_inactive"
  | "rate_zero"
  | "free"
  | "non_cny"
  | "first_only"
  | "zero_commission";

export const REFERRAL_SKIP_REASON_LABELS: Record<ReferralSkipReason, string> = {
  disabled: "邀请返利未开启",
  no_inviter: "没有邀请人",
  self: "邀请人是自己",
  inviter_inactive: "邀请人已停用或已删除",
  rate_zero: "该套餐不返利",
  free: "免费订单",
  non_cny: "非人民币订单",
  first_only: "仅首单返利，已返过",
  zero_commission: "返利金额不足一分",
};

export type ReferralCommissionInput = {
  enabled: boolean;
  mode: ReferralMode;
  inviteeId: number;
  inviterId: number | null | undefined;
  /** 邀请人账号还在、且没被停用。 */
  inviterActive: boolean;
  rateBps: number;
  /** 被邀请人这一单实际付了多少（折扣之后），分。 */
  baseAmountCents: number;
  /** 订单币种。余额是人民币，在线支付的 Stripe 可能不是。 */
  currency?: string | null;
  /** 这个被邀请人之前是否已经产生过返利（首单模式用）。 */
  hasPriorCommission: boolean;
};

export type ReferralCommissionDecision =
  | { eligible: true; commissionCents: number; rateBps: number }
  | { eligible: false; reason: ReferralSkipReason };

/** 这一单该不该返、返多少。所有「不返」的理由都在这里，按顺序判断。 */
export function evaluateReferralCommission(input: ReferralCommissionInput): ReferralCommissionDecision {
  if (!input.enabled) return { eligible: false, reason: "disabled" };
  const inviterId = Number(input.inviterId || 0);
  if (!Number.isSafeInteger(inviterId) || inviterId <= 0) return { eligible: false, reason: "no_inviter" };
  if (inviterId === Number(input.inviteeId)) return { eligible: false, reason: "self" };
  if (!input.inviterActive) return { eligible: false, reason: "inviter_inactive" };
  const rateBps = normalizeRateBps(input.rateBps);
  if (rateBps <= 0) return { eligible: false, reason: "rate_zero" };
  if (!(Number(input.baseAmountCents) > 0)) return { eligible: false, reason: "free" };
  const currency = String(input.currency || "CNY").trim().toUpperCase();
  if (currency !== "CNY") return { eligible: false, reason: "non_cny" };
  if (input.mode === "first" && input.hasPriorCommission) return { eligible: false, reason: "first_only" };
  const commissionCents = computeCommissionCents(input.baseAmountCents, rateBps);
  if (commissionCents <= 0) return { eligible: false, reason: "zero_commission" };
  return { eligible: true, commissionCents, rateBps };
}
