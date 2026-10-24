/*
  公开状态页可用率的纯计算部分（不碰数据库，便于单测）。

  时间一律是 unix 秒；「一天」按北京时间（UTC+8，没有夏令时）切。
*/

export const SHANGHAI_OFFSET_SECONDS = 8 * 3600;
export const DAY_SECONDS = 86400;

/** 北京时间的日期键 YYYY-MM-DD。 */
export function shanghaiDayKey(epochSeconds: number): string {
  const shifted = new Date((Math.floor(epochSeconds) + SHANGHAI_OFFSET_SECONDS) * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** 这一刻所在北京时间那一天的 0 点（unix 秒）。 */
export function shanghaiDayStart(epochSeconds: number): number {
  const shifted = Math.floor(epochSeconds) + SHANGHAI_OFFSET_SECONDS;
  return shifted - (((shifted % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS) - SHANGHAI_OFFSET_SECONDS;
}

/** 日期键 → 那天北京时间 0 点（unix 秒）。 */
export function shanghaiDayKeyStart(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? ms / 1000 - SHANGHAI_OFFSET_SECONDS : 0;
}

/** 把 [from, to) 按北京时间的日界切开。 */
export function splitByShanghaiDay(from: number, to: number): Array<{ day: string; seconds: number }> {
  const out: Array<{ day: string; seconds: number }> = [];
  let cursor = Math.floor(from);
  const end = Math.floor(to);
  while (cursor < end) {
    const next = Math.min(end, shanghaiDayStart(cursor) + DAY_SECONDS);
    out.push({ day: shanghaiDayKey(cursor), seconds: next - cursor });
    cursor = next;
  }
  return out;
}

/** 截至 now 的最近 n 天的日期键，旧在前。 */
export function lastShanghaiDays(nowSeconds: number, n: number): string[] {
  const today = shanghaiDayStart(nowSeconds);
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) days.push(shanghaiDayKey(today - i * DAY_SECONDS + 3600));
  return days;
}

export type Interval = [number, number];

/** 区间并集（排序 + 合并相接的）。 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as Interval).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && item[0] <= last[1]) last[1] = Math.max(last[1], item[1]);
    else out.push(item);
  }
  return out;
}

/** 两组区间的交集。 */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i][0], right[j][0]);
    const end = Math.min(left[i][1], right[j][1]);
    if (end > start) out.push([start, end]);
    if (left[i][1] < right[j][1]) i += 1;
    else j += 1;
  }
  return out;
}

/** 区间落在 [from, to) 里的秒数。 */
export function overlapSeconds(interval: Interval, from: number, to: number): number {
  return Math.max(0, Math.min(interval[1], to) - Math.max(interval[0], from));
}

/**
 * 回填：从 host_metrics 的心跳时间戳里找断线段。
 *
 * 新 Agent 连着事件流时完整心跳 5 分钟一次（agent/main.go 的 agentFullHeartbeatInterval，
 * 抖动只往下抖），老 Agent 60 秒一次，所以两条心跳之间隔了超过 gapThreshold（默认 12 分钟）
 * 就当它断过线：断线从「上一条 + expectedInterval」算到「下一条」。比这短的断线这里看不见 ——
 * 回填只覆盖功能上线前那 72 小时，之后由每分钟一次的实时采样接手。
 */
export function gapDownIntervals(
  samples: readonly number[],
  options: { gapThreshold?: number; expectedInterval?: number; until: number; currentlyOnline: boolean },
): Interval[] {
  const gapThreshold = options.gapThreshold ?? 12 * 60;
  const expected = options.expectedInterval ?? 5 * 60;
  const sorted = [...samples].sort((a, b) => a - b);
  const out: Interval[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] > gapThreshold) out.push([sorted[i - 1] + expected, sorted[i]]);
  }
  const last = sorted[sorted.length - 1];
  if (!options.currentlyOnline && last !== undefined && options.until - last > expected) {
    out.push([last + expected, options.until]);
  }
  return out;
}

/**
 * 别的主机都在报心跳的时段 —— 用来分辨「这台断了」和「面板自己停了」。
 *
 * 面板停机时所有主机一起没有心跳；如果断线段里别的主机也一条没有，那段就不算这台的断线。
 * 只有一台主机时没有参照，只能照算。
 */
export function coverageFromSamples(samples: readonly number[], halfWindow = 5 * 60): Interval[] {
  return mergeIntervals(samples.map((t) => [t - halfWindow, t + halfWindow] as Interval));
}

/**
 * 实时采样的一步：上一次采样到这一次之间这段时间算在线还是断线，以及有没有状态切换。
 *
 * 整段按「这一次」看到的状态记 —— 断线开始时间就是上一次还在线的那次采样，恢复时间就是
 * 上一次还断着的那次采样，这样事件表里的时长和每日表里的断线秒数对得上。
 * 两次采样隔得太久（面板停过、卡住过）就只记最近 fallbackSeconds，中间那段谁也不知道。
 */
export function advanceAvailabilityTick(
  prev: { online: boolean; at: number } | null,
  current: { online: boolean; at: number },
  options: { maxGapSeconds?: number; fallbackSeconds?: number } = {},
): { from: number; to: number; down: boolean; transition: "down" | "up" | null } {
  const maxGap = options.maxGapSeconds ?? 180;
  const fallback = options.fallbackSeconds ?? 60;
  const elapsed = prev ? current.at - prev.at : Number.POSITIVE_INFINITY;
  const from = elapsed > 0 && elapsed <= maxGap ? prev!.at : current.at - fallback;
  let transition: "down" | "up" | null = null;
  if (prev && prev.online && !current.online) transition = "down";
  if (prev && !prev.online && current.online) transition = "up";
  return { from, to: current.at, down: !current.online, transition };
}

export type AvailabilityDayRow = { hostId: number; day: string; downSeconds: number; observedSeconds: number };
export type AvailabilityIncidentRow = { hostId: number; startedAt: number; endedAt: number | null };

export type AvailabilityDayCell = {
  day: string;
  observedSeconds: number;
  downSeconds: number;
  /** 这天断过线的主机数 */
  hostsAffected: number;
  /** none = 没数据，up = 全天正常，partial = 有断线，major = 断线超过一成 */
  state: "none" | "up" | "partial" | "major";
};

/** 30 格每日条。只算 hostIds 里的主机（公开页能看到的那些）。 */
export function buildDayCells(rows: readonly AvailabilityDayRow[], days: readonly string[], hostIds: ReadonlySet<number>): AvailabilityDayCell[] {
  const byDay = new Map<string, { observed: number; down: number; hosts: Set<number> }>();
  for (const row of rows) {
    if (!hostIds.has(row.hostId)) continue;
    const entry = byDay.get(row.day) || { observed: 0, down: 0, hosts: new Set<number>() };
    entry.observed += Math.max(0, row.observedSeconds);
    entry.down += Math.max(0, Math.min(row.downSeconds, row.observedSeconds));
    if (row.downSeconds > 0) entry.hosts.add(row.hostId);
    byDay.set(row.day, entry);
  }
  return days.map((day) => {
    const entry = byDay.get(day);
    if (!entry || entry.observed <= 0) return { day, observedSeconds: 0, downSeconds: 0, hostsAffected: 0, state: "none" as const };
    const ratio = entry.down / entry.observed;
    return {
      day,
      observedSeconds: entry.observed,
      downSeconds: entry.down,
      hostsAffected: entry.hosts.size,
      state: entry.down <= 0 ? "up" : ratio >= 0.1 ? "major" : "partial",
    };
  });
}

/** 一段日子的总可用率；没有数据时为 null。 */
export function availabilityOfCells(cells: readonly AvailabilityDayCell[]): number | null {
  const observed = cells.reduce((sum, cell) => sum + cell.observedSeconds, 0);
  if (observed <= 0) return null;
  const down = cells.reduce((sum, cell) => sum + cell.downSeconds, 0);
  return Math.max(0, Math.min(1, 1 - down / observed));
}

/**
 * 近 24 小时的可用率。
 *
 * 断线秒数用断线事件和窗口的重叠精确算；「看着的秒数」每日表只有按天的粒度，
 * 今天整算、昨天按落在窗口里的比例折算（假设昨天的观察时间均匀分布）。
 */
export function availabilityLast24h(
  rows: readonly AvailabilityDayRow[],
  incidents: readonly AvailabilityIncidentRow[],
  hostIds: ReadonlySet<number>,
  nowSeconds: number,
): number | null {
  const from = nowSeconds - DAY_SECONDS;
  const todayStart = shanghaiDayStart(nowSeconds);
  const today = shanghaiDayKey(nowSeconds);
  const yesterday = shanghaiDayKey(todayStart - 3600);
  const yesterdayFraction = Math.max(0, Math.min(1, (todayStart - from) / DAY_SECONDS));
  let observed = 0;
  for (const row of rows) {
    if (!hostIds.has(row.hostId)) continue;
    if (row.day === today) observed += Math.max(0, row.observedSeconds);
    else if (row.day === yesterday) observed += Math.max(0, row.observedSeconds) * yesterdayFraction;
  }
  if (observed <= 0) return null;
  let down = 0;
  for (const incident of incidents) {
    if (!hostIds.has(incident.hostId)) continue;
    down += overlapSeconds([incident.startedAt, incident.endedAt ?? nowSeconds], from, nowSeconds);
  }
  return Math.max(0, Math.min(1, 1 - down / observed));
}
