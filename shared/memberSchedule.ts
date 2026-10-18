import {
  describeFailoverScheduleDays,
  failoverScheduleWindowIndexAt,
  parseFailoverSchedule,
  scheduleLocalParts,
  type FailoverSchedule,
} from "./failoverSchedule";

/*
  线路按时间段启用：转发组 / 入口组 / 出口组的某个成员只在这些时段里可用。

  和主备的「时段表」（shared/failoverSchedule.ts）是两件事：时段表只决定首选哪一条，
  时段外那条线照样当备用；这里是时段外这条线**根本不用** —— 比如按流量计费的贵线路只在
  晚高峰开，其余时间连备用都不当。

  语义沿用时段表的那几条（同一套时段写法和判定）：
  · 多个时段任一命中就可用；
  · 跨午夜的时段属于它开始的那一天（「周五 20:00-02:00」覆盖到周六凌晨 2 点）；
  · 时区跟着设置存，默认 Asia/Shanghai；时区名认不出时当作「没设时段」，不按猜的时区停线路。

  实际启用 = 用户想开（成员开关）且（没设时段，或者此刻在时段里）。用户的意思和实际状态分开存：
  isEnabled 是实际状态（几十处读它，都不用改），scheduleSuspended 记「是时段让它停的」，
  进入时段时只恢复这种，用户自己手动停的不碰。
*/

export const MEMBER_SCHEDULE_DEFAULT_TIMEZONE = "Asia/Shanghai";
export const MAX_MEMBER_SCHEDULE_WINDOWS = 8;

export type MemberScheduleWindow = { days: number[]; from: string; to: string };
export type MemberActiveSchedule = { timezone: string; windows: MemberScheduleWindow[] };

/** 只有这几种组的成员能设时段：转发链有先后顺序，端口转发的成员总是启用的。 */
export const MEMBER_SCHEDULE_GROUP_MODES = ["failover", "entry", "exit"] as const;

export function groupModeSupportsMemberSchedule(mode: unknown) {
  return (MEMBER_SCHEDULE_GROUP_MODES as readonly string[]).includes(String(mode || ""));
}

function asFailoverSchedule(schedule: MemberActiveSchedule): FailoverSchedule {
  return { timezone: schedule.timezone, windows: schedule.windows.map((window) => ({ ...window, targetIndex: 0 })) };
}

/** 读库里 / 表单里的时段设置；不合法、没有有效时段都返回 null（= 不限时段）。 */
export function parseMemberSchedule(raw: unknown): MemberActiveSchedule | null {
  let value: any = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const windows = Array.isArray(value.windows) ? value.windows : [];
  const parsed = parseFailoverSchedule({
    timezone: String(value.timezone || MEMBER_SCHEDULE_DEFAULT_TIMEZONE),
    windows: windows.map((window: any) => ({ ...window, targetIndex: 0 })),
  });
  if (!parsed || !scheduleLocalParts(new Date(0), parsed.timezone)) return null;
  return {
    timezone: parsed.timezone,
    windows: parsed.windows.slice(0, MAX_MEMBER_SCHEDULE_WINDOWS).map(({ days, from, to }) => ({ days, from, to })),
  };
}

export function serializeMemberSchedule(raw: unknown): string | null {
  const schedule = parseMemberSchedule(raw);
  return schedule ? JSON.stringify(schedule) : null;
}

/** 此刻在不在可用时段里。没设时段（null）永远算在。 */
export function memberScheduleActiveAt(raw: unknown, at: Date): boolean {
  const schedule = parseMemberSchedule(raw);
  if (!schedule) return true;
  return failoverScheduleWindowIndexAt(asFailoverSchedule(schedule), at) !== null;
}

/**
 * 成员此刻实际该不该启用，和「是不是时段让它停的」。
 * intent 是用户的开关（成员开关打开 = 想用）。
 */
export function resolveMemberScheduleState(intent: boolean, schedule: unknown, at: Date) {
  const inWindow = memberScheduleActiveAt(schedule, at);
  const isEnabled = intent && inWindow;
  return { isEnabled, scheduleSuspended: intent && !isEnabled };
}

/** 用户的意思：实际开着，或者是被时段停掉的。编辑表单回显成员开关时用它，不然存一次就把时段停用变成了手动停用。 */
export function memberEnabledIntent(member: { isEnabled?: unknown; scheduleSuspended?: unknown } | null | undefined) {
  const on = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";
  return on(member?.isEnabled) || on(member?.scheduleSuspended);
}

/** 「每天 20:00-02:00」「周一、周二 09:00-18:00；周末 全天」这样的一句话。 */
export function describeMemberSchedule(raw: unknown): string {
  const schedule = parseMemberSchedule(raw);
  if (!schedule) return "不限时段";
  const text = schedule.windows.map((window) => `${describeFailoverScheduleDays(window.days)} ${window.from}-${window.to}`).join("；");
  return schedule.timezone === MEMBER_SCHEDULE_DEFAULT_TIMEZONE ? text : `${text}（${schedule.timezone}）`;
}
