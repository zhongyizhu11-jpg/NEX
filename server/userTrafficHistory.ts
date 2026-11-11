/*
  管理员看某个用户的流量历史（用户管理 → 流量历史）。

  数据从哪来：已有的 traffic_stat_buckets（规则流量的 30 分钟桶，只留 72 小时）。这里不新增任何采集，
  只是每 10 分钟把最近 3 天的桶按「用户 × 规则 × 天」重算一遍，写进 user_traffic_daily（留 100 天，
  见 server/ops/userTrafficDailyTables.ts），这样 30 / 90 天的走势在桶过期以后还看得到。
  天按面板的计费时区（shared/billingTime.ts）切，和账单、流量重置用的是同一个「今天」。

  重算是「删掉最近 3 天再整段写回」：同一段数据算几遍结果都一样，面板重启、漏跑一轮都不会重复计数。
  这个功能上线之前的日子没有数据（桶早就过期了）—— 界面上写明「从哪天开始有记录」。
*/
import { billingCalendarParts, billingStartOfCalendarDay } from "../shared/billingTime";
import { boolLiteral, inList, quoteIdentifier } from "./dbCompat";
import { executeRaw, queryRaw, withDatabaseTransaction } from "./dbRuntime";

const TABLE = "user_traffic_daily";
const BUCKET_MINUTES = 30;
/** 每轮重算最近几天（今天 + 前两天）：桶留 72 小时，正好整天盖得住。 */
const RECOMPUTE_DAYS = 3;
export const USER_TRAFFIC_DAILY_RETENTION_DAYS = 100;
const ROLLUP_INTERVAL_MS = 10 * 60_000;
const INSERT_CHUNK = 200;
const DAY_MS = 24 * 3600 * 1000;

const q = quoteIdentifier;

function sec(value: Date | number) {
  return Math.floor((value instanceof Date ? value.getTime() : value) / 1000);
}

export function billingDayKey(daySec: number) {
  const parts = billingCalendarParts(daySec * 1000);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** 从 now 往前数 count 天（含今天）每一天的起点（秒，计费时区），旧的在前。 */
export function billingDayStarts(count: number, now = new Date()) {
  const today = billingStartOfCalendarDay(now);
  const out: number[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    // 每次从「今天中午」往回退，跨夏令时也落在对的那一天
    out.push(sec(billingStartOfCalendarDay(today.getTime() + 12 * 3600 * 1000 - index * DAY_MS)));
  }
  return out;
}

type DailyRow = { userId: number; ruleId: number; dayStart: number; bytesIn: number; bytesOut: number };

/** 把桶聚到天：bucketStart（秒）→ 计费时区里那一天的起点。 */
export function aggregateBucketsByDay(rows: ReadonlyArray<{ userId: unknown; ruleId: unknown; bucketStart: unknown; bytesIn: unknown; bytesOut: unknown }>): DailyRow[] {
  const out = new Map<string, DailyRow>();
  const dayCache = new Map<number, number>();
  for (const row of rows) {
    const userId = Math.floor(Number(row.userId));
    const ruleId = Math.max(0, Math.floor(Number(row.ruleId) || 0));
    const bucketStart = Math.floor(Number(row.bucketStart));
    if (!(userId > 0) || !(bucketStart > 0)) continue;
    // 同一天的桶很多：按 30 分钟起点缓存一下换算结果
    let dayStart = dayCache.get(bucketStart);
    if (dayStart === undefined) {
      dayStart = sec(billingStartOfCalendarDay(bucketStart * 1000));
      dayCache.set(bucketStart, dayStart);
    }
    const key = `${userId}:${ruleId}:${dayStart}`;
    const item = out.get(key) || { userId, ruleId, dayStart, bytesIn: 0, bytesOut: 0 };
    item.bytesIn += Math.max(0, Number(row.bytesIn) || 0);
    item.bytesOut += Math.max(0, Number(row.bytesOut) || 0);
    out.set(key, item);
  }
  return Array.from(out.values());
}

/** 重算最近 3 天（幂等）。返回写了几行。 */
export async function rollupUserTrafficDaily(now = new Date()) {
  const firstDay = billingDayStarts(RECOMPUTE_DAYS, now)[0];
  // 转发组成员的子规则记到模板规则上（和仪表盘按用户算流量是同一个口径）
  const buckets = await queryRaw<{ userId: unknown; ruleId: unknown; bucketStart: unknown; bytesIn: unknown; bytesOut: unknown }>(
    `SELECT b.${q("userId")} AS ${q("userId")},
            COALESCE(parent.${q("id")}, b.${q("ruleId")}) AS ${q("ruleId")},
            b.${q("bucketStart")} AS ${q("bucketStart")},
            SUM(b.${q("bytesIn")}) AS ${q("bytesIn")},
            SUM(b.${q("bytesOut")}) AS ${q("bytesOut")}
       FROM ${q("traffic_stat_buckets")} b
       LEFT JOIN ${q("forward_rules")} fr ON fr.${q("id")} = b.${q("ruleId")}
       LEFT JOIN ${q("forward_rules")} parent
              ON parent.${q("id")} = fr.${q("forwardGroupRuleId")}
             AND parent.${q("forwardGroupId")} = fr.${q("forwardGroupId")}
             AND parent.${q("isForwardGroupTemplate")} = ${boolLiteral(true)}
      WHERE b.${q("bucketMinutes")} = ? AND b.${q("bucketStart")} >= ? AND b.${q("userId")} > 0
      GROUP BY b.${q("userId")}, COALESCE(parent.${q("id")}, b.${q("ruleId")}), b.${q("bucketStart")}`,
    [BUCKET_MINUTES, firstDay],
  );
  const daily = aggregateBucketsByDay(buckets).filter((row) => row.dayStart >= firstDay);
  const updatedAt = sec(now);
  await withDatabaseTransaction(async () => {
    await executeRaw(`DELETE FROM ${q(TABLE)} WHERE ${q("dayStart")} >= ?`, [firstDay]);
    for (let index = 0; index < daily.length; index += INSERT_CHUNK) {
      const chunk = daily.slice(index, index + INSERT_CHUNK);
      await executeRaw(
        `INSERT INTO ${q(TABLE)} (${q("userId")}, ${q("ruleId")}, ${q("dayStart")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("updatedAt")})
         VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
        chunk.flatMap((row) => [row.userId, row.ruleId, row.dayStart, row.bytesIn, row.bytesOut, updatedAt]),
      );
    }
  });
  await executeRaw(`DELETE FROM ${q(TABLE)} WHERE ${q("dayStart")} < ?`, [sec(now) - USER_TRAFFIC_DAILY_RETENTION_DAYS * 24 * 3600]);
  lastRollupAt = Date.now();
  return daily.length;
}

let lastRollupAt = 0;
let rollupRunning: Promise<number> | null = null;

/** 查询前顺手补一轮（一分钟内跑过就不跑），今天的数字不会落后 10 分钟。 */
export async function ensureFreshUserTrafficDaily() {
  if (Date.now() - lastRollupAt < 60_000) return;
  if (!rollupRunning) rollupRunning = rollupUserTrafficDaily().finally(() => { rollupRunning = null; });
  await rollupRunning.catch((error) => console.warn(`[UserTraffic] rollup failed: ${error instanceof Error ? error.message : String(error)}`));
}

let jobStarted = false;

/** 由 server/scheduler.ts 的 startScheduler() 调一次。 */
export function startUserTrafficDailyJob() {
  if (jobStarted) return;
  jobStarted = true;
  const tick = () => {
    if (rollupRunning) return;
    rollupRunning = rollupUserTrafficDaily().finally(() => { rollupRunning = null; });
    rollupRunning.catch((error) => console.warn(`[UserTraffic] rollup failed: ${error instanceof Error ? error.message : String(error)}`));
  };
  const first = setTimeout(() => {
    tick();
    const timer = setInterval(tick, ROLLUP_INTERVAL_MS);
    timer.unref?.();
  }, 60_000);
  first.unref?.();
}

export type UserTrafficHistory = {
  days: Array<{ day: string; dayStart: number; bytesIn: number; bytesOut: number }>;
  totals: { bytesIn: number; bytesOut: number };
  topRules: Array<{ ruleId: number; name: string; deleted: boolean; bytesIn: number; bytesOut: number }>;
  /** 这个面板最早从哪天开始有日记录（功能上线前的日子是空的）。 */
  recordedSince: string | null;
};

export async function getUserTrafficHistory(userId: number, days: number, now = new Date()): Promise<UserTrafficHistory> {
  const count = Math.max(1, Math.min(USER_TRAFFIC_DAILY_RETENTION_DAYS, Math.floor(days)));
  const starts = billingDayStarts(count, now);
  const since = starts[0];
  const rows = await queryRaw<Record<string, unknown>>(
    `SELECT ${q("ruleId")}, ${q("dayStart")}, ${q("bytesIn")}, ${q("bytesOut")} FROM ${q(TABLE)} WHERE ${q("userId")} = ? AND ${q("dayStart")} >= ?`,
    [userId, since],
  );
  const byDay = new Map<number, { bytesIn: number; bytesOut: number }>();
  const byRule = new Map<number, { bytesIn: number; bytesOut: number }>();
  for (const row of rows) {
    const dayStart = Math.floor(Number(row.dayStart));
    const bytesIn = Number(row.bytesIn) || 0;
    const bytesOut = Number(row.bytesOut) || 0;
    const day = byDay.get(dayStart) || { bytesIn: 0, bytesOut: 0 };
    day.bytesIn += bytesIn;
    day.bytesOut += bytesOut;
    byDay.set(dayStart, day);
    const ruleId = Number(row.ruleId) || 0;
    const rule = byRule.get(ruleId) || { bytesIn: 0, bytesOut: 0 };
    rule.bytesIn += bytesIn;
    rule.bytesOut += bytesOut;
    byRule.set(ruleId, rule);
  }
  const top = Array.from(byRule.entries())
    .sort((a, b) => (b[1].bytesIn + b[1].bytesOut) - (a[1].bytesIn + a[1].bytesOut))
    .slice(0, 10);
  const ids = top.map(([id]) => id).filter((id) => id > 0);
  const list = inList(ids);
  const names = new Map<number, string>(
    ids.length > 0
      ? (await queryRaw<Record<string, unknown>>(`SELECT ${q("id")}, ${q("name")} FROM ${q("forward_rules")} WHERE ${q("id")} IN ${list.sql}`, list.params)).map((row) => [Number(row.id), String(row.name || "")])
      : [],
  );
  const earliest = await queryRaw<Record<string, unknown>>(`SELECT MIN(${q("dayStart")}) AS ${q("first")} FROM ${q(TABLE)}`).catch(() => []);
  const first = Number(earliest[0]?.first) || 0;
  const daysOut = starts.map((dayStart) => ({ day: billingDayKey(dayStart), dayStart, ...(byDay.get(dayStart) || { bytesIn: 0, bytesOut: 0 }) }));
  return {
    days: daysOut,
    totals: daysOut.reduce((acc, item) => ({ bytesIn: acc.bytesIn + item.bytesIn, bytesOut: acc.bytesOut + item.bytesOut }), { bytesIn: 0, bytesOut: 0 }),
    topRules: top.map(([ruleId, value]) => ({
      ruleId,
      name: names.get(ruleId) || (ruleId > 0 ? `已删除的规则 #${ruleId}` : "未知规则"),
      deleted: !names.has(ruleId),
      ...value,
    })),
    recordedSince: first > 0 ? billingDayKey(first) : null,
  };
}
