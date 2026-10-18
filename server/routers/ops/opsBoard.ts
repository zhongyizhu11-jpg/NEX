import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { queryRaw, quoteDbIdentifier } from "../../dbRuntime";
import { lookupOfflineIpRegion } from "../../ipRegionOffline";
import { createQueryCache } from "../../queryCache";
import {
  OPS_BOARD_RANGES,
  beijingDate,
  opsBoardDays,
  opsBoardSince,
  orderStatusBucket,
  sourceAreaLabel,
  type OpsBoardRange,
  type OrderBucket,
} from "../../../shared/opsBoard";

/*
  trpc.ops.board.* —— 监控 › 看板（运维看板，参考上游 2.3.285）。只给管理员。

  一屏看完这段时间（今天 / 7 天 / 30 天，北京时间切天）：
  - 账务：各币种实收、订单按状态的分布、余额的充值和消耗、新开的订阅；
  - 流量：每天的上下行，和用量最多的几条规则；
  - 来源：连过来的公网 IP 排行和地区分布（ip_sightings + 面板自带的离线 IP 库，不发给任何第三方）。

  全部是现成的表做聚合，不新增采集；结果缓存 15 秒，开着自动刷新也不会把库打满。
*/

const q = quoteDbIdentifier;
const cache = createQueryCache(16);
const SOURCE_SCAN_LIMIT = 3000;
const TOP_SOURCES = 20;
const TOP_RULES = 8;

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function financeSummary(since: number) {
  const orders = await queryRaw<any>(
    `SELECT ${q("status")} AS status, ${q("currency")} AS currency, COUNT(*) AS n, SUM(${q("amountCents")}) AS cents
     FROM ${q("payment_orders")} WHERE ${q("createdAt")} >= ? AND ${q("orderType")} <> ?
     GROUP BY ${q("status")}, ${q("currency")}`,
    [since, "test"],
  ).catch(() => []);
  const buckets: Record<OrderBucket, number> = { completed: 0, delivering: 0, pending: 0, closed: 0 };
  const revenue = new Map<string, number>();
  for (const row of orders) {
    const bucket = orderStatusBucket(row.status);
    buckets[bucket] += num(row.n);
    if (bucket === "completed" || bucket === "delivering") {
      const currency = String(row.currency || "CNY").toUpperCase();
      revenue.set(currency, (revenue.get(currency) || 0) + num(row.cents));
    }
  }
  const balanceRows = await queryRaw<any>(
    `SELECT ${q("type")} AS type, COUNT(*) AS n, SUM(${q("amountCents")}) AS cents
     FROM ${q("balance_transactions")} WHERE ${q("createdAt")} >= ? GROUP BY ${q("type")}`,
    [since],
  ).catch(() => []);
  let balanceIn = 0;
  let balanceOut = 0;
  for (const row of balanceRows) {
    const cents = num(row.cents);
    if (cents >= 0) balanceIn += cents;
    else balanceOut += -cents;
  }
  const [subscriptions] = await queryRaw<any>(
    `SELECT COUNT(*) AS n FROM ${q("user_subscriptions")} WHERE ${q("startedAt")} >= ?`,
    [since],
  ).catch(() => [{ n: 0 }]);
  return {
    revenue: Array.from(revenue, ([currency, cents]) => ({ currency, cents })).sort((a, b) => b.cents - a.cents),
    orders: buckets,
    orderTotal: Object.values(buckets).reduce((sum, value) => sum + value, 0),
    balanceInCents: balanceIn,
    balanceOutCents: balanceOut,
    newSubscriptions: num(subscriptions?.n),
  };
}

async function trafficSummary(range: OpsBoardRange, since: number, now: number) {
  const rows = await queryRaw<any>(
    `SELECT ${q("bucketStart")} AS start, SUM(${q("bytesIn")}) AS inBytes, SUM(${q("bytesOut")}) AS outBytes
     FROM ${q("traffic_stat_buckets")} WHERE ${q("bucketStart")} >= ? GROUP BY ${q("bucketStart")}`,
    [since],
  ).catch(() => []);
  const days = new Map(opsBoardDays(range, now).map((date) => [date, { date, inBytes: 0, outBytes: 0 }]));
  for (const row of rows) {
    const start = typeof row.start === "number" ? row.start : Math.floor(new Date(row.start).getTime() / 1000);
    const day = days.get(beijingDate(start));
    if (!day) continue;
    day.inBytes += num(row.inBytes);
    day.outBytes += num(row.outBytes);
  }
  const topRows = await queryRaw<any>(
    `SELECT ${q("ruleId")} AS ruleId, SUM(${q("bytesIn")} + ${q("bytesOut")}) AS total
     FROM ${q("traffic_stat_buckets")} WHERE ${q("bucketStart")} >= ? AND ${q("ruleId")} > 0
     GROUP BY ${q("ruleId")} ORDER BY total DESC LIMIT ${TOP_RULES}`,
    [since],
  ).catch(() => []);
  const ids = topRows.map((row) => num(row.ruleId)).filter((id) => id > 0);
  const names = new Map<number, { name: string; userId: number }>();
  if (ids.length > 0) {
    const ruleRows = await queryRaw<any>(
      `SELECT ${q("id")} AS id, ${q("name")} AS name, ${q("userId")} AS userId FROM ${q("forward_rules")} WHERE ${q("id")} IN (${ids.map(() => "?").join(", ")})`,
      ids,
    ).catch(() => []);
    for (const row of ruleRows) names.set(num(row.id), { name: String(row.name || ""), userId: num(row.userId) });
  }
  const daily = Array.from(days.values());
  return {
    daily,
    totalBytes: daily.reduce((sum, day) => sum + day.inBytes + day.outBytes, 0),
    topRules: topRows.map((row) => {
      const id = num(row.ruleId);
      const info = names.get(id);
      return { ruleId: id, name: info?.name || `已删除的规则 #${id}`, deleted: !info, bytes: num(row.total) };
    }),
  };
}

async function sourceSummary(since: number) {
  const rows = await queryRaw<any>(
    `SELECT ${q("ip")} AS ip, COUNT(DISTINCT ${q("ruleId")}) AS rules, COUNT(DISTINCT ${q("userId")}) AS users,
            MAX(${q("connCount")}) AS conns, MAX(${q("lastSeenAt")}) AS lastSeen
     FROM ${q("ip_sightings")} WHERE ${q("lastSeenAt")} >= ?
     GROUP BY ${q("ip")} ORDER BY lastSeen DESC LIMIT ${SOURCE_SCAN_LIMIT}`,
    [since],
  ).catch(() => []);
  const areas = new Map<string, number>();
  const sources: Array<{ ip: string; area: string; isp: string | null; rules: number; users: number; conns: number; lastSeen: number }> = [];
  for (const row of rows) {
    const ip = String(row.ip || "");
    const geo = await lookupOfflineIpRegion(ip).catch(() => null);
    const area = sourceAreaLabel(geo);
    areas.set(area, (areas.get(area) || 0) + 1);
    const lastSeen = typeof row.lastSeen === "number" ? row.lastSeen : Math.floor(new Date(row.lastSeen).getTime() / 1000);
    sources.push({ ip, area, isp: geo?.isp || null, rules: num(row.rules), users: num(row.users), conns: num(row.conns), lastSeen });
  }
  sources.sort((a, b) => b.conns - a.conns || b.rules - a.rules || b.lastSeen - a.lastSeen);
  return {
    distinctIps: rows.length,
    truncated: rows.length >= SOURCE_SCAN_LIMIT,
    areas: Array.from(areas, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    top: sources.slice(0, TOP_SOURCES),
  };
}

export async function buildOpsBoard(range: OpsBoardRange, now = Math.floor(Date.now() / 1000)) {
  const since = opsBoardSince(range, now);
  const [finance, traffic, sources] = await Promise.all([financeSummary(since), trafficSummary(range, since, now), sourceSummary(since)]);
  return { range, since, generatedAt: now, finance, traffic, sources };
}

export const opsBoardRouter = router({
  summary: adminProcedure
    .input(z.object({ range: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7) }))
    .query(({ input }) => {
      const range = (OPS_BOARD_RANGES as readonly number[]).includes(input.range) ? input.range : 7;
      return cache.get(`board:${range}`, { ttlMs: 15_000, staleMs: 0 }, () => buildOpsBoard(range as OpsBoardRange));
    }),
});
