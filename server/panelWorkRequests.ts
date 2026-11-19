import { executeRaw, getDatabaseKind, queryRaw, rawAffectedRows } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";
import { databaseNowMsSql, isPanelBackgroundLeaseHolder, onPanelBackgroundLeaseChange, panelHasOtherLiveInstances } from "./panelLease";

/*
  非持有实例交给持有实例的活（panel_work_requests 表）。

  Agent 只连一个面板实例：连在非持有实例上的 Agent 报上来的健康变化、在非持有实例上点的「立即同步」，
  都要由持有实例去评估、写 DNS（两个实例各评估一份就是两个评估器抢解析，见 panelLease.ts）。
  非持有实例把「哪个组要评估、带什么选项」写成一行（同一件事只留一行，后来的覆盖前面的），持有实例每 2 秒取走，
  按种类交给登记的处理函数。

  取走的规矩（评审 F7）：
    · 先认领（nextAttemptAt = 现在 + 认领时长），处理函数跑成功了才删；以前是先删再跑，跑失败 / 进程在跑的时候
      退出，这件事就没了。认领到期还没删（持有者跑到一半没了）的，下一任接着跑。
    · 失败按 2 秒起、翻倍、最多 1 分钟退避重试（attempts 记次数），不只是记一行日志。
    · 删的时候按 requestedAt 条件删：跑的时候又有人请求的，那一行留着下一轮再跑（新请求把退避清零）。
    · 时刻都用库的时钟（和租约一样，panelLease.ts 的 databaseNowMsSql）：放了 10 分钟还没跑成的丢掉，
      「10 分钟」不受各实例时钟差的影响。

  只有一个实例时持有者不轮询（没人会写），拿到租约那一刻补取一次，防着上一任没取完。
*/

export const PANEL_WORK_POLL_INTERVAL_MS = 2_000;
/** 放了这么久还没跑成的不再执行（持有者长时间不在时，回来按巡检重新算，不补旧请求）。 */
export const PANEL_WORK_REQUEST_MAX_AGE_MS = 10 * 60_000;
/** 认领后这么久还没删（跑的实例没了）就算没人在跑，可以重新认领。 */
export const PANEL_WORK_CLAIM_MS = 2 * 60_000;
export const PANEL_WORK_RETRY_BASE_MS = 2_000;
export const PANEL_WORK_RETRY_MAX_MS = 60_000;

/** ageMs：从请求写进来到现在过了多久（库的时钟算，和各实例的时钟差无关）。 */
export type PanelWorkContext = { ageMs: number };
type Handler = (key: string, payload: unknown, context: PanelWorkContext) => Promise<void> | void;
const handlers = new Map<string, Handler>();

export function registerPanelWorkHandler(kind: string, handler: Handler) {
  handlers.set(kind, handler);
}

function requestName(kind: string, key: string | number) {
  return `${kind}:${String(key)}`;
}

/** 测试用：在库的时钟上加一个偏移（毫秒），模拟时间过去。 */
let clockOffsetMs = 0;
export function setPanelWorkClockOffsetForTests(offsetMs: number) {
  clockOffsetMs = Math.round(offsetMs) || 0;
}

function databaseClock() {
  return `(${databaseNowMsSql()} + ${clockOffsetMs})`;
}

export function panelWorkRetryDelayMs(attempts: number) {
  return Math.min(PANEL_WORK_RETRY_MAX_MS, PANEL_WORK_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(20, attempts - 1)));
}

/** 交给持有实例。同一 kind + key 只留最新一份（退避清零，下一轮就跑）。 */
export async function requestPanelWork(kind: string, key: string | number, payload: unknown = null) {
  const q = quoteIdentifier;
  const table = q("panel_work_requests");
  const name = requestName(kind, key);
  const body = payload === null || payload === undefined ? null : JSON.stringify(payload);
  const now = databaseClock();
  const requestedAt = q("requestedAt");
  // requestedAt 只增不减（同一毫秒里的第二个请求也要让「按 requestedAt 条件删」认出来）。
  const sql = getDatabaseKind() === "mysql"
    ? `INSERT INTO ${table} (${q("name")}, ${q("payload")}, ${requestedAt}, ${q("nextAttemptAt")}, ${q("attempts")}) VALUES (?, ?, ${now}, 0, 0)
        ON DUPLICATE KEY UPDATE ${q("payload")} = VALUES(${q("payload")}),
          ${requestedAt} = CASE WHEN VALUES(${requestedAt}) > ${requestedAt} THEN VALUES(${requestedAt}) ELSE ${requestedAt} + 1 END,
          ${q("nextAttemptAt")} = 0, ${q("attempts")} = 0`
    : `INSERT INTO ${table} (${q("name")}, ${q("payload")}, ${requestedAt}, ${q("nextAttemptAt")}, ${q("attempts")}) VALUES (?, ?, ${now}, 0, 0)
        ON CONFLICT (${q("name")}) DO UPDATE SET ${q("payload")} = excluded.${q("payload")},
          ${requestedAt} = CASE WHEN excluded.${requestedAt} > ${table}.${requestedAt} THEN excluded.${requestedAt} ELSE ${table}.${requestedAt} + 1 END,
          ${q("nextAttemptAt")} = 0, ${q("attempts")} = 0`;
  await executeRaw(sql, [name, body]);
}

type RequestRow = { name: string; payload: string | null; requestedAt: number; attempts: number; ageMs: number };

/** 取一批到点的、认领、执行（只有持有者调）。返回执行成功了几件。 */
export async function drainPanelWorkRequests(options: { limit?: number } = {}) {
  const q = quoteIdentifier;
  const table = q("panel_work_requests");
  const limit = Math.max(1, Math.floor(options.limit ?? 200));
  const now = databaseClock();
  // 太老的直接丢（按库的时钟）。
  const expired = await executeRaw(`DELETE FROM ${table} WHERE ${q("requestedAt")} < ${now} - ?`, [PANEL_WORK_REQUEST_MAX_AGE_MS]);
  if (rawAffectedRows(expired) > 0) console.warn(`[PanelWork] dropped ${rawAffectedRows(expired)} request(s) older than ${PANEL_WORK_REQUEST_MAX_AGE_MS / 60_000} minutes`);
  const rows = (await queryRaw<RequestRow>(
    `SELECT ${q("name")}, ${q("payload")}, ${q("requestedAt")}, ${q("attempts")}, ${now} - ${q("requestedAt")} AS ${q("ageMs")} FROM ${table}
      WHERE ${q("nextAttemptAt")} <= ${now} ORDER BY ${q("requestedAt")} LIMIT ${limit}`,
  )).map((row) => ({
    name: String(row.name),
    payload: row.payload,
    requestedAt: Number(row.requestedAt) || 0,
    attempts: Number(row.attempts) || 0,
    ageMs: Math.max(0, Number(row.ageMs) || 0),
  }));
  let executed = 0;
  for (const row of rows) {
    const match = `${q("name")} = ? AND ${q("requestedAt")} = ?`;
    const claimed = await executeRaw(
      `UPDATE ${table} SET ${q("nextAttemptAt")} = ${now} + ? WHERE ${match} AND ${q("nextAttemptAt")} <= ${now}`,
      [PANEL_WORK_CLAIM_MS, row.name, row.requestedAt],
    );
    if (rawAffectedRows(claimed) === 0) continue;
    const separator = row.name.indexOf(":");
    const kind = separator > 0 ? row.name.slice(0, separator) : row.name;
    const key = separator > 0 ? row.name.slice(separator + 1) : "";
    const handler = handlers.get(kind);
    if (!handler) {
      // 这个版本不认识的活（混跑新旧版本时）：不删，留给认识它的实例；太老了按上面的规则丢。
      await executeRaw(`UPDATE ${table} SET ${q("nextAttemptAt")} = ${now} + ? WHERE ${match}`, [PANEL_WORK_RETRY_MAX_MS, row.name, row.requestedAt]);
      continue;
    }
    let payload: unknown = null;
    try {
      payload = row.payload ? JSON.parse(row.payload) : null;
    } catch {
      payload = null;
    }
    try {
      await handler(key, payload, { ageMs: row.ageMs });
      executed += 1;
      await executeRaw(`DELETE FROM ${table} WHERE ${match}`, [row.name, row.requestedAt]);
    } catch (error) {
      const attempts = row.attempts + 1;
      const delayMs = panelWorkRetryDelayMs(attempts);
      console.warn(`[PanelWork] ${row.name} failed (attempt ${attempts}); retrying in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`);
      await executeRaw(
        `UPDATE ${table} SET ${q("attempts")} = ?, ${q("nextAttemptAt")} = ${now} + ? WHERE ${match}`,
        [attempts, delayMs, row.name, row.requestedAt],
      ).catch(() => undefined);
    }
  }
  return executed;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let started = false;

async function pollOnce(force = false) {
  if (polling || !isPanelBackgroundLeaseHolder()) return;
  if (!force && !panelHasOtherLiveInstances()) return;
  polling = true;
  try {
    await drainPanelWorkRequests();
  } catch (error) {
    console.warn(`[PanelWork] poll failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    polling = false;
  }
}

/** 面板启动时调一次：持有期间每 2 秒取一次（有别的实例时），拿到租约时补取一次。 */
export function startPanelWorkPoller() {
  if (started) return;
  started = true;
  onPanelBackgroundLeaseChange((holder) => {
    if (holder) void pollOnce(true);
  });
  const loop = () => {
    pollTimer = setTimeout(() => {
      void pollOnce().finally(loop);
    }, PANEL_WORK_POLL_INTERVAL_MS);
    pollTimer.unref?.();
  };
  void pollOnce(true).finally(loop);
}

export function stopPanelWorkPollerForTests() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  started = false;
}
