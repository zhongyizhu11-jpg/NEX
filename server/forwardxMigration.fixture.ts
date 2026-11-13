/*
  测试用：按原版 ForwardX 2.3.299 的表结构（testdata/forwardx-upstream-2.3.299-schema.json，从原版
  server/dbSchema.ts 的源码文本整理出来的 84 张表）建一个库，再塞一套有代表性的数据：
  两个用户（管理员 + 被推广来的普通用户）、两台主机、一条原版 FXP V3 隧道（多路复用列空着）、
  端口转发和隧道转发各一条、工单（公开回复 + 内部备注）、推广关系、插件、HTTP 探测、负载指标、
  运行时缓存和面板迁移状态这类不该带走的设置。SQLite 和 PostgreSQL 两种（建表语句照原版的写法）。
*/
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type mysql from "mysql2/promise";
import type pg from "pg";

type FixtureColumn = [name: string, type: string, notNull?: number, defaultValue?: unknown];
type Dialect = "sqlite" | "postgresql" | "mysql";

const schemaFile = path.resolve(import.meta.dirname, "..", "testdata", "forwardx-upstream-2.3.299-schema.json");

export function loadForwardxUpstreamSchema(): Record<string, FixtureColumn[]> {
  return JSON.parse(fs.readFileSync(schemaFile, "utf8")).tables;
}

function columnType(dialect: Dialect, type: string) {
  if (dialect === "sqlite") {
    if (type === "text" || type === "longtext" || type === "varchar") return "TEXT";
    return type === "real" ? "REAL" : "INTEGER";
  }
  if (dialect === "mysql") {
    return ({ text: "TEXT", longtext: "LONGTEXT", varchar: "VARCHAR(255)", int: "INT", bigint: "BIGINT", real: "DOUBLE", bool: "BOOLEAN", epoch: "INT" } as Record<string, string>)[type] || "TEXT";
  }
  return ({ text: "TEXT", longtext: "TEXT", varchar: "VARCHAR(255)", int: "INTEGER", bigint: "BIGINT", real: "DOUBLE PRECISION", bool: "BOOLEAN", epoch: "INTEGER" } as Record<string, string>)[type] || "TEXT";
}

function columnDefault(dialect: Dialect, value: unknown, type: string) {
  if (value === undefined || value === null) return "";
  // 原版在 MySQL 上不给 TEXT 列写默认值（MySQL 不允许）
  if (dialect === "mysql" && (type === "text" || type === "longtext")) return "";
  if (value === "now") {
    if (dialect === "mysql") return " DEFAULT (UNIX_TIMESTAMP())";
    return dialect === "sqlite" ? " DEFAULT (unixepoch())" : " DEFAULT (EXTRACT(EPOCH FROM NOW())::INT)";
  }
  if (typeof value === "boolean") return dialect === "postgresql" ? ` DEFAULT ${value ? "TRUE" : "FALSE"}` : ` DEFAULT ${value ? 1 : 0}`;
  if (typeof value === "number") return ` DEFAULT ${value}`;
  return ` DEFAULT '${String(value).replace(/'/g, "''")}'`;
}

const NOW = 1_760_000_000;

/** 建表语句 + 要插的行（按原版表结构补齐 NOT NULL 又没默认值的列）。 */
function fixtureStatements(dialect: Dialect) {
  const schema = loadForwardxUpstreamSchema();
  const ddl = Object.entries(schema).map(([table, columns]) => {
    const q = (name: string) => (dialect === "mysql" ? `\`${name}\`` : `"${name}"`);
    const idType = dialect === "sqlite" ? "INTEGER PRIMARY KEY AUTOINCREMENT" : dialect === "mysql" ? "BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY" : "BIGSERIAL PRIMARY KEY";
    const parts = columns.map(([name, type, notNull, defaultValue]) => (type === "id"
      ? `${q(name)} ${idType}`
      : `${q(name)} ${columnType(dialect, type)}${notNull ? " NOT NULL" : ""}${columnDefault(dialect, defaultValue, type)}`));
    return `CREATE TABLE ${q(table)} (${parts.join(", ")})${dialect === "mysql" ? " DEFAULT CHARSET=utf8mb4" : ""}`;
  });
  const rows: Array<{ table: string; row: Record<string, unknown> }> = [];
  const insert = (table: string, values: Record<string, unknown>) => {
    const columns = schema[table];
    if (!columns) throw new Error(`原版没有表 ${table}`);
    const row: Record<string, unknown> = {};
    for (const [name, type, notNull, defaultValue] of columns) {
      let value: unknown;
      if (name in values) value = values[name];
      else if (notNull && defaultValue === undefined && type !== "id") {
        value = type === "text" || type === "longtext" || type === "varchar" ? "" : (type === "epoch" ? NOW : (type === "bool" ? false : 0));
      } else continue;
      if (type === "bool" && value !== null) value = dialect === "postgresql" ? !!value : (value ? 1 : 0);
      row[name] = value;
    }
    for (const key of Object.keys(values)) if (!(key in row)) throw new Error(`原版 ${table} 没有列 ${key}`);
    rows.push({ table, row });
  };
  const now = NOW;
  insert("users", { id: 1, username: "admin", password: "salt:hash", role: "admin", email: "admin@example.com", createdAt: now, updatedAt: now });
  insert("users", { id: 7, username: "alice", password: "salt:hash2", role: "user", googleSubject: "google-sub-alice", createdAt: now, updatedAt: now });
  insert("hosts", { id: 10, name: "入口-香港", ip: "203.0.113.10", ipv4: "203.0.113.10", hostType: "slave", agentToken: "tok-entry", userId: 1, agentVersion: "2.2.211", isOnline: true, lastHeartbeat: now, ipv4Addresses: "[\"203.0.113.10\"]", createdAt: now, updatedAt: now });
  insert("hosts", { id: 11, name: "出口-东京", ip: "198.51.100.20", ipv4: "198.51.100.20", hostType: "slave", agentToken: "tok-exit", userId: 1, agentVersion: "2.2.211", createdAt: now, updatedAt: now });
  insert("tunnels", { id: 3, name: "港日 FXP", mode: "forwardx", entryHostId: 10, exitHostId: 11, userId: 1, listenPort: 31000, forwardxVersion: "v3", v3Transport: "ws", v3Path: "/fxp", isRunning: true, createdAt: now, updatedAt: now });
  insert("forward_rules", { id: 100, hostId: 10, name: "直转", forwardType: "realm", protocol: "tcp", sourcePort: 30001, targetIp: "192.0.2.1", targetPort: 443, userId: 7, runtimeDiagnostic: "{\"x\":1}", isEnabled: true, isRunning: true, createdAt: now, updatedAt: now });
  insert("forward_rules", { id: 101, hostId: 10, tunnelId: 3, name: "隧道转发", forwardType: "gost", protocol: "tcp", sourcePort: 30002, targetIp: "192.0.2.2", targetPort: 8443, userId: 7, isEnabled: true, createdAt: now, updatedAt: now });
  insert("system_settings", { key: "panelPublicUrl", value: "https://panel.example.com", updatedAt: now });
  insert("system_settings", { key: "siteName", value: "我的转发", updatedAt: now });
  insert("system_settings", { key: "emailPassword", value: "smtp-secret", updatedAt: now });
  insert("system_settings", { key: "runtimeCache:exitPort:3", value: "31000", updatedAt: now });
  insert("system_settings", { key: "panelMigrationPhase", value: "committing", updatedAt: now });
  insert("system_settings", { key: "databaseType", value: dialect, updatedAt: now });
  insert("support_tickets", { id: 5, userId: 7, title: "隧道连不上", status: "waiting_user", priority: "urgent", category: "technical", version: 1, publicVersion: 1, createdAt: now, updatedAt: now + 60 });
  insert("support_ticket_messages", { id: 50, ticketId: 5, authorId: 7, authorName: "alice", authorRole: "user", kind: "reply", visibility: "public", content: "从昨天开始不通", createdAt: now });
  insert("support_ticket_messages", { id: 51, ticketId: 5, authorId: 1, authorName: "admin", authorRole: "admin", kind: "reply", visibility: "internal", content: "内部：查出口", createdAt: now + 30 });
  insert("support_ticket_messages", { id: 52, ticketId: 5, authorId: 1, authorName: "admin", authorRole: "admin", kind: "reply", visibility: "public", content: "请再试一次", createdAt: now + 60 });
  insert("support_ticket_attachments", { id: 1, ticketId: 5, messageId: 50, name: "a.png", mime: "image/png", size: 3, base64: "AAA=" });
  insert("affiliate_codes", { id: 1, userId: 1, code: "ADMIN", createdAt: now });
  insert("affiliate_referrals", { id: 1, userId: 7, affiliateUserId: 1, codeId: 1, createdAt: now });
  insert("affiliate_accounts", { id: 1, userId: 1, availableCents: 1200, blocked: false, createdAt: now });
  insert("plugins", { id: 1, pluginId: "bbr", name: "BBR", version: "1.0.0", sourceType: "store", manifestJson: "{}", status: "enabled", trusted: true, installedAt: now, updatedAt: now });
  insert("host_probe_services", { id: 2, name: "官网", method: "http", targetIp: "", targetUrl: "https://example.com/health", timeoutSeconds: 8, expectedStatus: 204, userId: 1, createdAt: now, updatedAt: now });
  insert("host_metrics", { id: 1, hostId: 10, cpuUsage: 5, memoryUsage: 10, load1: 1, load5: 2, load15: 3, recordedAt: now });
  insert("agent_installations", { id: 1, hostId: 10, installationId: "inst-1", createdAt: now });
  return { ddl, rows };
}

export function createForwardxUpstreamSqlite(file: string) {
  const { ddl, rows } = fixtureStatements("sqlite");
  const sqlite = new Database(file);
  try {
    for (const statement of ddl) sqlite.exec(statement);
    for (const { table, row } of rows) {
      const keys = Object.keys(row);
      sqlite.prepare(`INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
        .run(...keys.map((key) => row[key]));
    }
  } finally {
    sqlite.close();
  }
}

/** 往一个空的 PostgreSQL 库里建原版的表和数据（client 连的就是那个库）。 */
export async function createForwardxUpstreamPostgres(client: pg.Client) {
  const { ddl, rows } = fixtureStatements("postgresql");
  for (const statement of ddl) await client.query(statement);
  for (const { table, row } of rows) {
    const keys = Object.keys(row);
    await client.query(
      `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(", ")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(", ")})`,
      keys.map((key) => row[key]),
    );
  }
  // 显式写了 id，序列要跟上（原版面板之后插入不会撞主键；这里只是让库和真实的一样）
  const schema = loadForwardxUpstreamSchema();
  for (const table of new Set(rows.map((item) => item.table))) {
    if (!schema[table]?.some(([, type]) => type === "id")) continue;
    await client.query(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`);
  }
}

/** 往一个空的 MySQL / MariaDB 库里建原版的表和数据。 */
export async function createForwardxUpstreamMysql(connection: mysql.Connection) {
  const { ddl, rows } = fixtureStatements("mysql");
  for (const statement of ddl) await connection.query(statement);
  for (const { table, row } of rows) {
    const keys = Object.keys(row);
    await connection.query(
      `INSERT INTO \`${table}\` (${keys.map((key) => `\`${key}\``).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      keys.map((key) => row[key]),
    );
  }
}
