import crypto from "crypto";
import { quoteIdentifierFor } from "./dbRuntime";
import { normalizeRawValue } from "./dbRuntime";
import fs from "fs";
import path from "path";
import mysql, { type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";
import pg from "pg";
import Database from "better-sqlite3";
import { MIGRATION_TABLES, ensureDatabaseSchema, getDatabaseTableDefs, type ColumnDef } from "./dbSchema";
import {
  type DatabaseConfig,
  type DatabaseKind,
  defaultSqlitePath,
  executeRaw,
  getDatabaseKind,
  getDatabasePoolSettings,
  getSchemaDialect,
  maskDatabaseConfig,
  MYSQL_MAX_PREPARED_STATEMENTS,
  queryRaw,
  quoteDbIdentifier,
  readDatabaseConfig,
  reconnectDatabase,
  testDatabaseConnection,
  withDatabaseTransaction,
  writeDatabaseConfig,
} from "./dbRuntime";
import { ENV } from "./env";
import { summarizeMigrationTableCounts, type MigrationSnapshotSummary } from "./migration";
import { RUNTIME_CACHE_SETTING_PREFIX } from "./repositories/settingsRepository";
import { beginDatabaseMaintenance, endDatabaseMaintenance } from "./databaseMaintenance";
import { flushPendingWrites } from "./dbWriteBatcher";
import { APP_VERSION } from "../shared/versions";
import { maintainPostgresqlDatabase } from "./postgresqlMaintenance";

export type DatabaseSwitchJobStatus = "pending" | "running" | "success" | "failed";
export type DatabaseSwitchStage =
  | "connection"
  | "permissions"
  | "schema"
  | "target-check"
  | "export"
  | "transfer"
  | "optimize"
  | "switch";

export type DatabaseSwitchFailure = {
  code: string;
  message: string;
  detail: string;
  suggestion?: string;
  suggestionCommand?: string;
};

export interface DatabaseSwitchJob {
  id: string;
  status: DatabaseSwitchJobStatus;
  progress: number;
  step: string;
  stage?: DatabaseSwitchStage;
  stageIndex?: number;
  stageTotal?: number;
  detail?: string;
  message?: string;
  error?: string;
  errorCode?: string;
  errorDetail?: string;
  suggestion?: string;
  suggestionCommand?: string;
  failedStep?: string;
  currentTable?: string;
  processedRows?: number;
  totalRows?: number;
  processedTables?: number;
  totalTables?: number;
  sourceType?: DatabaseKind | null;
  targetType?: DatabaseKind;
  restartRequired?: boolean;
  summary?: MigrationSnapshotSummary;
  inserted?: Record<string, number>;
  startedAt: number;
  stageStartedAt?: number;
  updatedAt: number;
  finishedAt?: number;
}

type TargetHandle =
  | { kind: "mysql"; pool: Pool }
  | { kind: "postgresql"; pool: pg.Pool }
  | { kind: "sqlite"; sqlite: Database.Database };

type TargetSession =
  | { kind: "mysql"; executor: PoolConnection }
  | { kind: "postgresql"; executor: pg.PoolClient }
  | { kind: "sqlite"; executor: Database.Database };

const jobs = new Map<string, DatabaseSwitchJob>();
const tableDefs = new Map(getDatabaseTableDefs().map((table) => [table.name, table]));
let activeJobId: string | null = null;
let restartScheduled = false;

const databaseSwitchStages: Record<DatabaseSwitchStage, { label: string; detail: string }> = {
  connection: { label: "检查目标数据库连接", detail: "验证地址、账号、密码和数据库版本" },
  permissions: { label: "验证目标数据库权限", detail: "验证建表、写入、修改结构、创建索引和清理权限" },
  schema: { label: "初始化目标数据库结构", detail: `创建或校验 ${MIGRATION_TABLES.length} 张数据表及索引` },
  "target-check": { label: "检查目标数据库内容", detail: "确认目标数据库没有需要保留的业务数据" },
  export: { label: "读取当前面板数据", detail: "已暂停面板写入，正在逐表统计源数据库" },
  transfer: { label: "写入目标数据库", detail: "正在按主键分批读取、写入并保留原始数据 ID" },
  optimize: { label: "优化 PostgreSQL 查询性能", detail: "同步序列并更新查询统计信息" },
  switch: { label: "保存数据库切换配置", detail: "写入新连接配置并准备重启或刷新连接" },
};

export function getDatabaseSwitchStagePlan(targetType: DatabaseKind): DatabaseSwitchStage[] {
  const stages: DatabaseSwitchStage[] = [
    "connection",
    "permissions",
    "schema",
    "target-check",
    "export",
    "transfer",
  ];
  if (targetType === "postgresql") stages.push("optimize");
  stages.push("switch");
  return stages;
}

function setJob(job: DatabaseSwitchJob, patch: Partial<DatabaseSwitchJob>) {
  Object.assign(job, {
    ...patch,
    progress: patch.progress === undefined ? job.progress : Math.max(0, Math.min(100, Math.round(patch.progress))),
    updatedAt: Date.now(),
  });
  jobs.set(job.id, job);
}

function setJobStage(job: DatabaseSwitchJob, stage: DatabaseSwitchStage, patch: Partial<DatabaseSwitchJob> = {}) {
  const plan = getDatabaseSwitchStagePlan(job.targetType || "sqlite");
  const definition = databaseSwitchStages[stage];
  const stageChanged = job.stage !== stage;
  setJob(job, {
    stage,
    stageIndex: Math.max(1, plan.indexOf(stage) + 1),
    stageTotal: plan.length,
    step: definition.label,
    detail: definition.detail,
    ...(stageChanged ? { stageStartedAt: Date.now() } : {}),
    ...patch,
  });
}

function databaseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "未知数据库错误");
}

function databaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  return String((error as { code?: unknown }).code || "").trim();
}

function postgresIdentifier(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function describeDatabaseSwitchFailure(error: unknown, target: DatabaseConfig): DatabaseSwitchFailure {
  const detail = databaseErrorMessage(error);
  const nativeCode = databaseErrorCode(error);
  if (target.type === "postgresql" && (/permission denied for schema/i.test(detail) || /no schema has been selected/i.test(detail))) {
    const schema = detail.match(/schema\s+([^\s]+)/i)?.[1]?.replace(/["']/g, "") || "public";
    const user = target.postgresql.user.trim() || "forwardx";
    return {
      code: "POSTGRESQL_SCHEMA_PERMISSION_DENIED",
      message: `PostgreSQL 账号 ${user} 没有在 ${schema} Schema 中创建和维护数据表的权限。`,
      detail,
      suggestion: "请使用数据库管理员授予该账号 Schema 的 USAGE、CREATE 权限，或将目标数据库及 Schema 的所有者改为该账号，然后重新测试连接。",
      suggestionCommand: `GRANT USAGE, CREATE ON SCHEMA ${postgresIdentifier(schema)} TO ${postgresIdentifier(user)};`,
    };
  }
  if (target.type === "postgresql" && (nativeCode === "42501" || /permission denied/i.test(detail))) {
    const user = target.postgresql.user.trim() || "forwardx";
    return {
      code: "POSTGRESQL_WRITE_PERMISSION_DENIED",
      message: `PostgreSQL 账号 ${user} 缺少迁移所需的数据库对象操作权限。`,
      detail,
      suggestion: "请将目标数据库及其 Schema 的所有者设为该账号，或授予建表、写入、修改结构、创建索引和删除对象的权限后重新测试。",
    };
  }
  if (target.type === "mysql" && (
    ["ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR"].includes(nativeCode)
    || /access denied|command denied/i.test(detail)
  )) {
    return {
      code: "MYSQL_WRITE_PERMISSION_DENIED",
      message: `MySQL 账号 ${target.mysql.user.trim() || "forwardx"} 缺少迁移所需的建表或写入权限。`,
      detail,
      suggestion: "请授予目标数据库的 CREATE、ALTER、INDEX、SELECT、INSERT、UPDATE、DELETE、DROP 权限后重新测试连接。",
    };
  }
  if (target.type === "sqlite" && (
    /readonly|read-only|unable to open database file/i.test(detail)
    || nativeCode.startsWith("SQLITE_READONLY")
  )) {
    return {
      code: "SQLITE_NOT_WRITABLE",
      message: "SQLite 数据文件或所在目录不可写。",
      detail,
      suggestion: "请检查面板进程对 SQLite 文件及其所在目录的读写权限和剩余磁盘空间。",
    };
  }
  return {
    code: nativeCode || "DATABASE_SWITCH_FAILED",
    message: detail,
    detail,
  };
}

class DatabaseSwitchValidationError extends Error {
  readonly failure: DatabaseSwitchFailure;

  constructor(failure: DatabaseSwitchFailure) {
    super([
      failure.message,
      failure.suggestion ? `处理建议：${failure.suggestion}` : undefined,
      failure.suggestionCommand ? `授权命令：${failure.suggestionCommand}` : undefined,
    ].filter(Boolean).join("\n"));
    this.name = "DatabaseSwitchValidationError";
    this.failure = failure;
  }
}

export function getDatabaseSwitchJob(id: string) {
  return jobs.get(id) || null;
}

export function getDatabaseSwitchStatus() {
  const current = readDatabaseConfig();
  const activeJob = activeJobId ? getDatabaseSwitchJob(activeJobId) : null;
  return {
    current: maskDatabaseConfig(current),
    currentType: current?.type ?? null,
    activeType: getDatabaseKind(),
    schemaDialect: getSchemaDialect(),
    defaultSqlitePath: defaultSqlitePath(),
    blockedReason: databaseEnvironmentOverrideReason(),
    activeJob,
  };
}

function databaseEnvironmentOverrideReason() {
  if (String(ENV.databaseType || "").trim()) {
    return "当前服务通过 DATABASE_TYPE/DB_TYPE 强制指定数据库类型，面板内切换不会在重启后生效，请先移除该环境变量。";
  }
  if (String(ENV.mysqlUrl || "").trim() || (ENV.mysqlHost && ENV.mysqlUser && ENV.mysqlDatabase)) {
    return "当前服务通过 MySQL 环境变量指定数据库连接，面板内切换不会在重启后生效，请先移除 MYSQL_URL 或 MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE。";
  }
  if (String(ENV.postgresUrl || "").trim() || (ENV.postgresHost && ENV.postgresUser && ENV.postgresDatabase)) {
    return "当前服务通过 PostgreSQL 环境变量指定数据库连接，面板内切换不会在重启后生效，请先移除 POSTGRES_URL 或 POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE。";
  }
  return null;
}

function normalizeMysqlConfig(config: DatabaseConfig & { type: "mysql" }) {
  return {
    host: config.mysql.host.trim(),
    port: Number(config.mysql.port || 3306),
    user: config.mysql.user.trim(),
    password: config.mysql.password || "",
    database: config.mysql.database.trim(),
    ssl: !!config.mysql.ssl,
  };
}

function normalizePostgresqlConfig(config: DatabaseConfig & { type: "postgresql" }) {
  return {
    host: config.postgresql.host.trim(),
    port: Number(config.postgresql.port || 5432),
    user: config.postgresql.user.trim(),
    password: config.postgresql.password || "",
    database: config.postgresql.database.trim(),
    ssl: !!config.postgresql.ssl,
  };
}

function normalizeSqlitePath(config: DatabaseConfig & { type: "sqlite" }) {
  const raw = (config.sqlite.path || defaultSqlitePath()).trim() || defaultSqlitePath();
  return path.resolve(raw);
}

function sameDatabaseLocation(a: DatabaseConfig | null, b: DatabaseConfig) {
  if (!a || a.type !== b.type) return false;
  if (a.type === "sqlite" && b.type === "sqlite") {
    return path.resolve(a.sqlite.path) === normalizeSqlitePath(b);
  }
  if (a.type === "mysql" && b.type === "mysql") {
    const left = normalizeMysqlConfig(a);
    const right = normalizeMysqlConfig(b);
    return left.host.toLowerCase() === right.host.toLowerCase()
      && left.port === right.port
      && left.database === right.database;
  }
  if (a.type === "postgresql" && b.type === "postgresql") {
    const left = normalizePostgresqlConfig(a);
    const right = normalizePostgresqlConfig(b);
    return left.host.toLowerCase() === right.host.toLowerCase()
      && left.port === right.port
      && left.database === right.database;
  }
  return false;
}

function assertSwitchAllowed(target: DatabaseConfig) {
  const blockedReason = databaseEnvironmentOverrideReason();
  if (blockedReason) throw new Error(blockedReason);
  if (sameDatabaseLocation(readDatabaseConfig(), target)) {
    throw new Error("目标数据库与当前数据库相同，无需执行迁移切换。");
  }
}

export async function testDatabaseSwitchTarget(target: DatabaseConfig) {
  assertSwitchAllowed(target);
  let handle: TargetHandle | null = null;
  try {
    await testDatabaseConnection(target);
    handle = await openTarget(target);
    const checks = await verifyTargetWriteAccess(handle);
    return {
      success: true,
      message: "目标数据库连接及迁移写入权限验证通过",
      checks,
    };
  } catch (error) {
    throw new DatabaseSwitchValidationError(describeDatabaseSwitchFailure(error, target));
  } finally {
    await closeTarget(handle);
  }
}

function mysqlPoolOptions(config: DatabaseConfig & { type: "mysql" }): PoolOptions {
  const mysqlConfig = normalizeMysqlConfig(config);
  const pool = getDatabasePoolSettings();
  return {
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
    waitForConnections: true,
    connectionLimit: pool.maxOpen,
    maxIdle: pool.maxIdle,
    idleTimeout: pool.idleTimeoutMillis,
    queueLimit: pool.queueLimit,
    connectTimeout: pool.connectTimeoutMillis,
    timezone: "+00:00",
    dateStrings: false,
    ssl: mysqlConfig.ssl ? {} : undefined,
    // 迁移时批量插入的文本各不相同，同样要限住每条连接的预处理语句缓存（见 dbRuntime）。
    maxPreparedStatements: MYSQL_MAX_PREPARED_STATEMENTS,
  };
}

function postgresqlPoolOptions(config: DatabaseConfig & { type: "postgresql" }): pg.PoolConfig {
  const postgresqlConfig = normalizePostgresqlConfig(config);
  const pool = getDatabasePoolSettings();
  const options: pg.PoolConfig & { min?: number; maxLifetimeSeconds?: number } = {
    host: postgresqlConfig.host,
    port: postgresqlConfig.port,
    user: postgresqlConfig.user,
    password: postgresqlConfig.password,
    database: postgresqlConfig.database,
    max: pool.maxOpen,
    min: pool.maxIdle,
    idleTimeoutMillis: pool.idleTimeoutMillis,
    connectionTimeoutMillis: pool.connectTimeoutMillis,
    maxLifetimeSeconds: pool.maxLifetimeSeconds,
    // Keep PostgreSQL TLS certificate verification enabled by default.
    ssl: postgresqlConfig.ssl ? true : undefined,
  };
  return options;
}

async function openTarget(config: DatabaseConfig): Promise<TargetHandle> {
  if (config.type === "mysql") {
    const pool = mysql.createPool(mysqlPoolOptions(config));
    await pool.query("SELECT 1");
    return { kind: "mysql", pool };
  }
  if (config.type === "postgresql") {
    const pool = new pg.Pool(postgresqlPoolOptions(config));
    await pool.query("SELECT 1");
    return { kind: "postgresql", pool };
  }
  const sqlitePath = normalizeSqlitePath(config);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = new Database(sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.prepare("SELECT 1").get();
  return { kind: "sqlite", sqlite };
}

async function closeTarget(handle: TargetHandle | null) {
  if (!handle) return;
  if (handle.kind === "mysql") {
    await handle.pool.end().catch(() => undefined);
    return;
  }
  if (handle.kind === "postgresql") {
    await handle.pool.end().catch(() => undefined);
    return;
  }
  try {
    handle.sqlite.close();
  } catch {
    // Ignore close failures during cleanup.
  }
}

export function databaseSwitchProbeValueType(kind: DatabaseKind) {
  // MySQL cannot index TEXT without a prefix length. The probe only stores a
  // short marker, so use the same utf8mb4-safe indexed width as the schema.
  return kind === "mysql" ? "VARCHAR(191)" : "TEXT";
}

function postgresSql(sqlText: string, params: any[] = []) {
  let index = 0;
  return {
    text: sqlText.replace(/\?/g, () => `$${++index}`),
    values: params,
  };
}

async function targetQuery<T = Record<string, any>>(session: TargetSession, sqlText: string, params: any[] = []): Promise<T[]> {
  const normalized = params.map((value) => normalizeRawValue(value, session.kind));
  if (session.kind === "mysql") {
    const [rows] = await session.executor.query(sqlText, normalized);
    return rows as T[];
  }
  if (session.kind === "postgresql") {
    const result = await session.executor.query(postgresSql(sqlText, normalized));
    return result.rows as T[];
  }
  return session.executor.prepare(sqlText).all(...normalized) as T[];
}

async function targetExecute(session: TargetSession, sqlText: string, params: any[] = []) {
  const normalized = params.map((value) => normalizeRawValue(value, session.kind));
  if (session.kind === "mysql") {
    const [result] = await session.executor.execute(sqlText, normalized);
    return result;
  }
  if (session.kind === "postgresql") {
    return session.executor.query(postgresSql(sqlText, normalized));
  }
  return session.executor.prepare(sqlText).run(...normalized);
}

async function withTargetSession<T>(handle: TargetHandle, action: (session: TargetSession) => Promise<T>) {
  if (handle.kind === "mysql") {
    const connection = await handle.pool.getConnection();
    try {
      return await action({ kind: "mysql", executor: connection });
    } finally {
      connection.release();
    }
  }
  if (handle.kind === "postgresql") {
    const client = await handle.pool.connect();
    try {
      return await action({ kind: "postgresql", executor: client });
    } finally {
      client.release();
    }
  }
  return action({ kind: "sqlite", executor: handle.sqlite });
}

async function verifyTargetWriteAccess(handle: TargetHandle) {
  const suffix = crypto.randomBytes(6).toString("hex");
  const table = `_forwardx_switch_probe_${suffix}`;
  const index = `_forwardx_switch_probe_idx_${suffix}`;
  await withTargetSession(handle, async (session) => {
    const tableName = quoteIdentifierFor(session.kind, table);
    let created = false;
    let operationError: unknown;
    try {
      await targetExecute(
        session,
        `CREATE TABLE ${tableName} (${quoteIdentifierFor(session.kind, "id")} INTEGER PRIMARY KEY, ${quoteIdentifierFor(session.kind, "value")} ${databaseSwitchProbeValueType(session.kind)} NOT NULL)`,
      );
      created = true;
      await targetExecute(
        session,
        `INSERT INTO ${tableName} (${quoteIdentifierFor(session.kind, "id")}, ${quoteIdentifierFor(session.kind, "value")}) VALUES (?, ?)`,
        [1, "forwardx-write-check"],
      );
      await targetExecute(
        session,
        `UPDATE ${tableName} SET ${quoteIdentifierFor(session.kind, "value")} = ? WHERE ${quoteIdentifierFor(session.kind, "id")} = ?`,
        ["forwardx-update-check", 1],
      );
      await targetExecute(
        session,
        `ALTER TABLE ${tableName} ADD COLUMN ${quoteIdentifierFor(session.kind, "checked")} INTEGER DEFAULT 0`,
      );
      await targetExecute(
        session,
        `CREATE INDEX ${quoteIdentifierFor(session.kind, index)} ON ${tableName} (${quoteIdentifierFor(session.kind, "value")})`,
      );
      await targetExecute(session, `DELETE FROM ${tableName} WHERE ${quoteIdentifierFor(session.kind, "id")} = ?`, [1]);
    } catch (error) {
      operationError = error;
    }
    if (created) {
      try {
        await targetExecute(session, `DROP TABLE ${tableName}`);
      } catch (error) {
        operationError ||= error;
      }
    }
    if (operationError) throw operationError;
  });
  return ["连接", "建表", "写入", "修改表结构", "创建索引", "清理"];
}

function normalizeColumnValue(value: any, kind: DatabaseKind, column: ColumnDef) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (column.type === "bool") {
    const boolValue = value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
    return kind === "postgresql" ? boolValue : boolValue ? 1 : 0;
  }
  if (column.type === "id" || column.type === "int" || column.type === "epoch") {
    if (value === "") return null;
    if (column.type === "epoch" && typeof value === "string") {
      const parsedDate = Date.parse(value);
      if (Number.isFinite(parsedDate)) return Math.floor(parsedDate / 1000);
    }
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : value;
  }
  if (column.type === "bigint" && typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

async function targetTableCount(session: TargetSession, table: string) {
  const rows = await targetQuery<{ count: number | string }>(
    session,
    `SELECT COUNT(*) as ${quoteIdentifierFor(session.kind, "count")} FROM ${quoteIdentifierFor(session.kind, table)}`,
  );
  return Number(rows[0]?.count || 0);
}

async function assertTargetHasNoBusinessData(session: TargetSession) {
  const blockingTables: string[] = [];
  for (const table of MIGRATION_TABLES) {
    const count = await targetTableCount(session, table);
    if (table !== "system_settings" && count > 0) {
      blockingTables.push(`${table}(${count})`);
    }
  }
  if (blockingTables.length > 0) {
    throw new Error(`目标数据库不是空库，请先使用新的空数据库。已发现数据表：${blockingTables.slice(0, 6).join("、")}${blockingTables.length > 6 ? " 等" : ""}`);
  }
}

async function insertTargetRow(session: TargetSession, table: string, row: Record<string, any>) {
  const tableDef = tableDefs.get(table);
  if (!tableDef) return false;
  if (table === "system_settings") {
    const key = String(row.key || "");
    if (!key) return false;
    await targetExecute(session, `DELETE FROM ${quoteIdentifierFor(session.kind, table)} WHERE ${quoteIdentifierFor(session.kind, "key")} = ?`, [key]);
  }
  const columns = tableDef.columns.filter((column) => row[column.name] !== undefined);
  if (columns.length === 0) return false;
  const columnSql = columns.map((column) => quoteIdentifierFor(session.kind, column.name)).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const values = columns.map((column) => normalizeColumnValue(row[column.name], session.kind, column));
  await targetExecute(
    session,
    `INSERT INTO ${quoteIdentifierFor(session.kind, table)} (${columnSql}) VALUES (${placeholders})`,
    values,
  );
  return true;
}

function databaseSettingsForTarget(target: DatabaseConfig) {
  return {
    databaseConfigured: "true",
    databaseType: target.type,
    mysqlConfigured: target.type === "mysql" ? "true" : "false",
    mysqlHost: target.type === "mysql" ? target.mysql.host.trim() : "",
    mysqlDatabase: target.type === "mysql" ? target.mysql.database.trim() : "",
    postgresqlConfigured: target.type === "postgresql" ? "true" : "false",
    postgresqlHost: target.type === "postgresql" ? target.postgresql.host.trim() : "",
    postgresqlDatabase: target.type === "postgresql" ? target.postgresql.database.trim() : "",
    sqlitePath: target.type === "sqlite" ? target.sqlite.path.trim() : "",
    setupDataChoice: "use-existing",
    databaseSwitchLastAt: String(Math.floor(Date.now() / 1000)),
  } satisfies Record<string, string>;
}

async function upsertTargetSetting(session: TargetSession, key: string, value: string | null) {
  const now = Math.floor(Date.now() / 1000);
  await insertTargetRow(session, "system_settings", { key, value, updatedAt: now });
}

async function syncTargetPostgresqlSequences(session: TargetSession) {
  if (session.kind !== "postgresql") return;
  for (const table of MIGRATION_TABLES) {
    const tableDef = tableDefs.get(table);
    if (!tableDef?.columns.some((column) => column.type === "id")) continue;
    const tableName = quoteIdentifierFor("postgresql", table);
    await targetExecute(
      session,
      `SELECT setval(pg_get_serial_sequence(?, 'id')::regclass, GREATEST((SELECT COALESCE(MAX(${quoteIdentifierFor("postgresql", "id")}), 0) FROM ${tableName}), 1), (SELECT COALESCE(MAX(${quoteIdentifierFor("postgresql", "id")}), 0) FROM ${tableName}) > 0)`,
      [table],
    ).catch(() => undefined);
  }
}

/** 从源库一批读多少行。 */
export const DATABASE_SWITCH_COPY_BATCH_ROWS = 1000;
/** 打开写冻结之后等多久再开始读：让已经在路上的写请求落完。 */
const DATABASE_SWITCH_WRITE_DRAIN_MS = 2_000;

/** 按哪一列分页读：自增 id；没有 id 的表（system_settings）用唯一键。 */
function sourcePagingColumn(table: string) {
  const tableDef = tableDefs.get(table);
  return tableDef?.columns.find((column) => column.type === "id")?.name
    ?? tableDef?.unique?.[0]?.[0]
    ?? null;
}

/**
 * 按主键顺序一批一批读源表（keyset 分页：WHERE pk > 上一批最后一个 ORDER BY pk LIMIT n）。
 *
 * 原来是每张表一句 SELECT *，整个库读成一个大对象攒在内存里再往新库写：
 * 几百万行流量统计的面板，切换一次就是几个 G 的常驻内存，容器直接被 OOM 杀掉，
 * 而切换进行到一半被杀是最糟的结果。keyset 比 OFFSET 好在越往后不会越慢。
 */
async function* readSourceTableBatches(table: string, batchSize = DATABASE_SWITCH_COPY_BATCH_ROWS) {
  const tableSql = quoteDbIdentifier(table);
  const column = sourcePagingColumn(table);
  if (!column) {
    yield await queryRaw<Record<string, any>>(`SELECT * FROM ${tableSql}`);
    return;
  }
  const columnSql = quoteDbIdentifier(column);
  let last: unknown;
  for (;;) {
    const rows = await queryRaw<Record<string, any>>(
      last === undefined
        ? `SELECT * FROM ${tableSql} ORDER BY ${columnSql} LIMIT ${batchSize}`
        : `SELECT * FROM ${tableSql} WHERE ${columnSql} > ? ORDER BY ${columnSql} LIMIT ${batchSize}`,
      last === undefined ? [] : [last],
    );
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < batchSize) return;
    last = rows[rows.length - 1][column];
  }
}

/**
 * 在一个一致的读快照里跑整个源库读取 —— 只在便宜的方言上做。
 *
 * - PostgreSQL：独占一条连接开 REPEATABLE READ 只读事务，MVCC 快照，不挡任何写。
 * - MySQL（InnoDB）：独占一条连接开事务；默认隔离级别 REPEATABLE READ 下，第一次读
 *   就建立一致性快照（事务开始后没法再改隔离级别，服务器若被改成 READ COMMITTED，
 *   就只剩下面的写冻结兜底）。
 * - SQLite：整个面板只有一条连接，读事务要在这条连接上一直占着，等于切换期间面板
 *   所有查询（包括管理员看进度、登录校验）全部排队 —— 不做。靠写冻结保证一致：
 *   冻结后面板自己的写入入口（tRPC mutation、Agent 上报、调度器）都停了。
 */
async function withSourceReadSnapshot<T>(work: () => Promise<T>): Promise<T> {
  const kind = getDatabaseKind();
  if (kind !== "postgresql" && kind !== "mysql") return work();
  return withDatabaseTransaction(async () => {
    if (kind === "postgresql") {
      await executeRaw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    }
    return work();
  });
}

async function copySnapshotIntoTarget(
  session: TargetSession,
  target: DatabaseConfig,
  job: DatabaseSwitchJob,
) {
  setJobStage(job, "export", {
    progress: 34,
    currentTable: undefined,
    processedRows: 0,
    totalRows: undefined,
    processedTables: 0,
    totalTables: MIGRATION_TABLES.length,
  });
  return withSourceReadSnapshot(async () => {
    // 先数一遍每张表多少行（只为进度条），真正的读写在下面边读边写。
    const sourceCounts: Record<string, number> = {};
    for (let index = 0; index < MIGRATION_TABLES.length; index += 1) {
      const table = MIGRATION_TABLES[index];
      const rows = await queryRaw<{ count: number | string }>(
        `SELECT COUNT(*) AS ${quoteDbIdentifier("count")} FROM ${quoteDbIdentifier(table)}`,
      );
      sourceCounts[table] = Number(rows[0]?.count || 0);
      setJobStage(job, "export", {
        progress: 34 + Math.floor(((index + 1) / MIGRATION_TABLES.length) * 10),
        currentTable: table,
        processedTables: index + 1,
        totalTables: MIGRATION_TABLES.length,
        detail: `已统计源表 ${table}（${index + 1}/${MIGRATION_TABLES.length}，${sourceCounts[table]} 行）`,
      });
    }

    const inserted: Record<string, number> = {};
    const exportedCounts: Record<string, number> = {};
    const totalRows = MIGRATION_TABLES.reduce((sum, table) => sum + sourceCounts[table], 0);
    const populatedTables = MIGRATION_TABLES.filter((table) => sourceCounts[table] > 0);
    let processed = 0;
    let processedTables = 0;

    setJobStage(job, "transfer", {
      progress: 45,
      detail: `准备写入 ${totalRows} 行数据，涉及 ${populatedTables.length} 张表`,
      currentTable: undefined,
      processedRows: 0,
      totalRows,
      processedTables: 0,
      totalTables: populatedTables.length,
    });
    for (const table of populatedTables) {
      let tableRows = 0;
      for await (const batch of readSourceTableBatches(table)) {
        // 设置表里的运行时缓存（出口报的端口等）按这个面板的主机、规则 ID 记，不带走（与导出快照一致）。
        const rows = table === "system_settings"
          ? batch.filter((row) => !String(row?.key || "").startsWith(RUNTIME_CACHE_SETTING_PREFIX))
          : batch;
        for (const row of rows) {
          if (await insertTargetRow(session, table, row)) {
            inserted[table] = (inserted[table] || 0) + 1;
          }
        }
        exportedCounts[table] = (exportedCounts[table] || 0) + rows.length;
        tableRows += batch.length;
        processed += batch.length;
        setJobStage(job, "transfer", {
          progress: 45 + Math.floor((Math.min(processed, totalRows) / Math.max(1, totalRows)) * 46),
          detail: `正在写入 ${table}（本表 ${tableRows}/${sourceCounts[table]}，总计 ${processed}/${totalRows} 行）`,
          currentTable: table,
          processedRows: processed,
          totalRows,
          processedTables,
          totalTables: populatedTables.length,
        });
      }
      processedTables += 1;
      setJobStage(job, "transfer", {
        processedTables,
        detail: `已完成 ${table}（${processedTables}/${populatedTables.length} 张表，总计 ${processed}/${totalRows} 行）`,
      });
    }

    setJobStage(job, "transfer", {
      progress: 92,
      detail: "数据写入完成，正在同步数据库切换标记和序列",
      currentTable: "system_settings",
      processedRows: processed,
      totalRows,
      processedTables,
      totalTables: populatedTables.length,
    });
    for (const [key, value] of Object.entries(databaseSettingsForTarget(target))) {
      await upsertTargetSetting(session, key, value);
    }
    await syncTargetPostgresqlSequences(session);
    const summary = summarizeMigrationTableCounts(exportedCounts, { appVersion: APP_VERSION });
    return { summary, inserted };
  });
}

async function runTargetTransaction<T>(handle: TargetHandle, action: (session: TargetSession) => Promise<T>) {
  if (handle.kind === "mysql") {
    const conn = await handle.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await action({ kind: "mysql", executor: conn });
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }
  if (handle.kind === "postgresql") {
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action({ kind: "postgresql", executor: client });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  try {
    handle.sqlite.exec("BEGIN IMMEDIATE");
    const result = await action({ kind: "sqlite", executor: handle.sqlite });
    handle.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      handle.sqlite.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}

function scheduleRestartAfterSwitch() {
  if (restartScheduled) return;
  restartScheduled = true;
  setTimeout(() => {
    console.info("[DatabaseSwitch] exiting process to load the new database dialect");
    process.exit(0);
  }, 1500);
}

async function finalizeDatabaseSwitch(target: DatabaseConfig) {
  const restartRequired = getSchemaDialect() !== target.type;
  writeDatabaseConfig(target);
  if (restartRequired) {
    scheduleRestartAfterSwitch();
  } else {
    await reconnectDatabase();
    await ensureDatabaseSchema();
  }
  return restartRequired;
}

export function startDatabaseSwitch(target: DatabaseConfig) {
  if (activeJobId) {
    const active = getDatabaseSwitchJob(activeJobId);
    if (active?.status === "pending" || active?.status === "running") {
      throw new Error("已有数据库切换任务正在执行，请等待完成后再操作。");
    }
  }
  assertSwitchAllowed(target);

  const startedAt = Date.now();
  const job: DatabaseSwitchJob = {
    id: crypto.randomUUID(),
    status: "pending",
    progress: 0,
    step: "等待数据库切换开始",
    sourceType: readDatabaseConfig()?.type ?? null,
    targetType: target.type,
    startedAt,
    updatedAt: startedAt,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;

  void (async () => {
    let handle: TargetHandle | null = null;
    let keepWritesFrozen = false;
    try {
      setJobStage(job, "connection", { status: "running", progress: 5 });
      await testDatabaseConnection(target);

      setJobStage(job, "connection", { progress: 10, detail: "连接和数据库版本检查通过，正在建立迁移会话" });
      handle = await openTarget(target);

      setJobStage(job, "permissions", { progress: 15 });
      await verifyTargetWriteAccess(handle);

      setJobStage(job, "schema", { progress: 25 });
      if (handle.kind === "mysql") await ensureDatabaseSchema(handle.pool);
      else if (handle.kind === "postgresql") await ensureDatabaseSchema(handle.pool);
      else await ensureDatabaseSchema(handle.sqlite);

      // 从这里开始冻结面板的写入，直到切换结束（需要重启时一直冻到进程退出）。
      beginDatabaseMaintenance(`database-switch:${job.id}`);
      await new Promise<void>((resolve) => setTimeout(resolve, DATABASE_SWITCH_WRITE_DRAIN_MS));
      // 攒着没写的探测样本写进旧库，随后才整表读出来拷过去。
      await flushPendingWrites();
      const result = await runTargetTransaction(handle, async (session) => {
        setJobStage(job, "target-check", { progress: 32 });
        await assertTargetHasNoBusinessData(session);
        await targetExecute(session, `DELETE FROM ${quoteIdentifierFor(session.kind, "system_settings")}`);
        return copySnapshotIntoTarget(session, target, job);
      });

      if (handle.kind === "postgresql") {
        setJobStage(job, "optimize", { progress: 95 });
        await maintainPostgresqlDatabase(handle.pool, { forceAnalyze: true }).catch((error) => {
          console.warn("[PostgreSQL] Database switch maintenance skipped:", error instanceof Error ? error.message : String(error));
        });
      }

      setJobStage(job, "switch", { progress: 97 });
      const restartRequired = await finalizeDatabaseSwitch(target);
      // 要重启的话，旧库此刻已经不会再被迁走：别让任何写入再落进去。
      keepWritesFrozen = restartRequired;

      setJob(job, {
        status: "success",
        progress: 100,
        step: restartRequired ? "迁移完成，正在重启面板" : "迁移完成，已切换数据库",
        detail: restartRequired ? "目标数据库已就绪，面板进程正在重启" : "目标数据库已就绪并已启用新连接",
        message: restartRequired
          ? "目标数据库已迁移完成，面板将自动重启以加载新的数据库类型。"
          : "目标数据库已迁移完成，面板已切换到新的数据库连接。",
        restartRequired,
        summary: result.summary,
        inserted: result.inserted,
        finishedAt: Date.now(),
      });
    } catch (error) {
      const failedStep = job.step;
      const failure = error instanceof DatabaseSwitchValidationError
        ? error.failure
        : describeDatabaseSwitchFailure(error, target);
      console.warn(`[DatabaseSwitch] failed stage=${job.stage || "unknown"} code=${failure.code}: ${failure.detail}`);
      setJob(job, {
        status: "failed",
        progress: Math.max(job.progress, 1),
        step: `${failedStep}失败`,
        detail: failure.message,
        error: failure.message,
        errorCode: failure.code,
        errorDetail: failure.detail,
        suggestion: failure.suggestion,
        suggestionCommand: failure.suggestionCommand,
        failedStep,
        finishedAt: Date.now(),
      });
    } finally {
      if (!keepWritesFrozen) endDatabaseMaintenance();
      await closeTarget(handle);
      const latest = activeJobId ? getDatabaseSwitchJob(activeJobId) : null;
      if (latest && latest.id === job.id && latest.status !== "pending" && latest.status !== "running") {
        activeJobId = null;
      }
    }
  })();

  return job;
}
