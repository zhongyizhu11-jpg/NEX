/*
  事件时间线：把面板里发生的事记成一句句人话，之后能回看、能筛选、能转发（Webhook / Telegram）。

  谁都可以调用 recordPanelEvent：主机掉线 / 恢复、Agent 重启、流量用尽、到期、安全巡检发现、
  Agent 改走中转、新建 API 令牌……写入失败只记日志，永远不影响调用方的主流程。

  onPanelEvent 注册的监听器在写入之后异步收到同一条事件（Webhook 推送就挂在这里）。
*/
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";

export type PanelEventLevel = "info" | "warn" | "crit";

export const PANEL_EVENT_LEVELS: readonly PanelEventLevel[] = ["info", "warn", "crit"] as const;

/** 事件种类。新功能可以加新的 kind，前端按前缀分组（host. / user. / security. / account. / ops. / ticket.）。 */
export type PanelEventKind =
  | "host.offline"
  | "host.online"
  | "host.agent_restarted"
  | "host.rebooted"
  | "host.relay_switched"
  | "host.config_refused"
  | "host.resource_high"
  | "host.resource_recovered"
  | "user.quota_exhausted"
  | "user.expiring"
  | "user.expired"
  | "user.ip_limit_exceeded"
  | "rule.error"
  | "rule.recovered"
  | "route.switched"
  | "security.finding"
  | "account.login"
  | "account.login_failed"
  | "account.api_token_created"
  | "account.passkey_added"
  | "account.passkey_removed"
  | "ops.restart_all"
  | "ops.maintenance"
  | "ops.backup"
  | "ticket.created"
  | "ticket.replied"
  | (string & {});

export type PanelEventInput = {
  kind: PanelEventKind;
  level?: PanelEventLevel;
  message: string;
  hostId?: number | null;
  userId?: number | null;
  ruleId?: number | null;
  data?: Record<string, unknown> | null;
  /** 秒级时间戳；不给就是现在。 */
  at?: number;
};

export type PanelEvent = {
  id: number;
  kind: string;
  level: PanelEventLevel;
  hostId: number | null;
  userId: number | null;
  ruleId: number | null;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: Date;
};

type PanelEventListener = (event: PanelEvent) => void | Promise<void>;

const listeners = new Set<PanelEventListener>();

export function onPanelEvent(listener: PanelEventListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function normalizeLevel(value: unknown): PanelEventLevel {
  return value === "warn" || value === "crit" ? value : "info";
}

function optionalId(value: unknown) {
  const n = Math.floor(Number(value));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseData(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function rowToPanelEvent(row: Record<string, any>): PanelEvent {
  return {
    id: Number(row.id),
    kind: String(row.kind || ""),
    level: normalizeLevel(row.level),
    hostId: optionalId(row.hostId),
    userId: optionalId(row.userId),
    ruleId: optionalId(row.ruleId),
    message: String(row.message || ""),
    data: parseData(row.dataJson),
    createdAt: rawEpochToDate(row.createdAt) || new Date(0),
  };
}

/** 记一条事件。返回事件；数据库不可用或写入失败时返回 null（只记日志，不抛）。 */
export async function recordPanelEvent(input: PanelEventInput): Promise<PanelEvent | null> {
  const message = String(input.message || "").trim().slice(0, 2000);
  const kind = String(input.kind || "").trim().slice(0, 64);
  if (!message || !kind) return null;
  const createdAtSeconds = Math.floor(Number(input.at) > 0 ? Number(input.at) : Date.now() / 1000);
  const values = {
    kind,
    level: normalizeLevel(input.level),
    hostId: optionalId(input.hostId),
    userId: optionalId(input.userId),
    ruleId: optionalId(input.ruleId),
    message,
    dataJson: input.data ? JSON.stringify(input.data).slice(0, 16_000) : null,
    createdAt: createdAtSeconds,
  };
  try {
    const id = await insertAndGetId("panel_events", values);
    const event: PanelEvent = {
      id,
      kind: values.kind,
      level: values.level,
      hostId: values.hostId,
      userId: values.userId,
      ruleId: values.ruleId,
      message: values.message,
      data: input.data || null,
      createdAt: new Date(createdAtSeconds * 1000),
    };
    for (const listener of listeners) {
      Promise.resolve()
        .then(() => listener(event))
        .catch((error) => console.warn(`[PanelEvents] listener failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return event;
  } catch (error) {
    console.warn(`[PanelEvents] record ${kind} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export type ListPanelEventsInput = {
  limit?: number;
  /** 只要 id 比它小的（向下翻页）。 */
  beforeId?: number | null;
  hostId?: number | null;
  userId?: number | null;
  /** 至少这个级别：warn 表示 warn + crit。 */
  minLevel?: PanelEventLevel | null;
  /** kind 前缀，例如 "host." */
  kindPrefix?: string | null;
  sinceSeconds?: number | null;
};

export async function listPanelEvents(input: ListPanelEventsInput = {}): Promise<PanelEvent[]> {
  const limit = Math.min(500, Math.max(1, Math.floor(Number(input.limit) || 50)));
  const where: string[] = [];
  const params: any[] = [];
  const q = quoteDbIdentifier;
  if (optionalId(input.beforeId)) { where.push(`${q("id")} < ?`); params.push(optionalId(input.beforeId)); }
  if (optionalId(input.hostId)) { where.push(`${q("hostId")} = ?`); params.push(optionalId(input.hostId)); }
  if (optionalId(input.userId)) { where.push(`${q("userId")} = ?`); params.push(optionalId(input.userId)); }
  if (input.minLevel === "warn") where.push(`${q("level")} IN ('warn', 'crit')`);
  if (input.minLevel === "crit") where.push(`${q("level")} = 'crit'`);
  if (input.kindPrefix) { where.push(`${q("kind")} LIKE ?`); params.push(`${String(input.kindPrefix).replace(/[%_]/g, "")}%`); }
  if (Number(input.sinceSeconds) > 0) { where.push(`${q("createdAt")} >= ?`); params.push(Math.floor(Number(input.sinceSeconds))); }
  const sql = `SELECT * FROM ${q("panel_events")}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${q("id")} DESC LIMIT ${limit}`;
  const rows = await queryRaw(sql, params);
  return rows.map(rowToPanelEvent);
}

/** 删掉早于 retainDays 天的事件。返回删除行数（拿不到时为 0）。 */
export async function prunePanelEvents(retainDays = 90): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, retainDays) * 86400;
  const q = quoteDbIdentifier;
  const result: any = await executeRaw(`DELETE FROM ${q("panel_events")} WHERE ${q("createdAt")} < ?`, [cutoff]);
  return Number(result?.affectedRows ?? result?.changes ?? result?.rowCount ?? 0);
}
