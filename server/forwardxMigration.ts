/*
  从原版 ForwardX（poouo/Forwardx）面板迁到 NEX：读原版的数据库，转成 server/migration.ts 认的迁移快照。

  ── 为什么不直接拿 NEX 打开原版的库 ──
  NEX 是从原版分出来的，两边的表结构各自长了很久（对比的是原版 2.3.299）：
  - 原版有 26 张 NEX 没有的表（工单 support_tickets、推广 affiliate_*、运营统计 operations_* 等），
    NEX 有 60 多张原版没有的表；
  - 同名表里原版多出来的列（users.googleSubject、hosts.ipv4Addresses ……），
    NEX 写入时不会填，原地升级会留下一堆 NEX 不认识、也不维护的列；有的列名字不一样、意思一样
    （googleSubject ↔ googleSub、host_metrics.load1 ↔ loadAvg1）。
  所以迁移不动原版的库：只读地把数据读出来，按 NEX 的表结构过滤 / 换算成快照，再用面板迁移现成的
  importMigrationSnapshot 导进一个全新的 NEX 数据库（ID 保留、关联照映射、运行状态重置）。原库原样留着，
  迁坏了换回原版面板就行。

  ── 这个文件做什么 ──
  只做「读 + 换算 + 出报告」，不连 NEX 的库：
  - openForwardxSourceDatabase：只读打开原版的 SQLite / MySQL / PostgreSQL；
  - inspectForwardxSource：认一认这是不是原版 ForwardX 的库（已经是 NEX 的库就拒绝）、各表有多少行；
  - buildForwardxMigrationSnapshot：按 NEX 的表定义生成快照 + 迁移报告（哪些迁了、哪些换算了、哪些没迁）。
  导入在 server/forwardxMigrationCli.ts 里做（要先按目标库设置好方言再加载 NEX 的数据库模块）。
*/
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import pg from "pg";
import { FORWARDX_AGENT_DISTRIBUTION } from "../shared/agentDistribution";
import { FORWARDX_V3_MIN_AGENT_VERSION, FORWARDX_V3_MIN_FXP_VERSION } from "../shared/forwardXV3";
import type { MigrationSnapshot } from "./migration";

/** 从原版库里读出来的一行（列名 → 值）。 */
export type SourceRow = Record<string, unknown>;

export type ForwardxSourceKind = "sqlite" | "mysql" | "postgresql";

export type ForwardxServerConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

export type ForwardxSourceConfig =
  | { type: "sqlite"; path: string }
  | { type: "mysql"; config: ForwardxServerConfig }
  | { type: "postgresql"; config: ForwardxServerConfig };

export interface ForwardxSourceDatabase {
  kind: ForwardxSourceKind;
  listTables(): Promise<string[]>;
  listColumns(table: string): Promise<string[]>;
  selectAll(table: string): Promise<SourceRow[]>;
  countRows(table: string): Promise<number>;
  close(): Promise<void>;
}

/** NEX 目标库的表定义（dbSchema.getDatabaseTableDefs 的形状，只用到名字和列名）。 */
export type TargetTableDef = { name: string; columns: ReadonlyArray<{ name: string }> };

export type ForwardxTableReport = {
  table: string;
  rows: number;
  status: "migrated" | "converted" | "skipped";
  /** converted：换算进了 NEX 的哪张表 / 哪一列 */
  target?: string;
  note?: string;
};

export type ForwardxDroppedColumn = { table: string; column: string; rowsWithValue: number; note?: string };

export type ForwardxMigrationReport = {
  sourceKind: ForwardxSourceKind;
  generatedAt: number;
  counts: { users: number; hosts: number; forwardRules: number; tunnels: number; forwardGroups: number };
  tables: ForwardxTableReport[];
  droppedColumns: ForwardxDroppedColumn[];
  skippedSettings: string[];
  warnings: string[];
};

/* ───────────────────────── 读原版的库 ───────────────────────── */

function boolValue(value: unknown) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function normalizeKind(value: unknown): ForwardxSourceKind | "" {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "postgres" || text === "pg" || text === "postgresql") return "postgresql";
  if (text === "mysql" || text === "sqlite") return text;
  return "";
}

function serverConfigFromUrl(rawUrl: string, defaultPort: number): ForwardxServerConfig {
  const url = new URL(rawUrl);
  return {
    host: url.hostname,
    port: Number(url.port || defaultPort),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\/+/, ""),
    ssl: url.searchParams.get("ssl") === "true" || url.searchParams.get("sslmode") === "require",
  };
}

/** JSON 配置里的一个对象（不是对象就当空对象）。 */
function jsonObject(value: unknown): SourceRow {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as SourceRow) : {};
}

function serverConfigFromObject(value: unknown, defaultPort: number): ForwardxServerConfig | null {
  const input = jsonObject(value);
  if (!input?.host || !input?.user || !input?.database) return null;
  return {
    host: String(input.host).trim(),
    port: Number(input.port || defaultPort),
    user: String(input.user).trim(),
    password: String(input.password ?? ""),
    database: String(input.database).trim(),
    ssl: boolValue(input.ssl),
  };
}

function serverConfigFromEnv(env: Record<string, string | undefined>, kind: "mysql" | "postgresql"): ForwardxServerConfig | null {
  const pick = (...names: string[]) => {
    for (const name of names) {
      const value = String(env[name] ?? "").trim();
      if (value) return value;
    }
    return "";
  };
  if (kind === "mysql") {
    const url = pick("MYSQL_URL");
    if (url) return serverConfigFromUrl(url, 3306);
    const host = pick("MYSQL_HOST");
    const user = pick("MYSQL_USER");
    const database = pick("MYSQL_DATABASE");
    if (!host || !user || !database) return null;
    return { host, port: Number(pick("MYSQL_PORT") || 3306), user, password: env.MYSQL_PASSWORD ?? "", database, ssl: boolValue(env.MYSQL_SSL) };
  }
  const url = pick("POSTGRES_URL", "POSTGRESQL_URL", "PG_URL");
  if (url) return serverConfigFromUrl(url, 5432);
  const host = pick("POSTGRES_HOST", "POSTGRESQL_HOST", "PGHOST");
  const user = pick("POSTGRES_USER", "POSTGRESQL_USER", "PGUSER");
  const database = pick("POSTGRES_DATABASE", "POSTGRESQL_DATABASE", "PGDATABASE");
  if (!host || !user || !database) return null;
  return {
    host,
    port: Number(pick("POSTGRES_PORT", "POSTGRESQL_PORT", "PGPORT") || 5432),
    user,
    password: env.POSTGRES_PASSWORD ?? env.POSTGRESQL_PASSWORD ?? env.PGPASSWORD ?? "",
    database,
    ssl: boolValue(env.POSTGRES_SSL ?? env.POSTGRESQL_SSL ?? env.PGSSL),
  };
}

/** 路径映射：备份目录 / 容器里挂载的位置和原配置里写的不一样（/data/forwardx.db → /source/forwardx.db）。 */
export function mapSourcePath(filePath: string, pathMap: Array<[string, string]>) {
  const resolved = path.posix.normalize(filePath);
  for (const [from, to] of pathMap) {
    const prefix = path.posix.normalize(from).replace(/\/+$/, "");
    if (resolved === prefix) return to;
    if (resolved.startsWith(prefix + "/")) return path.posix.join(to, resolved.slice(prefix.length + 1));
  }
  return filePath;
}

/*
  原版面板找数据库的顺序（照原版 server/dbRuntime.ts readDatabaseConfig）：
  环境变量里显式的 DATABASE_TYPE → MYSQL_* / POSTGRES_* 环境变量 → database.json → 老的 mysql.json → SQLITE_PATH。
  envFile 是原版部署的 .env（本机部署在部署目录下；Docker 部署是 Compose 的 .env）。
*/
export function resolveForwardxSourceConfig(options: {
  sqlitePath?: string | null;
  configPath?: string | null;
  legacyMysqlPath?: string | null;
  envFile?: string | null;
  env?: Record<string, string | undefined>;
  pathMap?: Array<[string, string]>;
  defaultSqlitePath?: string | null;
}): ForwardxSourceConfig {
  const pathMap = options.pathMap || [];
  if (options.sqlitePath) return { type: "sqlite", path: path.resolve(options.sqlitePath) };
  const env: Record<string, string | undefined> = { ...(options.env || {}) };
  if (options.envFile && fs.existsSync(options.envFile)) {
    Object.assign(env, dotenv.parse(fs.readFileSync(options.envFile, "utf8")));
  }
  const sqliteFromEnv = () => {
    const configured = String(env.SQLITE_PATH || options.defaultSqlitePath || "/data/forwardx.db");
    return path.resolve(mapSourcePath(configured, pathMap));
  };
  const explicit = normalizeKind(env.DATABASE_TYPE || env.DB_TYPE);
  const envMysql = serverConfigFromEnv(env, "mysql");
  const envPostgres = serverConfigFromEnv(env, "postgresql");
  if (explicit === "sqlite") return { type: "sqlite", path: sqliteFromEnv() };
  if (explicit === "mysql" && envMysql) return { type: "mysql", config: envMysql };
  if (explicit === "postgresql" && envPostgres) return { type: "postgresql", config: envPostgres };
  if (envPostgres) return { type: "postgresql", config: envPostgres };
  if (envMysql) return { type: "mysql", config: envMysql };

  const configPath = options.configPath ? path.resolve(options.configPath) : "";
  if (configPath && fs.existsSync(configPath)) {
    let parsed: SourceRow;
    try {
      parsed = jsonObject(JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch (error) {
      throw new Error(`原版面板的数据库配置 ${configPath} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    const type = normalizeKind(parsed?.type);
    if (type === "sqlite") {
      const configured = String(jsonObject(parsed.sqlite).path || parsed.path || env.SQLITE_PATH || options.defaultSqlitePath || "/data/forwardx.db");
      return { type, path: path.resolve(mapSourcePath(configured, pathMap)) };
    }
    if (type === "mysql") {
      const config = serverConfigFromObject(parsed.mysql || parsed, 3306);
      if (config) return { type, config };
    }
    if (type === "postgresql") {
      const config = serverConfigFromObject(parsed.postgresql || parsed.postgres || parsed.pg || parsed, 5432);
      if (config) return { type, config };
    }
    throw new Error(`原版面板的数据库配置 ${configPath} 不完整（type=${String(parsed?.type || "空")}）`);
  }
  const legacyMysqlPath = options.legacyMysqlPath ? path.resolve(options.legacyMysqlPath) : "";
  if (legacyMysqlPath && fs.existsSync(legacyMysqlPath)) {
    const config = serverConfigFromObject(JSON.parse(fs.readFileSync(legacyMysqlPath, "utf8")), 3306);
    if (config) return { type: "mysql", config };
  }
  const sqlitePath = sqliteFromEnv();
  if (fs.existsSync(sqlitePath)) return { type: "sqlite", path: sqlitePath };
  throw new Error(`找不到原版面板的数据库：没有 ${configPath || "database.json"}，也没有 ${sqlitePath}`);
}

/** 打码后的来源描述（日志 / 确认提示里用，不带密码）。 */
export function describeForwardxSource(config: ForwardxSourceConfig) {
  if (config.type === "sqlite") return `SQLite ${config.path}`;
  const kind = config.type === "mysql" ? "MySQL" : "PostgreSQL";
  return `${kind} ${config.config.user}@${config.config.host}:${config.config.port}/${config.config.database}${config.config.ssl ? " (SSL)" : ""}`;
}

function pgSql(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => "$" + String(++index));
}

function quoteFor(kind: ForwardxSourceKind, name: string) {
  if (kind === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

/** 只读打开原版的库。SQLite 用 readonly 打开；MySQL / PostgreSQL 把会话设成只读事务。 */
export async function openForwardxSourceDatabase(config: ForwardxSourceConfig): Promise<ForwardxSourceDatabase> {
  if (config.type === "sqlite") {
    if (!fs.existsSync(config.path)) throw new Error(`原版面板的 SQLite 数据库不存在：${config.path}`);
    const sqlite = new Database(config.path, { readonly: true, fileMustExist: true });
    sqlite.pragma("busy_timeout = 10000");
    return {
      kind: "sqlite",
      async listTables() {
        return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
          .map((row) => String(row.name));
      },
      async listColumns(table) {
        return (sqlite.prepare(`PRAGMA table_info(${quoteFor("sqlite", table)})`).all() as Array<{ name: string }>).map((row) => String(row.name));
      },
      async selectAll(table) {
        return sqlite.prepare(`SELECT * FROM ${quoteFor("sqlite", table)} ORDER BY rowid`).all() as SourceRow[];
      },
      async countRows(table) {
        return Number((sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteFor("sqlite", table)}`).get() as SourceRow | undefined)?.count || 0);
      },
      async close() {
        sqlite.close();
      },
    };
  }
  if (config.type === "mysql") {
    const connection = await mysql.createConnection({
      host: config.config.host,
      port: config.config.port,
      user: config.config.user,
      password: config.config.password,
      database: config.config.database,
      ssl: config.config.ssl ? {} : undefined,
      connectTimeout: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      // 时间列在原版里都是整数秒，不会有 DATETIME；这里只是保证万一有也不被换成本地时区
      timezone: "Z",
    });
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    return {
      kind: "mysql",
      async listTables() {
        const [rows] = await connection.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
        return (rows as SourceRow[]).map((row) => String(row.name));
      },
      async listColumns(table) {
        const [rows] = await connection.query(
          "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
          [table],
        );
        return (rows as SourceRow[]).map((row) => String(row.name));
      },
      async selectAll(table) {
        const [rows] = await connection.query(`SELECT * FROM ${quoteFor("mysql", table)}`);
        return rows as SourceRow[];
      },
      async countRows(table) {
        const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM ${quoteFor("mysql", table)}`);
        return Number((rows as SourceRow[])[0]?.count || 0);
      },
      async close() {
        await connection.end();
      },
    };
  }
  const client = new pg.Client({
    host: config.config.host,
    port: config.config.port,
    user: config.config.user,
    password: config.config.password,
    database: config.config.database,
    connectionTimeoutMillis: 10_000,
    ssl: config.config.ssl ? true : undefined,
  });
  await client.connect();
  await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  return {
    kind: "postgresql",
    async listTables() {
      const result = await client.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'");
      return result.rows.map((row) => String(row.name));
    },
    async listColumns(table) {
      const result = await client.query(
        pgSql("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position"),
        [table],
      );
      return result.rows.map((row) => String(row.name));
    },
    async selectAll(table) {
      const result = await client.query(`SELECT * FROM ${quoteFor("postgresql", table)}`);
      return result.rows as SourceRow[];
    },
    async countRows(table) {
      const result = await client.query(`SELECT COUNT(*) AS count FROM ${quoteFor("postgresql", table)}`);
      return Number(result.rows[0]?.count || 0);
    },
    async close() {
      await client.end();
    },
  };
}

/* ───────────────────────── 认库 ───────────────────────── */

/** 只有 NEX 才有的表：库里有这几张，说明已经是 NEX 的库（或者被 NEX 原地升级过），不能当原版迁。 */
const NEX_ONLY_MARKER_TABLES = ["proxy_inbounds", "ui_theme_packages", "panel_events", "proxy_sub_tokens"];
const REQUIRED_SOURCE_TABLES = ["users", "hosts", "system_settings"];

export type ForwardxSourceInspection = {
  kind: ForwardxSourceKind;
  isForwardx: boolean;
  looksLikeNex: boolean;
  missingTables: string[];
  nexMarkerTables: string[];
  counts: ForwardxMigrationReport["counts"];
  tableCount: number;
};

async function countRows(source: ForwardxSourceDatabase, tables: Set<string>, table: string) {
  if (!tables.has(table)) return 0;
  return source.countRows(table);
}

export async function inspectForwardxSource(source: ForwardxSourceDatabase): Promise<ForwardxSourceInspection> {
  const tables = new Set(await source.listTables());
  const missingTables = REQUIRED_SOURCE_TABLES.filter((table) => !tables.has(table));
  const nexMarkerTables = NEX_ONLY_MARKER_TABLES.filter((table) => tables.has(table));
  return {
    kind: source.kind,
    isForwardx: missingTables.length === 0 && nexMarkerTables.length === 0,
    looksLikeNex: nexMarkerTables.length > 0,
    missingTables,
    nexMarkerTables,
    counts: {
      users: await countRows(source, tables, "users"),
      hosts: await countRows(source, tables, "hosts"),
      forwardRules: await countRows(source, tables, "forward_rules"),
      tunnels: await countRows(source, tables, "tunnels"),
      forwardGroups: await countRows(source, tables, "forward_groups"),
    },
    tableCount: tables.size,
  };
}

/* ───────────────────────── 换算 ───────────────────────── */

/*
  NEX 也有、但不从原版带过来的表：
  插件是按原版的插件商店装的（插件包、下发到 Agent 的脚本），NEX 的官方插件和商店是另一套，
  照搬过来要么装不上、要么下发出去的脚本对不上 NEX 的 Agent。迁完在 NEX 的插件商店重新装。
*/
const SKIPPED_SHARED_TABLES: Record<string, string> = {
  plugins: "插件按原版商店装的，NEX 的插件和商店是另一套，迁完请在 NEX 插件商店重新安装",
  plugin_assets: "随插件一起不迁",
  plugin_agent_states: "随插件一起不迁",
  plugin_store_sources: "插件商店地址不迁，NEX 用自己的官方商店",
};

/** 原版独有的表：换算进 NEX 的（target 非空）和不迁的原因。 */
const FORWARDX_ONLY_TABLES: Record<string, { target?: string; note: string }> = {
  support_tickets: { target: "tickets", note: "工单标题、状态、优先级换算成 NEX 工单" },
  support_ticket_messages: { target: "ticket_messages", note: "公开回复换算成 NEX 工单消息；内部备注和系统事件不迁" },
  support_ticket_attachments: { note: "工单附件不迁（NEX 工单没有附件）" },
  support_ticket_reads: { note: "工单已读状态不迁" },
  support_canned_replies: { note: "工单快捷回复不迁" },
  affiliate_referrals: { target: "users.inviterId", note: "推广关系换算成 NEX 的邀请人" },
  affiliate_accounts: { note: "推广账户余额不迁（NEX 的返佣直接进余额），迁移前请先结清" },
  affiliate_codes: { note: "推广码不迁，NEX 每个用户有自己的邀请码" },
  affiliate_commissions: { note: "历史佣金记录不迁" },
  affiliate_withdrawals: { note: "提现记录不迁" },
  affiliate_ledger: { note: "推广流水不迁" },
  ai_bot_workflows: { note: "NEX 没有对应功能" },
  external_mcp_tokens: { note: "原版的 MCP 令牌不迁，NEX 请在「API 令牌」里重新创建" },
  agent_installations: { note: "Agent 实例绑定，NEX 在 Agent 重连后重新记录" },
  host_availability_intervals: { note: "在线率历史不迁，NEX 重新累计" },
  resource_traffic_baselines: { note: "流量基线是运行状态，NEX 重新累计" },
  operations_traffic_daily: { note: "运营统计不迁，NEX 重新累计" },
  operations_source_daily: { note: "运营统计不迁，NEX 重新累计" },
  operations_source_status: { note: "运营统计不迁" },
  operations_ip_geo: { note: "IP 归属地缓存不迁" },
  operations_alert_state: { note: "告警运行状态不迁" },
  operations_alert_events: { note: "告警历史不迁" },
  resource_alert_service_state: { note: "告警运行状态不迁" },
  host_probe_health: { note: "探测健康状态不迁" },
  host_ip_switch_attempts: { note: "换 IP 记录不迁" },
};

/** 原版多出来、但能对上 NEX 某一列的：列名换一下（只在 NEX 那一列没值时填）。 */
const RENAMED_COLUMNS: Record<string, Record<string, string>> = {
  users: { googleSubject: "googleSub" },
  hosts: { ddnsAddressMode: "ddnsValueMode" },
  host_metrics: { load1: "loadAvg1", load5: "loadAvg5", load15: "loadAvg15" },
  host_probe_services: { timeoutSeconds: "httpTimeoutSeconds", expectedStatus: "httpExpectedStatus" },
};

/** 原版多出来的列里，值得在报告里单独说一句的。 */
const DROPPED_COLUMN_NOTES: Record<string, string> = {
  "host_probe_services.targetUrl": "HTTP 探测的地址换算到 host_probe_services.targetIp",
  "subscription_plans.trafficMode": "原版套餐的计费方向，NEX 套餐按双向计",
  "hosts.ipv4Addresses": "Agent 重连后 NEX 会重新上报网卡地址",
  "hosts.ipv6Addresses": "同上",
  "hosts.preferredIpv4": "首选地址请在 NEX 主机详情里重新选",
  "hosts.preferredIpv6": "同上",
  "hosts.resourceAlertConfig": "单机告警阈值请在 NEX 里重新设置",
  "traffic_billing_configs.name": "原版流量计费配置的名称 / 排序不迁",
  "traffic_billing_configs.sortOrder": "同上",
};

/*
  不带过来的设置：
  - runtimeCache:*：按旧库的主机 / 规则 ID 记的运行时缓存；
  - 数据库配置、安装向导状态：由新库和安装脚本重新写；
  - 面板迁移 / 无缝迁移状态：原版面板自己的迁移进度，带过来会让 NEX 以为自己在迁移中；
  - 面板版本、升级相关：NEX 自己管。
*/
const SKIPPED_SETTING_PATTERNS: RegExp[] = [
  /^runtimeCache:/,
  /^(databaseConfigured|databaseType|sqlitePath|setupDataChoice)$/,
  /^(mysql|postgresql)(Configured|Host|Port|User|Database|Ssl)$/,
  /^(migratedToPanelUrl|migratedAt)$/,
  /^panelMigration/,
  /^agentMigrationTarget/,
  /^seamless/i,
  /^lastPanel(BackupImport|Import|Migration)/,
  /^settingsSecretsEncryptedV1$/,
  /^panelUpgrade/,
];

export function isSkippedForwardxSetting(key: string) {
  return SKIPPED_SETTING_PATTERNS.some((pattern) => pattern.test(key));
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== "" && value !== 0 && value !== "0" && value !== false;
}

function epochSeconds(value: unknown) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

const TICKET_STATUS_MAP: Record<string, string> = {
  open: "waiting_staff",
  in_progress: "waiting_staff",
  waiting_user: "waiting_user",
  resolved: "closed",
  closed: "closed",
};
const TICKET_PRIORITY_MAP: Record<string, string> = { low: "low", normal: "medium", high: "high", urgent: "high" };

function convertSupportTickets(tickets: SourceRow[], messages: SourceRow[]) {
  const publicReplies = messages.filter((message) => (
    String(message.kind || "reply") === "reply" && String(message.visibility || "public") === "public"
  ));
  const lastByTicket = new Map<number, SourceRow>();
  for (const message of publicReplies) {
    const ticketId = Number(message.ticketId);
    const previous = lastByTicket.get(ticketId);
    if (!previous || (epochSeconds(message.createdAt) || 0) >= (epochSeconds(previous.createdAt) || 0)) lastByTicket.set(ticketId, message);
  }
  const ticketRows = tickets.map((ticket) => {
    const status = TICKET_STATUS_MAP[String(ticket.status || "").trim()] || "waiting_staff";
    const last = lastByTicket.get(Number(ticket.id));
    const createdAt = epochSeconds(ticket.createdAt) || Math.floor(Date.now() / 1000);
    return {
      id: ticket.id,
      userId: ticket.userId,
      title: String(ticket.title || "（无标题）").slice(0, 128),
      priority: TICKET_PRIORITY_MAP[String(ticket.priority || "").trim()] || "medium",
      status,
      lastMessageAt: epochSeconds(last?.createdAt) || epochSeconds(ticket.updatedAt) || createdAt,
      lastMessageByStaff: last ? String(last.authorRole || "") !== "user" : false,
      closedAt: status === "closed" ? (epochSeconds(ticket.closedAt) || epochSeconds(ticket.resolvedAt) || epochSeconds(ticket.updatedAt)) : null,
      createdAt,
      updatedAt: epochSeconds(ticket.updatedAt) || createdAt,
    };
  });
  const messageRows = publicReplies.map((message) => ({
    id: message.id,
    ticketId: message.ticketId,
    senderId: message.authorId ?? null,
    isStaff: String(message.authorRole || "") !== "user",
    content: String(message.content ?? ""),
    createdAt: epochSeconds(message.createdAt) || Math.floor(Date.now() / 1000),
  }));
  return { ticketRows, messageRows, skippedMessages: messages.length - publicReplies.length };
}

function adaptRow(table: string, row: SourceRow, context: { inviterByUser: Map<number, number> }) {
  const next = { ...row };
  for (const [from, to] of Object.entries(RENAMED_COLUMNS[table] || {})) {
    if (hasValue(next[from]) && !hasValue(next[to])) next[to] = next[from];
  }
  switch (table) {
    case "users": {
      const inviterId = context.inviterByUser.get(Number(next.id));
      if (inviterId && inviterId !== Number(next.id) && !hasValue(next.inviterId)) next.inviterId = inviterId;
      break;
    }
    case "hosts":
      // 还没收到心跳前先记成原版的 Agent：迁移排队靠它（server/forwardxAgentMigration.ts），第一次心跳会按实际改
      next.agentDistribution = FORWARDX_AGENT_DISTRIBUTION;
      next.agentUpgradeTargetDistribution = null;
      break;
    case "tunnels":
      // NEX 2.3.527 起也有 V3（同名列）。原版用 V3 的隧道迁成 NEX V3：原版 v3Multiplex 空着表示「默认开」，
      // NEX 这一列不能空、默认关，所以按原版的意思填 true。没用 V3 的隧道，原版残留的 v3 参数清掉，免得以后
      // 切到 V3 时带上一份没人设过的旧值。
      if (String(next.forwardxVersion || "").trim().toLowerCase() === "v3") {
        next.forwardxVersion = "v3";
        next.v3Multiplex = hasValue(next.v3Multiplex) ? Boolean(Number(next.v3Multiplex) || next.v3Multiplex === true) : true;
      } else {
        for (const key of ["v3Transport", "v3Host", "v3Path", "v3UserAgent", "v3ServerName"]) next[key] = null;
        next.v3Multiplex = false;
      }
      break;
    case "host_probe_services":
      if (String(next.method || "") === "http" && hasValue(row.targetUrl)) next.targetIp = row.targetUrl;
      if (next.httpExpectedStatus !== undefined && next.httpExpectedStatus !== null) next.httpExpectedStatus = String(next.httpExpectedStatus);
      break;
    default:
      break;
  }
  return next;
}

/**
 * 把原版的库换算成 NEX 的迁移快照。
 * targetDefs：NEX 的表定义；migrationTables：NEX 迁移要带的表（dbSchema.MIGRATION_TABLES），按它的顺序生成。
 */
export async function buildForwardxMigrationSnapshot(
  source: ForwardxSourceDatabase,
  options: { targetDefs: readonly TargetTableDef[]; migrationTables: readonly string[]; sourcePanelUrl?: string },
): Promise<{ snapshot: MigrationSnapshot; report: ForwardxMigrationReport }> {
  const sourceTables = new Set(await source.listTables());
  const targetByName = new Map(options.targetDefs.map((def) => [def.name, def]));
  const report: ForwardxMigrationReport = {
    sourceKind: source.kind,
    generatedAt: Date.now(),
    counts: { users: 0, hosts: 0, forwardRules: 0, tunnels: 0, forwardGroups: 0 },
    tables: [],
    droppedColumns: [],
    skippedSettings: [],
    warnings: [],
  };
  const tables: MigrationSnapshot["tables"] = {};
  const rowsCache = new Map<string, SourceRow[]>();
  const readTable = async (table: string) => {
    if (!sourceTables.has(table)) return [];
    if (!rowsCache.has(table)) rowsCache.set(table, await source.selectAll(table));
    return rowsCache.get(table)!;
  };

  // 推广关系 → 邀请人：被推广的用户（userId）记上推广人（affiliateUserId）
  const inviterByUser = new Map<number, number>();
  for (const referral of await readTable("affiliate_referrals")) {
    const userId = Number(referral.userId);
    const inviterId = Number(referral.affiliateUserId);
    if (userId > 0 && inviterId > 0 && !inviterByUser.has(userId)) inviterByUser.set(userId, inviterId);
  }

  const pushTable = async (table: string, rows: SourceRow[], status: ForwardxTableReport["status"], extra: Partial<ForwardxTableReport> = {}) => {
    const def = targetByName.get(table);
    if (!def) return;
    const allowed = new Set(def.columns.map((column) => column.name));
    const sourceColumns = sourceTables.has(table) ? await source.listColumns(table) : [];
    const renamed = RENAMED_COLUMNS[table] || {};
    for (const column of sourceColumns) {
      if (allowed.has(column)) continue;
      const rowsWithValue = rows.filter((row) => hasValue(row[column])).length;
      report.droppedColumns.push({
        table,
        column,
        rowsWithValue,
        note: renamed[column] ? `换算到 ${table}.${renamed[column]}` : DROPPED_COLUMN_NOTES[`${table}.${column}`],
      });
    }
    tables[table] = rows.map((row) => {
      const filtered: SourceRow = {};
      for (const [key, value] of Object.entries(row)) {
        if (allowed.has(key) && value !== undefined) filtered[key] = value;
      }
      return filtered;
    });
    report.tables.push({ table, rows: rows.length, status, ...extra });
  };

  for (const table of options.migrationTables) {
    if (SKIPPED_SHARED_TABLES[table]) {
      if (sourceTables.has(table)) {
        report.tables.push({ table, rows: await source.countRows(table), status: "skipped", note: SKIPPED_SHARED_TABLES[table] });
      }
      continue;
    }
    if (table === "tickets" || table === "ticket_messages") continue; // 下面从原版工单换算
    if (!sourceTables.has(table)) continue;
    let rows = (await readTable(table)).map((row) => adaptRow(table, row, { inviterByUser }));
    if (table === "system_settings") {
      const kept: SourceRow[] = [];
      for (const row of rows) {
        const key = String(row.key || "");
        // 面板公开地址由导入时的 targetPanelUrl 写（importMigrationSnapshot 不收快照里的这一项），这里不算「没迁」
        if (key === "panelPublicUrl") continue;
        if (!key || isSkippedForwardxSetting(key)) {
          if (key) report.skippedSettings.push(key);
          continue;
        }
        kept.push(row);
      }
      rows = kept;
    }
    await pushTable(table, rows, "migrated");
  }

  // 原版工单 → NEX 工单
  if (sourceTables.has("support_tickets") && targetByName.has("tickets")) {
    const converted = convertSupportTickets(await readTable("support_tickets"), await readTable("support_ticket_messages"));
    tables.tickets = converted.ticketRows;
    tables.ticket_messages = converted.messageRows;
    report.tables.push({ table: "support_tickets", rows: converted.ticketRows.length, status: "converted", target: "tickets", note: FORWARDX_ONLY_TABLES.support_tickets.note });
    report.tables.push({
      table: "support_ticket_messages",
      rows: converted.messageRows.length,
      status: "converted",
      target: "ticket_messages",
      note: converted.skippedMessages > 0
        ? `${FORWARDX_ONLY_TABLES.support_ticket_messages.note}（跳过 ${converted.skippedMessages} 条）`
        : FORWARDX_ONLY_TABLES.support_ticket_messages.note,
    });
  }

  for (const table of [...sourceTables].sort()) {
    if (targetByName.has(table)) continue; // NEX 也有的表上面处理过了（NEX 只在运行时用、不迁的表也不报）
    if (table === "support_tickets" || table === "support_ticket_messages") continue;
    const rows = await source.countRows(table);
    const known = FORWARDX_ONLY_TABLES[table];
    if (known?.target) {
      report.tables.push({ table, rows, status: "converted", target: known.target, note: known.note });
    } else {
      report.tables.push({ table, rows, status: "skipped", note: known?.note || "NEX 没有这张表，不迁" });
    }
  }

  const count = (table: string) => tables[table]?.length || 0;
  report.counts = {
    users: count("users"),
    hosts: count("hosts"),
    forwardRules: count("forward_rules"),
    tunnels: count("tunnels"),
    forwardGroups: count("forward_groups"),
  };
  const v3Tunnels = (await readTable("tunnels")).filter((row) => String(row.forwardxVersion || "").trim().toLowerCase() === "v3").length;
  if (v3Tunnels > 0) report.warnings.push(`${v3Tunnels} 条隧道用的是原版的 FXP V3，迁成 NEX V3：两端主机要升级到 Agent ${FORWARDX_V3_MIN_AGENT_VERSION}、FXP ${FORWARDX_V3_MIN_FXP_VERSION} 才能跑；NEX V3 和原版 V3 线上不互通，两端都换成 NEX 后再启用`);
  const affiliateBalance = (await readTable("affiliate_accounts")).filter((row) => Number(row.availableCents || 0) > 0).length;
  if (affiliateBalance > 0) report.warnings.push(`${affiliateBalance} 个推广账户还有未提现余额，NEX 不迁这部分，请迁移前结清或手动给用户加余额`);
  const plugins = sourceTables.has("plugins") ? await source.countRows("plugins") : 0;
  if (plugins > 0) report.warnings.push(`原版装了 ${plugins} 个插件，NEX 不迁插件，迁完请在 NEX 插件商店重新安装需要的插件`);

  const snapshot: MigrationSnapshot = {
    version: 1,
    exportedAt: Date.now(),
    appVersion: "forwardx",
    sourcePanelUrl: options.sourcePanelUrl,
    dataScope: "full",
    tables,
  };
  return { snapshot, report };
}

/** 报告的纯文本版（安装脚本直接打到终端）。 */
export function formatForwardxMigrationReport(report: ForwardxMigrationReport) {
  const lines: string[] = [];
  lines.push(`用户 ${report.counts.users}、主机 ${report.counts.hosts}、转发规则 ${report.counts.forwardRules}、隧道 ${report.counts.tunnels}、转发组 ${report.counts.forwardGroups}`);
  const converted = report.tables.filter((item) => item.status === "converted");
  if (converted.length > 0) {
    lines.push("换算迁移：");
    for (const item of converted) lines.push(`  - ${item.table}（${item.rows} 行）→ ${item.target}：${item.note || ""}`);
  }
  const skipped = report.tables.filter((item) => item.status === "skipped" && item.rows > 0);
  if (skipped.length > 0) {
    lines.push("没有迁移：");
    for (const item of skipped) lines.push(`  - ${item.table}（${item.rows} 行）：${item.note || ""}`);
  }
  const dropped = report.droppedColumns.filter((item) => item.rowsWithValue > 0);
  if (dropped.length > 0) {
    lines.push("丢弃的列（NEX 没有，原库里有值）：");
    for (const item of dropped) lines.push(`  - ${item.table}.${item.column}（${item.rowsWithValue} 行有值）${item.note ? `：${item.note}` : ""}`);
  }
  for (const warning of report.warnings) lines.push(`注意：${warning}`);
  return lines.join("\n");
}
