/*
  IpChangeStore 的 SQL 实现（SQLite / MySQL / PostgreSQL 通用，裸 SQL + dbRuntime 的转换）。
  表结构见 ./tables.ts。
*/
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import {
  IP_CHANGE_DEFAULTS,
  IP_CHANGE_EVENT_STATUSES,
  IP_CHANGE_TRIGGERS,
  normalizeIpChangeState,
  type IpChangeEventStatus,
  type IpChangeTrigger,
} from "../../shared/ipChange";
import type {
  IpChangeAccountRecord,
  IpChangeConfigPatch,
  IpChangeConfigRecord,
  IpChangeEventRecord,
  IpChangeStore,
} from "./model";
import { sanitizeCredentials } from "./secrets";

const q = (name: string) => quoteDbIdentifier(name);
const ACCOUNTS = "ip_change_cloud_accounts";
const CONFIGS = "ip_change_host_configs";
const EVENTS = "ip_change_events";

function rowBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function rowInt(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function parseJsonObject(value: unknown) {
  try {
    return sanitizeCredentials(JSON.parse(String(value || "{}")));
  } catch {
    return {};
  }
}

function parseNotes(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).slice(0, 50) : [];
  } catch {
    return value ? [String(value)] : [];
  }
}

function mapAccount(row: any): IpChangeAccountRecord {
  return {
    id: rowInt(row.id),
    name: String(row.name || ""),
    provider: String(row.provider || ""),
    credentialsJson: row.credentialsJson == null ? null : String(row.credentialsJson),
    createdAt: rawEpochToDate(row.createdAt),
    updatedAt: rawEpochToDate(row.updatedAt),
  };
}

function mapConfig(row: any): IpChangeConfigRecord {
  return {
    id: rowInt(row.id),
    hostId: rowInt(row.hostId),
    enabled: rowBool(row.enabled),
    autoEnabled: rowBool(row.autoEnabled),
    cloudAccountId: row.cloudAccountId == null || rowInt(row.cloudAccountId) <= 0 ? null : rowInt(row.cloudAccountId),
    target: parseJsonObject(row.targetJson),
    checkTargets: row.checkTargets == null ? IP_CHANGE_DEFAULTS.checkTargets : String(row.checkTargets),
    checkMethod: row.checkMethod === "ping" ? "ping" : "tcp",
    failureThreshold: rowInt(row.failureThreshold, IP_CHANGE_DEFAULTS.failureThreshold),
    checkIntervalSeconds: rowInt(row.checkIntervalSeconds, IP_CHANGE_DEFAULTS.checkIntervalSeconds),
    cooldownMinutes: rowInt(row.cooldownMinutes, IP_CHANGE_DEFAULTS.cooldownMinutes),
    maxChangesPerDay: rowInt(row.maxChangesPerDay, IP_CHANGE_DEFAULTS.maxChangesPerDay),
    releaseOldIp: row.releaseOldIp == null ? IP_CHANGE_DEFAULTS.releaseOldIp : rowBool(row.releaseOldIp),
    state: normalizeIpChangeState(row.state),
    consecutiveFailures: rowInt(row.consecutiveFailures),
    lastCheckAt: rawEpochToDate(row.lastCheckAt),
    lastChangeAt: rawEpochToDate(row.lastChangeAt),
    lastError: row.lastError == null ? null : String(row.lastError),
    generation: rowInt(row.generation),
    createdAt: rawEpochToDate(row.createdAt),
    updatedAt: rawEpochToDate(row.updatedAt),
  };
}

function mapEvent(row: any): IpChangeEventRecord {
  const trigger = String(row.triggerKind || "manual");
  const status = String(row.status || "running");
  const role = String(row.ipRole || "");
  return {
    id: rowInt(row.id),
    hostId: rowInt(row.hostId),
    trigger: ((IP_CHANGE_TRIGGERS as readonly string[]).includes(trigger) ? trigger : "manual") as IpChangeTrigger,
    provider: row.provider == null ? null : String(row.provider),
    oldIp: row.oldIp == null ? null : String(row.oldIp),
    newIp: row.newIp == null ? null : String(row.newIp),
    ipRole: role === "primary" || role === "entry" ? role : null,
    status: ((IP_CHANGE_EVENT_STATUSES as readonly string[]).includes(status) ? status : "running") as IpChangeEventStatus,
    error: row.error == null ? null : String(row.error),
    notes: parseNotes(row.notes),
    startedAt: rawEpochToDate(row.startedAt),
    finishedAt: rawEpochToDate(row.finishedAt),
  };
}

/** 记录里的字段 → 表里的列。 */
function configColumns(patch: IpChangeConfigPatch) {
  const columns: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "target") columns.targetJson = JSON.stringify(value || {});
    else columns[key] = value;
  }
  return columns;
}

async function updateRow(table: string, keyColumn: string, keyValue: number, columns: Record<string, unknown>) {
  const entries = Object.entries(columns);
  if (entries.length === 0) return;
  await executeRaw(
    `UPDATE ${q(table)} SET ${entries.map(([key]) => `${q(key)} = ?`).join(", ")} WHERE ${q(keyColumn)} = ?`,
    [...entries.map(([, value]) => value), keyValue],
  );
}

function eventColumns(patch: Partial<IpChangeEventRecord>) {
  const columns: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === "id") continue;
    if (key === "trigger") columns.triggerKind = value;
    else if (key === "notes") columns.notes = JSON.stringify(value || []);
    else if (key === "error" && typeof value === "string") columns.error = value.slice(0, 4000);
    else columns[key] = value;
  }
  return columns;
}

async function getConfigRow(hostId: number) {
  const rows = await queryRaw(`SELECT * FROM ${q(CONFIGS)} WHERE ${q("hostId")} = ?`, [hostId]);
  return rows[0] ? mapConfig(rows[0]) : null;
}

export function createSqlIpChangeStore(): IpChangeStore {
  return {
    async listAccounts() {
      const rows = await queryRaw(`SELECT * FROM ${q(ACCOUNTS)} ORDER BY ${q("id")} ASC`);
      return rows.map(mapAccount);
    },
    async getAccount(id) {
      const rows = await queryRaw(`SELECT * FROM ${q(ACCOUNTS)} WHERE ${q("id")} = ?`, [id]);
      return rows[0] ? mapAccount(rows[0]) : null;
    },
    async createAccount(input) {
      const now = new Date();
      return insertAndGetId(ACCOUNTS, { ...input, createdAt: now, updatedAt: now });
    },
    async updateAccount(id, patch) {
      const columns: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.credentialsJson !== undefined) columns.credentialsJson = patch.credentialsJson;
      await updateRow(ACCOUNTS, "id", id, columns);
    },
    async deleteAccount(id) {
      await executeRaw(`DELETE FROM ${q(ACCOUNTS)} WHERE ${q("id")} = ?`, [id]);
    },

    async listConfigs() {
      const rows = await queryRaw(`SELECT * FROM ${q(CONFIGS)} ORDER BY ${q("hostId")} ASC`);
      return rows.map(mapConfig);
    },
    getConfig: getConfigRow,
    async upsertConfig(hostId, patch) {
      const existing = await getConfigRow(hostId);
      const now = new Date();
      if (existing) {
        await updateRow(CONFIGS, "hostId", hostId, { ...configColumns(patch), updatedAt: now });
      } else {
        await insertAndGetId(CONFIGS, {
          hostId,
          checkTargets: IP_CHANGE_DEFAULTS.checkTargets,
          targetJson: "{}",
          ...configColumns(patch),
          createdAt: now,
          updatedAt: now,
        });
      }
      const saved = await getConfigRow(hostId);
      if (!saved) throw new Error("保存自动换 IP 配置失败");
      return saved;
    },
    async updateConfig(hostId, patch) {
      await updateRow(CONFIGS, "hostId", hostId, { ...configColumns(patch), updatedAt: new Date() });
    },
    async deleteConfig(hostId) {
      await executeRaw(`DELETE FROM ${q(CONFIGS)} WHERE ${q("hostId")} = ?`, [hostId]);
    },

    async insertEvent(event) {
      return insertAndGetId(EVENTS, eventColumns(event));
    },
    async updateEvent(id, patch) {
      await updateRow(EVENTS, "id", id, eventColumns(patch));
    },
    async listEvents(query) {
      const where = query.hostId ? ` WHERE ${q("hostId")} = ?` : "";
      const params = query.hostId ? [query.hostId] : [];
      const [countRow] = await queryRaw<{ total: unknown }>(`SELECT COUNT(*) AS ${q("total")} FROM ${q(EVENTS)}${where}`, params);
      const rows = await queryRaw(
        `SELECT * FROM ${q(EVENTS)}${where} ORDER BY ${q("id")} DESC LIMIT ? OFFSET ?`,
        [...params, Math.max(1, Math.floor(query.limit)), Math.max(0, Math.floor(query.offset))],
      );
      return { items: rows.map(mapEvent), total: rowInt(countRow?.total) };
    },
    async countAttemptsSince(hostId, since) {
      const [row] = await queryRaw<{ total: unknown }>(
        `SELECT COUNT(*) AS ${q("total")} FROM ${q(EVENTS)}
          WHERE ${q("hostId")} = ? AND ${q("triggerKind")} IN ('manual', 'auto') AND ${q("startedAt")} >= ?`,
        [hostId, since],
      );
      return rowInt(row?.total);
    },
    async lastAttemptAt(hostId) {
      const [row] = await queryRaw<{ startedAt: unknown }>(
        `SELECT MAX(${q("startedAt")}) AS ${q("startedAt")} FROM ${q(EVENTS)}
          WHERE ${q("hostId")} = ? AND ${q("triggerKind")} IN ('manual', 'auto')`,
        [hostId],
      );
      return rawEpochToDate(row?.startedAt);
    },
    async markRunningEventsUncertain(hostIds, error, finishedAt) {
      if (hostIds && hostIds.length === 0) return 0;
      const hostFilter = hostIds ? ` AND ${q("hostId")} IN (${hostIds.map(() => "?").join(", ")})` : "";
      const result: any = await executeRaw(
        `UPDATE ${q(EVENTS)} SET ${q("status")} = 'uncertain', ${q("error")} = ?, ${q("finishedAt")} = ?
          WHERE ${q("status")} = 'running'${hostFilter}`,
        [error, finishedAt, ...(hostIds || [])],
      );
      return Number(result?.affectedRows ?? result?.changes ?? result?.rowCount ?? 0);
    },
  };
}
