import { executeRaw, getDatabaseKind, queryRaw, rawAffectedRows } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";
import { isPanelBackgroundLeaseHolder, onPanelBackgroundLeaseChange, panelHasOtherLiveInstances } from "./panelLease";

/*
  非持有实例交给持有实例的活（panel_work_requests 表）。

  Agent 只连一个面板实例：连在非持有实例上的 Agent 报上来的健康变化、在非持有实例上点的「立即同步」，
  都要由持有实例去评估、写 DNS（两个实例各评估一份就是两个评估器抢解析，见 panelLease.ts）。
  非持有实例把「哪个组要评估、带什么选项」写成一行（同一件事只留一行，后来的覆盖前面的），持有实例每 2 秒取走，
  按种类交给登记的处理函数。取的时候按 requestedAt 条件删：取走之后又有人请求的，那一行留着下一轮再跑。

  只有一个实例时持有者不轮询（没人会写），拿到租约那一刻补取一次，防着上一任没取完。
*/

export const PANEL_WORK_POLL_INTERVAL_MS = 2_000;
/** 放了这么久还没人取的不再执行（持有者长时间不在时，回来按巡检重新算，不补旧请求）。 */
export const PANEL_WORK_REQUEST_MAX_AGE_MS = 10 * 60_000;

type Handler = (key: string, payload: unknown) => Promise<void> | void;
const handlers = new Map<string, Handler>();

export function registerPanelWorkHandler(kind: string, handler: Handler) {
  handlers.set(kind, handler);
}

function requestName(kind: string, key: string | number) {
  return `${kind}:${String(key)}`;
}

/** 交给持有实例。同一 kind + key 只留最新一份。 */
export async function requestPanelWork(kind: string, key: string | number, payload: unknown = null, now = Date.now()) {
  const q = quoteIdentifier;
  const table = q("panel_work_requests");
  const name = requestName(kind, key);
  const body = payload === null || payload === undefined ? null : JSON.stringify(payload);
  const kindName = getDatabaseKind();
  const sql = kindName === "mysql"
    ? `INSERT INTO ${table} (${q("name")}, ${q("payload")}, ${q("requestedAt")}) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE ${q("payload")} = VALUES(${q("payload")}), ${q("requestedAt")} = VALUES(${q("requestedAt")})`
    : `INSERT INTO ${table} (${q("name")}, ${q("payload")}, ${q("requestedAt")}) VALUES (?, ?, ?)
        ON CONFLICT (${q("name")}) DO UPDATE SET ${q("payload")} = excluded.${q("payload")}, ${q("requestedAt")} = excluded.${q("requestedAt")}`;
  await executeRaw(sql, [name, body, now]);
}

type RequestRow = { name: string; payload: string | null; requestedAt: number };

/** 取走并执行一批（只有持有者调）。返回执行了几件。 */
export async function drainPanelWorkRequests(options: { now?: number; limit?: number } = {}) {
  const q = quoteIdentifier;
  const table = q("panel_work_requests");
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.floor(options.limit ?? 200));
  const rows = (await queryRaw<RequestRow>(
    `SELECT ${q("name")}, ${q("payload")}, ${q("requestedAt")} FROM ${table} ORDER BY ${q("requestedAt")} LIMIT ${limit}`,
  )).map((row) => ({ name: String(row.name), payload: row.payload, requestedAt: Number(row.requestedAt) || 0 }));
  let executed = 0;
  for (const row of rows) {
    const claimed = await executeRaw(
      `DELETE FROM ${table} WHERE ${q("name")} = ? AND ${q("requestedAt")} = ?`,
      [row.name, row.requestedAt],
    );
    if (rawAffectedRows(claimed) === 0) continue;
    if (now - row.requestedAt > PANEL_WORK_REQUEST_MAX_AGE_MS) continue;
    const separator = row.name.indexOf(":");
    const kind = separator > 0 ? row.name.slice(0, separator) : row.name;
    const key = separator > 0 ? row.name.slice(separator + 1) : "";
    const handler = handlers.get(kind);
    if (!handler) continue;
    let payload: unknown = null;
    try {
      payload = row.payload ? JSON.parse(row.payload) : null;
    } catch {
      payload = null;
    }
    try {
      await handler(key, payload);
      executed += 1;
    } catch (error) {
      console.warn(`[PanelWork] ${row.name} failed: ${error instanceof Error ? error.message : String(error)}`);
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
