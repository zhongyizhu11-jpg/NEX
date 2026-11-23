/**
 * 到期提醒提前几天发。
 *
 * 邮件和 Telegram 两条路原来各自写死「剩 3 天以内每天发一次」：
 *
 * - 3 天太晚。按月付的人多数是到期当天才发现断了，续费要走支付、要等回调，
 *   中间那段空窗就是投诉。
 * - 每天发一次也不对：剩 3、2、1 天各来一封，三封说的是同一件事。
 *
 * 改成「在这几个整天数上各发一次」，默认第 7、3、1 天，管理员可在系统设置里
 * 改。两条路共用这一份解析，省得改了邮件忘了 TG。
 */

/** 没配时用这几档。7 天够走一次支付，1 天是最后一次叫醒。 */
export const DEFAULT_EXPIRY_REMINDER_DAYS = [7, 3, 1];

/** 最远提前多少天 —— 再远就不是提醒，是骚扰。 */
const MAX_EXPIRY_REMINDER_DAY = 365;

/**
 * 解析「7,3,1」这种配置。
 *
 * 脏数据一律退回默认，而不是解析成空数组 —— 空数组等于一声不吭地关掉提醒，
 * 而管理员从界面上看不出自己填错了。想关提醒有单独的开关。
 */
export function parseExpiryReminderDays(raw: string | null | undefined): number[] {
  const text = String(raw ?? "").trim();
  if (!text) return [...DEFAULT_EXPIRY_REMINDER_DAYS];
  const days = Array.from(new Set(
    text
      .split(/[,，\s]+/)
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= MAX_EXPIRY_REMINDER_DAY),
  )).sort((a, b) => b - a);
  return days.length > 0 ? days : [...DEFAULT_EXPIRY_REMINDER_DAYS];
}

/**
 * 今天该不该发。
 *
 * daysLeft 是向上取整的整天数，所以「还剩 0 天」= 今天之内到期，也要发 ——
 * 那是最后一次能救回来的机会。已经过期（负数）不发：那时该做的是停服，不是提醒。
 */
export function shouldSendExpiryReminder(daysLeft: number, days: readonly number[]): boolean {
  if (!Number.isFinite(daysLeft) || daysLeft < 0) return false;
  return days.includes(Math.floor(daysLeft));
}
