import { getDatabaseKind, executeRaw, queryRaw } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { appendPanelLog } from "./_core/panelLogger";
import { onHostDeleted } from "./entityCleanup";
import { deleteExpiredHistoryRows } from "./repositories/historyRetention";
import { normalizeHostBandwidthBilling, P95_BUCKET_SECONDS, type HostRateBucket } from "../shared/hostLedger";

/*
  按 95 计费的主机：每 5 分钟一个桶，记这 5 分钟里网卡进出各多少字节（host_rate_buckets）。

  为什么不直接读 host_metrics：那张表 30 秒一行、只留 72 小时（scheduler 的历史清理），
  一个月的 95 值要一整个计费周期的 5 分钟点，三天的数据怎么算都是「样本不足」。

  只有主机设成「按 95 值计费」才记：别的机器心跳过来只多一次字符串比较，不进内存、不写库。
  记的办法和 hostLoad.ts 一样，心跳里带的是网卡累计字节数，和上一次相减得到这段时间的量，
  按时间比例摊进它跨过的桶里；一个桶走完了才写一次库（每台每 5 分钟一行 upsert）。

  要小心的地方：
  - 两次心跳隔太久（掉线、面板重启）就不摊：中间那段流量是什么时候跑的不知道，平均摊开会把
    一个尖峰抹平，全记进一个桶又会造出假尖峰。这几个桶就当没有样本，账本按覆盖率标「样本不足」。
  - 计数器变小（机器重启、网卡换了）只换基线，不算负数。
  - 面板重启时内存里那半个桶丢了：写进库的覆盖秒数就少一截，95 计算里覆盖不到一半的桶不算样本。
  - 多个面板实例同时收同一台的心跳时，各自的基线会重叠计数 —— 目前面板是单实例部署，没有处理。
*/

export const HOST_RATE_BUCKET_TABLE = "host_rate_buckets";
/** 留 40 天：够算完整一个月的 95，再多留几天给跨月对账。 */
export const HOST_RATE_BUCKET_RETENTION_DAYS = 40;
/** 两次心跳最多隔多久还摊：15 分钟（三个桶）。再长就当这一段没数据。 */
export const HOST_RATE_MAX_GAP_MS = 15 * 60 * 1000;
const MAX_TRACKED_HOSTS = 10_000;

type Baseline = { atMs: number; bytesIn: number; bytesOut: number };
type State = { baseline: Baseline; pending: Map<number, HostRateBucket> };

const states = new Map<number, State>();

function counter(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

/**
 * 把一段 [fromMs, toMs) 里的进出字节按时间比例摊进它跨过的 5 分钟桶。
 * 单独导出给测试：摊错了 95 值就跟着错，而且错得看不出来。
 */
export function splitCounterDelta(fromMs: number, toMs: number, bytesIn: number, bytesOut: number): HostRateBucket[] {
  const span = toMs - fromMs;
  if (!(span > 0)) return [];
  const bucketMs = P95_BUCKET_SECONDS * 1000;
  const pieces: HostRateBucket[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const bucketStartMs = Math.floor(cursor / bucketMs) * bucketMs;
    const pieceEnd = Math.min(toMs, bucketStartMs + bucketMs);
    const share = (pieceEnd - cursor) / span;
    pieces.push({
      bucketStart: bucketStartMs / 1000,
      bytesIn: bytesIn * share,
      bytesOut: bytesOut * share,
      coveredSeconds: (pieceEnd - cursor) / 1000,
    });
    cursor = pieceEnd;
  }
  return pieces;
}

function mergeInto(pending: Map<number, HostRateBucket>, piece: HostRateBucket) {
  const current = pending.get(piece.bucketStart);
  if (!current) {
    pending.set(piece.bucketStart, { ...piece });
    return;
  }
  current.bytesIn += piece.bytesIn;
  current.bytesOut += piece.bytesOut;
  current.coveredSeconds = Math.min(P95_BUCKET_SECONDS, current.coveredSeconds + piece.coveredSeconds);
}

/**
 * 心跳里调一次（不 await）。host 是心跳里已经读出来的主机行，不为这件事单独查库。
 * 返回这次写了几个桶（测试用）。
 */
export async function recordHostRateSample(
  host: { id?: unknown; bandwidthBilling?: unknown } | null | undefined,
  sample: { atMs: number; networkIn: unknown; networkOut: unknown },
): Promise<number> {
  const id = Math.floor(Number(host?.id));
  if (!Number.isInteger(id) || id <= 0) return 0;
  if (normalizeHostBandwidthBilling(host?.bandwidthBilling) !== "p95") {
    // 刚从 95 计费改回固定费用：把内存里那份丢掉，没写完的半个桶也不要了。
    states.delete(id);
    return 0;
  }
  const bytesIn = counter(sample.networkIn);
  const bytesOut = counter(sample.networkOut);
  if (bytesIn === null || bytesOut === null) return 0;
  const next: Baseline = { atMs: sample.atMs, bytesIn, bytesOut };
  const state = states.get(id);
  if (!state) {
    if (states.size >= MAX_TRACKED_HOSTS) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
    states.set(id, { baseline: next, pending: new Map() });
    return 0;
  }
  const previous = state.baseline;
  const gap = next.atMs - previous.atMs;
  if (gap <= 0) return 0;
  state.baseline = next;
  if (gap <= HOST_RATE_MAX_GAP_MS && bytesIn >= previous.bytesIn && bytesOut >= previous.bytesOut) {
    for (const piece of splitCounterDelta(previous.atMs, next.atMs, bytesIn - previous.bytesIn, bytesOut - previous.bytesOut)) {
      mergeInto(state.pending, piece);
    }
  }
  // 当前这个桶还没走完，留在内存里；之前的都可以落库了。
  const openBucket = Math.floor(next.atMs / 1000 / P95_BUCKET_SECONDS) * P95_BUCKET_SECONDS;
  const closed: HostRateBucket[] = [];
  for (const [start, bucket] of state.pending) {
    if (start < openBucket) {
      closed.push(bucket);
      state.pending.delete(start);
    }
  }
  if (closed.length === 0) return 0;
  try {
    await upsertHostRateBuckets(id, closed);
  } catch (error) {
    appendPanelLog("warn", `[HostRate] write failed host=${id}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
  return closed.length;
}

function upsertSql() {
  const table = q(HOST_RATE_BUCKET_TABLE);
  const cols = ["hostId", "bucketStart", "bytesIn", "bytesOut", "coveredSeconds"];
  const insert = `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (?, ?, ?, ?, ?)`;
  const capped = (sum: string) => `CASE WHEN ${sum} > ${P95_BUCKET_SECONDS} THEN ${P95_BUCKET_SECONDS} ELSE ${sum} END`;
  if (getDatabaseKind() === "mysql") {
    return `${insert} ON DUPLICATE KEY UPDATE
      ${q("bytesIn")} = ${q("bytesIn")} + VALUES(${q("bytesIn")}),
      ${q("bytesOut")} = ${q("bytesOut")} + VALUES(${q("bytesOut")}),
      ${q("coveredSeconds")} = ${capped(`${q("coveredSeconds")} + VALUES(${q("coveredSeconds")})`)}`;
  }
  const current = (column: string) => `${table}.${q(column)}`;
  const incoming = (column: string) => `excluded.${q(column)}`;
  return `${insert} ON CONFLICT (${q("hostId")}, ${q("bucketStart")}) DO UPDATE SET
    ${q("bytesIn")} = ${current("bytesIn")} + ${incoming("bytesIn")},
    ${q("bytesOut")} = ${current("bytesOut")} + ${incoming("bytesOut")},
    ${q("coveredSeconds")} = ${capped(`${current("coveredSeconds")} + ${incoming("coveredSeconds")}`)}`;
}

/** 累加进库（同一个桶写两次是加，不是覆盖：面板重启前后各记了半个桶）。 */
export async function upsertHostRateBuckets(hostId: number, buckets: readonly HostRateBucket[]) {
  const sql = upsertSql();
  for (const bucket of buckets) {
    await executeRaw(sql, [
      hostId,
      Math.floor(bucket.bucketStart),
      Math.round(Math.max(0, bucket.bytesIn)),
      Math.round(Math.max(0, bucket.bytesOut)),
      Math.round(Math.min(P95_BUCKET_SECONDS, Math.max(0, bucket.coveredSeconds))),
    ]);
  }
}

/** 一批主机从 sinceSec 起的桶。只给账本用，一次查完，不按主机循环。 */
export async function getHostRateBuckets(hostIds: readonly number[], sinceSec: number) {
  const ids = Array.from(new Set(hostIds.map((id) => Math.floor(Number(id))).filter((id) => Number.isInteger(id) && id > 0)));
  const byHost = new Map<number, HostRateBucket[]>();
  if (ids.length === 0) return byHost;
  const rows = await queryRaw<Record<string, unknown>>(
    `SELECT ${q("hostId")}, ${q("bucketStart")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("coveredSeconds")}
       FROM ${q(HOST_RATE_BUCKET_TABLE)}
      WHERE ${q("hostId")} IN (${ids.map(() => "?").join(", ")}) AND ${q("bucketStart")} >= ?
      ORDER BY ${q("hostId")} ASC, ${q("bucketStart")} ASC`,
    [...ids, Math.floor(sinceSec)],
  );
  for (const row of rows) {
    const hostId = Number(row.hostId);
    const list = byHost.get(hostId) ?? [];
    list.push({
      bucketStart: Number(row.bucketStart),
      bytesIn: Number(row.bytesIn) || 0,
      bytesOut: Number(row.bytesOut) || 0,
      coveredSeconds: Number(row.coveredSeconds) || 0,
    });
    byHost.set(hostId, list);
  }
  return byHost;
}

export async function cleanOldHostRateBuckets(nowMs = Date.now()) {
  const cutoff = Math.floor(nowMs / 1000) - HOST_RATE_BUCKET_RETENTION_DAYS * 86_400;
  return deleteExpiredHistoryRows(HOST_RATE_BUCKET_TABLE, "bucketStart", cutoff);
}

/** 测试用：清掉内存里的基线和没写完的桶。 */
export function resetHostRateStateForTest() {
  states.clear();
}

onHostDeleted((hostId) => {
  states.delete(hostId);
  void executeRaw(`DELETE FROM ${q(HOST_RATE_BUCKET_TABLE)} WHERE ${q("hostId")} = ?`, [hostId]).catch(() => undefined);
});
