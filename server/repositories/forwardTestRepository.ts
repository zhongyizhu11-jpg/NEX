import { and, desc, eq, isNull, or } from "drizzle-orm";
import { forwardTests, InsertForwardTest, tunnelLatencyStats } from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate, queryRaw, rawAffectedRows, rawEpochToDate, withDatabaseTransaction } from "../dbRuntime";
import { boolLiteral, quoteIdentifier } from "../dbCompat";
import { selfTestSweepActivity, SELF_TEST_MAX_LIFETIME_SECONDS, selfTestTimeoutSeconds } from "../selfTestTiming";

// ==================== Forward Tests ====================

export async function createForwardTest(data: InsertForwardTest) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // `message` is overwritten by the Agent's result; keep the dispatch payload
  // so timeouts, retries and batch aggregation can still read the request.
  const id = await insertAndGetId("forward_tests", { ...data, requestMessage: data.requestMessage ?? data.message } as any);
  selfTestSweepActivity.markActive();
  return id;
}

/**
 * Durable multi-hop batches: "fc-" forward chain, "tp-" tunnel hops. Every row
 * of a batch carries the batchId, so the batch can be aggregated from the
 * database alone — after a panel restart, or from the timeout sweep.
 */
export const FORWARD_CHAIN_BATCH_PREFIX = "fc-";
export const TUNNEL_PROBE_BATCH_PREFIX = "tp-";

export function isDurableForwardTestBatchId(batchId: unknown): batchId is string {
  const value = String(batchId || "");
  return value.startsWith(FORWARD_CHAIN_BATCH_PREFIX) || value.startsWith(TUNNEL_PROBE_BATCH_PREFIX);
}

/**
 * Insert all rows of a batch atomically. Until the transaction commits no
 * Agent can pull (and answer) the first hop, so a batch is never evaluated as
 * complete while later hops are still being created.
 */
export async function createForwardTestBatch(batchId: string, rows: InsertForwardTest[]) {
  if (!isDurableForwardTestBatchId(batchId)) throw new Error(`invalid forward test batch id: ${batchId}`);
  if (rows.length === 0) return [] as number[];
  return withDatabaseTransaction(async () => {
    const ids: number[] = [];
    for (const row of rows) ids.push(Number(await createForwardTest({ ...row, batchId, batchSettled: false })));
    return ids;
  });
}

/**
 * Single-winner claim of a finished batch, inside the caller's transaction.
 * Returns the batch rows (ordered by id) when every row has settled and this
 * caller won the claim; null when the batch is unknown, still running, or was
 * already aggregated by someone else (duplicate report, sweep, restart).
 */
export async function claimSettledForwardTestBatch(batchId: string) {
  if (!isDurableForwardTestBatchId(batchId)) return null;
  const q = quoteIdentifier;
  const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const rows = await queryRaw<any>(
    `SELECT * FROM ${q("forward_tests")} WHERE ${q("batchId")} = ? ORDER BY ${q("id")} ASC${lock}`,
    [batchId],
  );
  if (rows.length === 0) return null;
  if (rows.some((row) => row.status === "pending" || row.status === "running")) return null;
  const claimed = await executeRaw(
    `UPDATE ${q("forward_tests")} SET ${q("batchSettled")} = ${boolLiteral(true)}
      WHERE ${q("batchId")} = ? AND ${q("batchSettled")} = ${boolLiteral(false)}`,
    [batchId],
  );
  if (rawAffectedRows(claimed) <= 0) return null;
  return rows;
}

/** Finished-but-unaggregated batches, e.g. the panel exited between the last report and the summary. */
export async function findUnsettledFinishedForwardTestBatchIds(prefix: string, limit = 100) {
  if (prefix !== FORWARD_CHAIN_BATCH_PREFIX && prefix !== TUNNEL_PROBE_BATCH_PREFIX) return [] as string[];
  const q = quoteIdentifier;
  const rows = await queryRaw<{ batchId: string }>(
    `SELECT ${q("batchId")} FROM ${q("forward_tests")}
      WHERE ${q("batchSettled")} = ${boolLiteral(false)} AND ${q("batchId")} LIKE ?
      GROUP BY ${q("batchId")}
     HAVING SUM(CASE WHEN ${q("status")} IN ('pending', 'running') THEN 1 ELSE 0 END) = 0
      LIMIT ${Math.max(1, Math.floor(limit))}`,
    [`${prefix}%`],
  );
  return rows.map((row) => String(row.batchId));
}

/** The dispatch payload of a test row: requestMessage, or message for rows created before it existed. */
export function forwardTestRequestMessage(row: { requestMessage?: unknown; message?: unknown } | null | undefined) {
  const request = row?.requestMessage;
  if (typeof request === "string" && request.trim()) return request;
  return typeof row?.message === "string" ? row.message : null;
}

export async function hasActiveForwardTests() {
  const db = await getDb();
  if (!db) return false;
  const q = quoteIdentifier;
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")}
       FROM ${q("forward_tests")}
      WHERE ${q("status")} IN ('pending', 'running')
      LIMIT 1`,
  );
  return rows.length > 0;
}

const FORWARD_TEST_LEASE_SECONDS = 8;

function dispatchTimeoutSeconds(row: any) {
  try { return selfTestTimeoutSeconds(JSON.parse(forwardTestRequestMessage(row) ?? "null")); }
  catch { return selfTestTimeoutSeconds(null); }
}

/**
 * Pending tests, plus running tests whose delivery lease expired (lost
 * delivery). A redelivery only renews the lease: the test's deadline counts
 * from its first dispatch, and nothing older than the maximum lifetime is
 * handed out again — otherwise an Agent that keeps polling would keep
 * re-claiming a lost test and it would never time out.
 */
export async function getPendingForwardTestsByHost(hostId: number, leaseSeconds = FORWARD_TEST_LEASE_SECONDS) {
  const cutoff = Math.floor((Date.now() - Math.max(1, leaseSeconds) * 1000) / 1000);
  const rows = await queryRaw<any>(
    `SELECT *
       FROM ${quoteIdentifier("forward_tests")}
      WHERE ${quoteIdentifier("hostId")} = ?
        AND ${quoteIdentifier("createdAt")} >= ?
        AND (${quoteIdentifier("status")} = 'pending'
          OR (${quoteIdentifier("status")} = 'running' AND ${quoteIdentifier("updatedAt")} < ?))
      ORDER BY ${quoteIdentifier("createdAt")} ASC, ${quoteIdentifier("id")} ASC`,
    [hostId, Math.floor(Date.now() / 1000) - SELF_TEST_MAX_LIFETIME_SECONDS, cutoff],
  );
  const now = Math.floor(Date.now() / 1000);
  return rows.filter((row) => row.status !== "running"
    || Number(row.firstDispatchedAt ?? row.updatedAt) >= now - dispatchTimeoutSeconds(row));
}

export async function markForwardTestRunning(id: number, leaseSeconds = FORWARD_TEST_LEASE_SECONDS) {
  const db = await getDb();
  if (!db) return false;
  const q = quoteIdentifier;
  const cutoff = Math.floor((Date.now() - Math.max(1, leaseSeconds) * 1000) / 1000);
  const [row] = await queryRaw<any>(`SELECT * FROM ${q("forward_tests")} WHERE ${q("id")} = ?`, [id]);
  if (!row) return false;
  const runningCutoff = Math.floor(Date.now() / 1000) - dispatchTimeoutSeconds(row);
  const result = await executeRaw(
    `UPDATE ${q("forward_tests")}
     SET ${q("firstDispatchedAt")} = COALESCE(${q("firstDispatchedAt")}, CASE WHEN ${q("status")} = 'running' THEN ${q("updatedAt")} ELSE ? END),
         ${q("status")} = 'running',
         ${q("updatedAt")} = ?
     WHERE ${q("id")} = ?
       AND ${q("createdAt")} >= ?
       AND (${q("status")} = 'pending'
         OR (${q("status")} = 'running' AND ${q("updatedAt")} < ?
           AND COALESCE(${q("firstDispatchedAt")}, ${q("updatedAt")}) >= ?))`,
    [nowDate(), nowDate(), id, Math.floor(Date.now() / 1000) - SELF_TEST_MAX_LIFETIME_SECONDS, cutoff, runningCutoff],
  );
  const claimed = rawAffectedRows(result) > 0;
  if (claimed) selfTestSweepActivity.markActive();
  return claimed;
}

export async function updateForwardTestResult(
  id: number,
  data: {
    status: "success" | "failed" | "timeout";
    listenOk?: boolean;
    targetReachable?: boolean;
    forwardOk?: boolean;
    latencyMs?: number | null;
    message?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardTests).set({ ...data, updatedAt: nowDate() } as any).where(eq(forwardTests.id, id));
}

export async function completeForwardTestIfActive(
  id: number,
  data: Parameters<typeof updateForwardTestResult>[1],
) {
  const q = quoteIdentifier;
  const result = await executeRaw(
    `UPDATE ${q("forward_tests")}
        SET ${q("status")} = ?,
            ${q("listenOk")} = ?,
            ${q("targetReachable")} = ?,
            ${q("forwardOk")} = ?,
            ${q("latencyMs")} = ?,
            ${q("message")} = ?,
            ${q("updatedAt")} = ?
      WHERE ${q("id")} = ?
        AND ${q("status")} IN ('pending', 'running')`,
    [
      data.status,
      data.listenOk ?? false,
      data.targetReachable ?? false,
      data.forwardOk ?? false,
      data.latencyMs ?? null,
      data.message ?? null,
      nowDate(),
      id,
    ],
  );
  return rawAffectedRows(result) > 0;
}

export async function getLatestTunnelLatency(tunnelId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(tunnelLatencyStats)
    .where(and(
      eq(tunnelLatencyStats.tunnelId, tunnelId),
      or(
        isNull(tunnelLatencyStats.seriesKey),
        eq(tunnelLatencyStats.seriesKey, ""),
        eq(tunnelLatencyStats.seriesKey, "total"),
      ),
    ))
    .orderBy(desc(tunnelLatencyStats.id))
    .limit(1);
  return rows[0];
}

/** queryRaw 查出来的一行测试记录：时间列换成 Date（见 rawEpochToDate）。 */
export function withForwardTestDates<T extends Record<string, any> | undefined>(row: T): T {
  if (!row) return row;
  return { ...row, createdAt: rawEpochToDate(row.createdAt), updatedAt: rawEpochToDate(row.updatedAt) } as T;
}

export async function getLatestForwardTest(ruleId: number, options: { includeActive?: boolean } = {}) {
  const db = await getDb();
  if (!db) return undefined;
  const table = quoteIdentifier("forward_tests");
  const ruleCol = quoteIdentifier("ruleId");
  const statusCol = quoteIdentifier("status");
  const idCol = quoteIdentifier("id");
  const updatedCol = quoteIdentifier("updatedAt");
  const createdCol = quoteIdentifier("createdAt");
  const messageCol = quoteIdentifier("message");
  if (options.includeActive !== false) {
    const pendingRows = await queryRaw<any>(
      `SELECT * FROM ${table} WHERE ${ruleCol} = ? AND ${statusCol} IN ('pending', 'running') ORDER BY ${updatedCol} DESC, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
      [ruleId],
    );
    if (pendingRows[0]) return withForwardTestDates(pendingRows[0]);
  }
  const rows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${ruleCol} = ? AND ${statusCol} IN ('success', 'failed', 'timeout') ORDER BY ${updatedCol} DESC, CASE WHEN ${messageCol} LIKE '%forward-chain-hop-summary%' OR ${messageCol} LIKE '%"kind":"forward-via-tunnel"%' THEN 0 ELSE 1 END, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
    [ruleId],
  );
  return withForwardTestDates(rows[0]);
}

export async function getForwardTestById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(forwardTests).where(eq(forwardTests.id, id)).limit(1);
  return rows[0];
}

export async function cleanOldForwardTests(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("forward_tests")} WHERE ${quoteIdentifier("updatedAt")} < ?`,
    [cutoff],
  );
}

