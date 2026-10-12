/*
  Telegram 每日简报：可调的发送钟点 + 管理员简报里可选的几块内容（设置 › Telegram 底部）。

  telegramBot.ts 里原来的简报正文一字不动，只在管理员那一份末尾接上这里拼出来的几行
  （buildOpsDigestExtraLines）；一块都没开时返回空数组，简报和以前完全一样。

  每块各自 try：某一块的数据取不到（比如安全巡检表还不存在），只是少这一块，
  整份简报照发。
*/
import * as db from "../db";
import { quoteDbIdentifier, queryRaw } from "../dbRuntime";
import { getAllSettings, setSettings } from "../repositories/settingsRepository";
import { getHostNamesByIds } from "../repositories/hostRepository";
import { getUserDisplayNamesByIds } from "../repositories/userRepository";
import { isHostConsideredOnline } from "../hostHeartbeatPolicy";
import { formatBytes } from "../../shared/formatBytes";
import { billingStartOfCalendarDay } from "../../shared/billingTime";
import { formatOutageDuration } from "../../shared/opsEvents";
import { normalizeDigestHour, parseDigestBlocks, type DigestBlockKey } from "../../shared/opsDigest";
import { listPanelEvents } from "./panelEvents";
import { summarizeOutages } from "./digestFormat";

const KEY_HOUR = "ops.digest.hour";
const KEY_BLOCKS = "ops.digest.blocks";
const TRAFFIC_BUCKET_MINUTES = 30;

export type DigestSettings = { hour: number; blocks: DigestBlockKey[] };

export async function getDigestSettings(): Promise<DigestSettings> {
  const settings = await getAllSettings().catch(() => ({} as Record<string, string | null>));
  return { hour: normalizeDigestHour(settings[KEY_HOUR]), blocks: parseDigestBlocks(settings[KEY_BLOCKS]) };
}

export async function getDigestHour(): Promise<number> {
  return (await getDigestSettings()).hour;
}

export async function saveDigestSettings(input: { hour: number; blocks: readonly string[] }): Promise<DigestSettings> {
  await setSettings({
    [KEY_HOUR]: String(normalizeDigestHour(input.hour)),
    [KEY_BLOCKS]: parseDigestBlocks(input.blocks).join(","),
  });
  return getDigestSettings();
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function short(value: unknown, max = 14) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function seconds(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const n = Number(value);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function dayWord(days: number) {
  return days <= 0 ? "今天" : days === 1 ? "明天" : `${days} 天后`;
}

/** 今天（北京时间）各主机 / 各用户的转发流量，读 30 分钟桶（三天内的桶都在）。 */
async function todayTrafficBy(column: "hostId" | "userId", nowMs: number, limit?: number) {
  const q = quoteDbIdentifier;
  const since = Math.floor(billingStartOfCalendarDay(nowMs).getTime() / 1000);
  const rows = await queryRaw<any>(
    `SELECT ${q(column)} AS ${q("id")}, SUM(${q("bytesIn")}) + SUM(${q("bytesOut")}) AS ${q("total")}
       FROM ${q("traffic_stat_buckets")}
      WHERE ${q("bucketMinutes")} = ? AND ${q("bucketStart")} >= ?
      GROUP BY ${q(column)}
      ORDER BY ${q("total")} DESC${limit ? ` LIMIT ${Math.floor(limit)}` : ""}`,
    [TRAFFIC_BUCKET_MINUTES, since],
  );
  return rows
    .map((row) => ({ id: Number(row.id), total: Math.max(0, Number(row.total) || 0) }))
    .filter((row) => row.id > 0 && row.total > 0);
}

async function hostTrafficLines(nowMs: number): Promise<string[]> {
  const [today, cycle, hosts] = await Promise.all([
    todayTrafficBy("hostId", nowMs),
    db.getHostTrafficSummary(),
    db.getHosts() as Promise<any[]>,
  ]);
  const todayBy = new Map(today.map((row) => [row.id, row.total]));
  const monthBy = new Map((cycle as any[]).map((row) => [Number(row.hostId), Number(row.bytesIn || 0) + Number(row.bytesOut || 0)]));
  const rows = hosts
    .map((host) => ({ host, today: todayBy.get(Number(host.id)) || 0, month: monthBy.get(Number(host.id)) || 0 }))
    .filter((row) => row.today > 0 || row.month > 0)
    .sort((a, b) => b.today - a.today || b.month - a.month);
  if (rows.length === 0) return ["🖥 各主机流量：今天还没有流量"];
  const lines = ["🖥 各主机流量（今日 / 本月）："];
  for (const row of rows.slice(0, 10)) {
    lines.push(`  · ${escapeHtml(short(row.host.name || row.host.ip))}：${escapeHtml(formatBytes(row.today))} / ${escapeHtml(formatBytes(row.month))}`);
  }
  if (rows.length > 10) lines.push(`  · 其余 ${rows.length - 10} 台在面板里看`);
  return lines;
}

async function topUserLines(nowMs: number): Promise<string[]> {
  const top = await todayTrafficBy("userId", nowMs, 5);
  if (top.length === 0) return ["👥 今天还没有用户产生流量"];
  const names = await getUserDisplayNamesByIds(top.map((row) => row.id));
  return [
    "👥 今日流量前五：",
    ...top.map((row, index) => `  ${index + 1}. ${escapeHtml(short(names.get(row.id) || `#${row.id}`))}：${escapeHtml(formatBytes(row.total))}`),
  ];
}

async function availabilityLines(nowMs: number): Promise<string[]> {
  const now = Math.floor(nowMs / 1000);
  const windowStart = now - 24 * 3600;
  const events = await listPanelEvents({ kindPrefix: "host.o", sinceSeconds: windowStart, limit: 500 });
  const summaries = summarizeOutages(events
    .filter((event) => !!event.hostId)
    .map((event) => ({
      id: event.id,
      hostId: event.hostId!,
      kind: event.kind,
      at: Math.floor(event.createdAt.getTime() / 1000),
      offlineSince: Number(event.kind === "host.offline" ? event.data?.lastSeenAt : event.data?.offlineSince) || null,
    })), windowStart, now);
  if (summaries.length === 0) return ["📶 过去 24 小时没有主机掉线"];
  const names = await getHostNamesByIds(summaries.map((summary) => summary.hostId));
  const lines = [`📶 过去 24 小时掉线 ${summaries.length} 台：`];
  for (const summary of summaries.slice(0, 8)) {
    const name = escapeHtml(short(names.get(summary.hostId) || `#${summary.hostId}`));
    const duration = formatOutageDuration(summary.totalSeconds);
    lines.push(summary.ongoing
      ? `  · ${name}：${summary.count > 1 ? `${summary.count} 次，` : ""}<b>仍未恢复</b>（已断 ${duration}）`
      : `  · ${name}：${summary.count} 次，共 ${duration}`);
  }
  if (summaries.length > 8) lines.push(`  · 其余 ${summaries.length - 8} 台在「监控 › 事件」里看`);
  return lines;
}

async function offlineNowLines(nowMs: number): Promise<string[]> {
  const hosts = (await db.getHosts() as any[]).filter((host) => !isHostConsideredOnline(host));
  if (hosts.length === 0) return ["🟢 此刻没有离线的主机"];
  const now = Math.floor(nowMs / 1000);
  const rows = hosts
    .map((host) => ({ host, since: seconds(host.lastHeartbeat) }))
    .sort((a, b) => (a.since || Infinity) - (b.since || Infinity));
  const lines = [`🔴 此刻离线 ${hosts.length} 台：`];
  for (const row of rows.slice(0, 15)) {
    lines.push(`  · ${escapeHtml(short(row.host.name || row.host.ip))}${row.since > 0 ? `（${formatOutageDuration(now - row.since)}）` : "（从未连上）"}`);
  }
  if (rows.length > 15) lines.push(`  · 其余 ${rows.length - 15} 台在面板里看`);
  return lines;
}

async function expiringLines(nowMs: number): Promise<string[]> {
  const q = quoteDbIdentifier;
  const now = Math.floor(nowMs / 1000);
  const horizon = now + 3 * 86400;
  const [subscriptions, accountRows, hosts] = await Promise.all([
    queryRaw<any>(
      `SELECT ${q("userId")}, ${q("expiresAt")} FROM ${q("user_subscriptions")}
        WHERE ${q("status")} = 'active' AND ${q("expiresAt")} IS NOT NULL AND ${q("expiresAt")} > ? AND ${q("expiresAt")} <= ?`,
      [now, horizon],
    ).catch(() => [] as any[]),
    queryRaw<any>(
      `SELECT ${q("id")} AS ${q("userId")}, ${q("expiresAt")} FROM ${q("users")}
        WHERE ${q("role")} <> 'admin' AND ${q("expiresAt")} IS NOT NULL AND ${q("expiresAt")} > ? AND ${q("expiresAt")} <= ?`,
      [now, horizon],
    ).catch(() => [] as any[]),
    db.getHosts() as Promise<any[]>,
  ]);
  // 同一个人的套餐和账户到期往往是同一个时间：按人去重，取最早的那个
  const userExpiry = new Map<number, number>();
  for (const row of [...subscriptions, ...accountRows]) {
    const userId = Number(row.userId);
    const at = seconds(row.expiresAt);
    if (userId > 0 && at > 0 && (!userExpiry.has(userId) || at < userExpiry.get(userId)!)) userExpiry.set(userId, at);
  }
  const hostRows = hosts
    .map((host) => ({ host, at: seconds(host.stoppedAt) }))
    .filter((row) => row.at > now && row.at <= horizon)
    .sort((a, b) => a.at - b.at);
  if (userExpiry.size === 0 && hostRows.length === 0) return ["⏰ 3 天内没有要到期的套餐和主机"];
  const names = await getUserDisplayNamesByIds(Array.from(userExpiry.keys()));
  const users = Array.from(userExpiry.entries()).sort((a, b) => a[1] - b[1]);
  const lines = ["⏰ 3 天内到期："];
  for (const [userId, at] of users.slice(0, 8)) {
    lines.push(`  · 用户 ${escapeHtml(short(names.get(userId) || `#${userId}`))}：${dayWord(Math.floor((at - now) / 86400))}`);
  }
  if (users.length > 8) lines.push(`  · 其余 ${users.length - 8} 个用户`);
  for (const row of hostRows.slice(0, 5)) {
    lines.push(`  · 主机 ${escapeHtml(short(row.host.name || row.host.ip))}：${dayWord(Math.floor((row.at - now) / 86400))}`);
  }
  if (hostRows.length > 5) lines.push(`  · 其余 ${hostRows.length - 5} 台主机`);
  return lines;
}

async function lowQuotaLines(): Promise<string[]> {
  const users = (await db.getUserTrafficSummaries() as any[])
    .filter((user) => user.role !== "admin" && user.accountEnabled !== false && Number(user.trafficLimit) > 0)
    .map((user) => {
      const limit = Number(user.trafficLimit);
      const left = Math.max(0, limit - Math.max(0, Number(user.trafficUsed) || 0));
      return { user, percent: (left / limit) * 100 };
    })
    .filter((row) => row.percent < 10)
    .sort((a, b) => a.percent - b.percent);
  if (users.length === 0) return ["🔋 没有流量快用完的用户"];
  const lines = [`🪫 流量剩余不到 10%：${users.length} 人`];
  for (const row of users.slice(0, 8)) {
    lines.push(`  · ${escapeHtml(short(row.user.name || row.user.username))}：${row.percent <= 0 ? "<b>已用完</b>" : `剩 ${Math.max(1, Math.floor(row.percent))}%`}`);
  }
  if (users.length > 8) lines.push(`  · 其余 ${users.length - 8} 人`);
  return lines;
}

/**
 * 未处理的安全巡检问题数。巡检表（host_security_findings）由安全巡检功能建，
 * 列名按「status = 'open'」或「resolvedAt 为空」两种写法试；表不存在或都对不上就整块不出。
 */
async function securityLines(): Promise<string[]> {
  const q = quoteDbIdentifier;
  const table = q("host_security_findings");
  const attempts = [
    `SELECT COUNT(*) AS ${q("n")} FROM ${table} WHERE ${q("status")} = 'open'`,
    `SELECT COUNT(*) AS ${q("n")} FROM ${table} WHERE ${q("resolvedAt")} IS NULL`,
  ];
  for (const sql of attempts) {
    try {
      const rows = await queryRaw<any>(sql);
      const count = Number(rows[0]?.n) || 0;
      return [count > 0 ? `🛡 安全巡检：<b>${count}</b> 条问题待处理` : "🛡 安全巡检：没有待处理的问题"];
    } catch {
      // 换一种写法再试；PostgreSQL 上失败的语句不影响下一条（不在事务里）
    }
  }
  return [];
}

const BLOCK_BUILDERS: Record<DigestBlockKey, (nowMs: number) => Promise<string[]>> = {
  hostTraffic: hostTrafficLines,
  topUsers: topUserLines,
  availability: availabilityLines,
  offlineNow: offlineNowLines,
  expiring: expiringLines,
  lowQuota: () => lowQuotaLines(),
  security: () => securityLines(),
};

/** 管理员简报末尾追加的几行（已转义成 Telegram HTML）。一块都没开时是空数组。 */
export async function buildOpsDigestExtraLines(nowMs = Date.now()): Promise<string[]> {
  const { blocks } = await getDigestSettings();
  if (blocks.length === 0) return [];
  const lines: string[] = [];
  for (const block of blocks) {
    try {
      const part = await BLOCK_BUILDERS[block](nowMs);
      if (part.length > 0) lines.push(...part);
    } catch (error) {
      console.warn(`[Digest] block ${block} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines;
}

