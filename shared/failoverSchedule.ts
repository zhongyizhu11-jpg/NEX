/**
 * 主备的时段表：某几个时段里优先走哪一条出站。
 *
 * 这是「晚高峰错峰」要的东西 —— 平时走主线路，18 点到凌晨 1 点改走备用线路，第二天
 * 自动回来。和故障切换是两个正交的维度：**时段表只决定「首选是谁」，切不切得过去
 * 仍然由健康检查说了算**。18 点到了而那条线正丢包 15%，不该机械地切过去。
 *
 * 几条定死的语义，都是被现实逼出来的：
 *
 *   · **从上往下，第一条命中的说了算**。这样才能把例外写在前面（比如「周五特殊」
 *     压在「工作日」上面），顺序有意义。
 *   · **跨午夜的时段属于它开始的那一天**。`周一 18:00-01:00` 覆盖的是周一 18 点到
 *     周二凌晨 1 点，而不是周一凌晨那一段 —— 后者是周日那条窗口的尾巴。按「开始日」
 *     归属是唯一不会把人绕晕的定义。
 *   · **时区跟着规则存**。晚高峰是用户所在地的晚高峰，不是服务器的。多租户面板上
 *     不同租户的高峰时段本来就不一样。
 *
 * 判定同时存在于面板（TS）和 Agent（Go）—— Agent 必须能在面板挂掉时照常按表走。
 * 两份实现漂移的后果是「面板上显示走备线、机器上还在走主线」，所以用例表
 * failoverSchedule.cases.json 由两边共用：谁改出了偏差，谁那边的测试红。
 */

export const MAX_FAILOVER_SCHEDULE_WINDOWS = 8;

export type FailoverScheduleWindow = {
  /** 0=周日 … 6=周六。空数组表示每天。 */
  days: number[];
  /** "HH:MM"，24 小时制。 */
  from: string;
  /** "HH:MM"。小于等于 from 表示跨午夜。 */
  to: string;
  /** 这个时段首选第几条出站；0 是主线路。 */
  targetIndex: number;
};

export type FailoverSchedule = {
  /** IANA 时区名，比如 Asia/Shanghai。 */
  timezone: string;
  windows: FailoverScheduleWindow[];
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseScheduleMinutes(value: unknown): number | null {
  const match = TIME_PATTERN.exec(String(value ?? "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatScheduleMinutes(minutes: number): string {
  const total = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function sanitizeDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const days = Array.from(new Set(raw
    .map((day) => Math.floor(Number(day)))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)));
  // 七天全选等于每天，存成空数组，免得同一个意思有两种写法。
  return days.length === 7 ? [] : days.sort((left, right) => left - right);
}

export function parseFailoverSchedule(raw: unknown): FailoverSchedule | null {
  if (!raw) return null;
  let parsed: any = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const timezone = String(parsed?.timezone || "").trim();
  const rawWindows = Array.isArray(parsed?.windows) ? parsed.windows : [];
  const windows: FailoverScheduleWindow[] = [];
  for (const rawWindow of rawWindows) {
    const from = parseScheduleMinutes(rawWindow?.from);
    const to = parseScheduleMinutes(rawWindow?.to);
    const targetIndex = Math.floor(Number(rawWindow?.targetIndex));
    if (from === null || to === null) continue;
    if (!Number.isInteger(targetIndex) || targetIndex < 0) continue;
    // 起止相同的窗口没有长度，收下它等于收下一条永远不生效的设置。
    if (from === to) continue;
    windows.push({ days: sanitizeDays(rawWindow?.days), from: formatScheduleMinutes(from), to: formatScheduleMinutes(to), targetIndex });
    if (windows.length >= MAX_FAILOVER_SCHEDULE_WINDOWS) break;
  }
  if (!timezone || windows.length === 0) return null;
  return { timezone, windows };
}

export function serializeFailoverSchedule(schedule: FailoverSchedule | null | undefined): string | null {
  const normalized = parseFailoverSchedule(schedule as any);
  return normalized ? JSON.stringify(normalized) : null;
}

/** 某个时区里此刻是星期几、当天第几分钟。 */
export function scheduleLocalParts(at: Date, timezone: string): { weekday: number; minutes: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US-u-nu-latn", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    // 时区名不认识：宁可当作没有时段表，也不能按一个猜出来的时区切线路。
    return null;
  }
  const weekdayText = parts.find((part) => part.type === "weekday")?.value || "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayText);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (weekday < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { weekday, minutes: hour * 60 + minute };
}

function windowMatches(window: FailoverScheduleWindow, weekday: number, minutes: number): boolean {
  const from = parseScheduleMinutes(window.from);
  const to = parseScheduleMinutes(window.to);
  if (from === null || to === null) return false;
  const onDay = (day: number) => window.days.length === 0 || window.days.includes(day);
  if (to > from) return onDay(weekday) && minutes >= from && minutes < to;
  // 跨午夜：属于它开始的那一天，所以凌晨那一段要回头看昨天有没有开这个窗口。
  if (onDay(weekday) && minutes >= from) return true;
  return onDay((weekday + 6) % 7) && minutes < to;
}

/**
 * 此刻命中的是第几个时段；没有命中返回 null。
 *
 * 从上往下取第一条命中的：例外写在前面才有意义。策略面板要把命中的那一行高亮出来，
 * 所以单独给出「哪一行」，而不只是「走哪条」。
 */
export function failoverScheduleWindowIndexAt(
  schedule: FailoverSchedule | null | undefined,
  at: Date,
): number | null {
  if (!schedule || schedule.windows.length === 0) return null;
  const local = scheduleLocalParts(at, schedule.timezone);
  if (!local) return null;
  const index = schedule.windows.findIndex((window) => windowMatches(window, local.weekday, local.minutes));
  return index >= 0 ? index : null;
}

/** 此刻首选第几条出站；没有时段命中返回 null（也就是按原来的优先级走）。 */
export function failoverScheduleTargetIndexAt(
  schedule: FailoverSchedule | null | undefined,
  at: Date,
): number | null {
  const index = failoverScheduleWindowIndexAt(schedule, at);
  return index === null ? null : schedule!.windows[index].targetIndex;
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function describeFailoverScheduleDays(days: number[]): string {
  if (days.length === 0) return "每天";
  if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return "工作日";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "周末";
  return days.map((day) => WEEKDAY_LABELS[day] || String(day)).join("、");
}

export function describeFailoverScheduleWindow(window: FailoverScheduleWindow, targetLabel?: string): string {
  const crossesMidnight = (parseScheduleMinutes(window.to) ?? 0) <= (parseScheduleMinutes(window.from) ?? 0);
  const target = targetLabel || (window.targetIndex === 0 ? "主线路" : `备用 ${window.targetIndex}`);
  return `${describeFailoverScheduleDays(window.days)} ${window.from}-${window.to}${crossesMidnight ? "（次日）" : ""} → ${target}`;
}

/**
 * 时段表能不能用在这套主备配置上；返回错误文案，null 表示没问题。
 *
 * 两条都属于「收下了但永远不生效」这一类，而这一类比报错更糟：用户以为已经排好了，
 * 到点什么都不会发生，也没有任何地方提示他。所以宁可在保存时就拦下来。
 *
 * 放在 shared 是为了让面板和服务端说同一句话 —— 校验各写一份的话，界面放行、
 * 服务端拒绝（或者反过来）都只是时间问题。
 */
export function validateFailoverSchedule(
  schedule: FailoverSchedule | null | undefined,
  context: { strategy: string; backupCount: number },
): string | null {
  if (!schedule || schedule.windows.length === 0) return null;
  if ((context.strategy || "fallback") !== "fallback") {
    return "时段表只在主备模式下生效，请先把分配方式改成主备";
  }
  // 线路清单是「主线路 + 备用线路」，所以最大序号就是备用线路的条数。
  for (const window of schedule.windows) {
    if (window.targetIndex > context.backupCount) {
      return `时段表指向了第 ${window.targetIndex} 条出站，但一共只配了 ${context.backupCount} 条备用线路`;
    }
  }
  return null;
}

/**
 * 这次保存该带上什么样的时段表。
 *
 * 界面上可以先配好时段表、再把分配方式改成轮询 —— 这时候时段表不适用了。如果照样
 * 把它发上去，服务端会拒绝整次保存，用户看到的是「改个策略而已，怎么报了个时段表
 * 的错」。所以在这儿就归零。
 *
 * 归零的是**发出去的那一份**，不是界面上的那一份：改回主备时它还在，不用重配一遍。
 * 但保存之后确实就没了，所以界面必须提前把这句话说出来，不能等用户回来发现空了。
 */
export function failoverSchedulePayload(
  schedule: FailoverSchedule | null | undefined,
  strategy: string,
): FailoverSchedule | null {
  if (!schedule || schedule.windows.length === 0) return null;
  return (strategy || "fallback") === "fallback" ? schedule : null;
}
