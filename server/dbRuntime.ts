import fs from "fs";
import path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire as createModuleRequire } from "node:module";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import mysql, { Pool, PoolOptions, type ConnectionOptions } from "mysql2/promise";
import pg from "pg";
import Database from "better-sqlite3";
import { SCHEMA_DIALECT } from "../drizzle/schema";
import { ENV } from "./env";
import { databasePoolSettingsForHostCount } from "./databasePoolSizing";

export type DatabaseKind = "mysql" | "sqlite" | "postgresql";
export const MYSQL_MIN_VERSION = "8.0.13";
const MYSQL_MIN_VERSION_PARTS = [8, 0, 13] as const;

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export interface SqliteConfig {
  path: string;
}

export interface PostgresqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export type DatabaseConfig =
  | { type: "mysql"; mysql: MysqlConfig }
  | { type: "sqlite"; sqlite: SqliteConfig }
  | { type: "postgresql"; postgresql: PostgresqlConfig };

type Db = any;

let _kind: DatabaseKind | null = null;
let _pool: Pool | null = null;
let _pgPool: pg.Pool | null = null;
let _sqlite: Database.Database | null = null;
let _db: Db | null = null;
let _databasePoolHostCount = 0;
let _databasePoolSettings = databasePoolSettingsForHostCount(0);

type DatabaseTransactionContext = {
  db: Db;
  mysqlConnection?: any;
  postgresClient?: any;
  sqlite?: Database.Database;
  afterCommit: Array<() => Promise<void> | void>;
  afterSettled: Array<() => Promise<void> | void>;
};

const transactionContext = new AsyncLocalStorage<DatabaseTransactionContext>();

type SqliteConnectionLockContext = {
  sqlite: Database.Database;
  active: boolean;
};

const sqliteConnectionLockContext = new AsyncLocalStorage<SqliteConnectionLockContext>();
let sqliteConnectionQueue: Promise<void> = Promise.resolve();
let sqliteConnectionPending = 0;
let sqliteConnectionSliceStartedAt = Date.now();
let sqliteConnectionSliceOperations = 0;
const SQLITE_CONNECTION_SLICE_MAX_MS = 8;
const SQLITE_CONNECTION_SLICE_MAX_OPERATIONS = 32;
const SQLITE_CONNECTION_SLOW_LOG_INTERVAL_MS = 5 * 60 * 1000;
const SQLITE_CONNECTION_SLOW_WAIT_MS = 2_000;
const SQLITE_CONNECTION_SLOW_HOLD_MS = 2_000;
let sqliteConnectionSlowLogAt = 0;

function logSlowSqliteConnection(label: string, waitMs: number, holdMs: number) {
  if (waitMs < SQLITE_CONNECTION_SLOW_WAIT_MS && holdMs < SQLITE_CONNECTION_SLOW_HOLD_MS) return;
  const now = Date.now();
  if (now - sqliteConnectionSlowLogAt < SQLITE_CONNECTION_SLOW_LOG_INTERVAL_MS) return;
  sqliteConnectionSlowLogAt = now;
  console.warn(
    `[Database] SQLite operation slow label=${label} waitMs=${Math.max(0, Math.round(waitMs))}`
      + ` holdMs=${Math.max(0, Math.round(holdMs))} pending=${sqliteConnectionPending}`,
  );
}

async function yieldContendedSqliteQueueIfNeeded(wasQueued: boolean) {
  if (!wasQueued) {
    sqliteConnectionSliceStartedAt = Date.now();
    sqliteConnectionSliceOperations = 0;
    return;
  }
  const now = Date.now();
  if (
    sqliteConnectionSliceOperations < SQLITE_CONNECTION_SLICE_MAX_OPERATIONS
    && now - sqliteConnectionSliceStartedAt < SQLITE_CONNECTION_SLICE_MAX_MS
  ) return;
  sqliteConnectionSliceStartedAt = now;
  sqliteConnectionSliceOperations = 0;
  await new Promise<void>((resolve) => setImmediate(resolve));
  sqliteConnectionSliceStartedAt = Date.now();
}

async function withSqliteConnectionLock<T>(
  sqlite: Database.Database,
  work: () => Promise<T> | T,
  label = "query",
): Promise<T> {
  const inherited = sqliteConnectionLockContext.getStore();
  if (inherited?.active && inherited.sqlite === sqlite) return work();

  const wasQueued = sqliteConnectionPending > 0;
  const queuedAt = Date.now();
  sqliteConnectionPending += 1;
  const previous = sqliteConnectionQueue;
  let release: () => void = () => {};
  sqliteConnectionQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const waitMs = Date.now() - queuedAt;
  await yieldContendedSqliteQueueIfNeeded(wasQueued);
  sqliteConnectionSliceOperations += 1;

  const lock = { sqlite, active: true };
  const startedAt = Date.now();
  try {
    return await sqliteConnectionLockContext.run(lock, work);
  } finally {
    logSlowSqliteConnection(String(label || "query"), waitMs, Date.now() - startedAt);
    lock.active = false;
    sqliteConnectionPending = Math.max(0, sqliteConnectionPending - 1);
    release();
  }
}

/*
  预编译语句缓存（只 SQLite）。原来每条查询都 sqlite.prepare 一次，语句编译常常比执行还贵。
  按 SQL 文本复用，LRU 上限 500 条；超过 4KB 的 SQL（一般是拼了长 IN 列表、每次都不一样）
  不进缓存，免得把常用语句挤出去。

  复用是安全的：better-sqlite3 的 run/get/all 都是同步执行完并 reset 语句才返回，语句不会在
  「执行到一半」时被另一个调用拿去用（我们也不用 iterate）；所有访问又都在连接锁里串行。
  raw 模式是挂在语句对象上的，所以每次用之前都显式设一遍（Drizzle 要数组行，queryRaw 要对象行）。
  缓存按连接对象分开，关闭 / 重连时整份丢掉。

  测试会替换 sqlite.prepare（或原型上的 prepare）来数语句条数；被替换了就不走缓存，每条语句照旧经过它。
*/
const SQLITE_STATEMENT_CACHE_MAX = 500;
const SQLITE_STATEMENT_CACHE_MAX_SQL_LENGTH = 4096;
let sqliteStatementCache: { sqlite: Database.Database; statements: Map<string, Database.Statement> } | null = null;
// better-sqlite3 自己的 prepare（原型上挂的就是它）。从源头拿而不是读原型：有的测试在加载
// 本模块之前就替换了原型上的 prepare。拿不到（驱动内部结构变了）就退回原型上的。
const pristineSqlitePrepare: unknown = (() => {
  try {
    return createModuleRequire(import.meta.url)("better-sqlite3/lib/methods/wrappers.js").prepare
      ?? Database.prototype.prepare;
  } catch {
    return Database.prototype.prepare;
  }
})();

function clearSqliteStatementCache() {
  sqliteStatementCache = null;
}

export function getSqliteStatementCacheSize() {
  return sqliteStatementCache?.statements.size ?? 0;
}

function prepareSqliteStatement(sqlite: Database.Database, sqlText: string): Database.Statement {
  if (sqlText.length > SQLITE_STATEMENT_CACHE_MAX_SQL_LENGTH || sqlite.prepare !== pristineSqlitePrepare) {
    return sqlite.prepare(sqlText);
  }
  if (sqliteStatementCache?.sqlite !== sqlite) {
    sqliteStatementCache = { sqlite, statements: new Map() };
  }
  const statements = sqliteStatementCache.statements;
  const cached = statements.get(sqlText);
  if (cached) {
    // Map 按插入顺序迭代：删了再放回去就成了「最近用过」
    statements.delete(sqlText);
    statements.set(sqlText, cached);
    return cached;
  }
  const statement = sqlite.prepare(sqlText);
  statements.set(sqlText, statement);
  if (statements.size > SQLITE_STATEMENT_CACHE_MAX) {
    const oldest = statements.keys().next().value;
    if (oldest !== undefined) statements.delete(oldest);
  }
  return statement;
}

function createSqliteDrizzleDatabase(sqlite: Database.Database): Db {
  const callback: any = (sqlText: string, params: any[], method: "run" | "all" | "get" | "values") => (
    withSqliteConnectionLock(sqlite, () => {
      const statement = prepareSqliteStatement(sqlite, sqlText);
      if (method === "run") return { rows: [], ...statement.run(...params) };
      if (method === "get") return { rows: statement.raw(true).get(...params) };
      return { rows: statement.raw(true).all(...params) };
    }, `drizzle-${method}`)
  );
  return drizzleSqliteProxy(callback) as Db;
}

export class DatabaseNotConfiguredError extends Error {
  constructor(message = "Database is not configured") {
    super(message);
    this.name = "DatabaseNotConfiguredError";
  }
}

export class DatabaseDialectMismatchError extends Error {
  constructor(
    public configuredType: DatabaseKind,
    public schemaType: DatabaseKind,
  ) {
    super(`Database type changed to ${configuredType}; server restart is required`);
    this.name = "DatabaseDialectMismatchError";
  }
}

function configFilePath() {
  return ENV.databaseConfigPath || path.resolve(process.cwd(), "data", "database.json");
}

function legacyMysqlConfigPath() {
  return ENV.mysqlConfigPath || path.resolve(process.cwd(), "data", "mysql.json");
}

export function getDatabaseConfigPath() {
  return configFilePath();
}

export function isDatabaseSetupPendingConfig() {
  try {
    const file = configFilePath();
    if (!fs.existsSync(file)) return false;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed?.setupPending === true || parsed?.setupPending === "true";
  } catch {
    return false;
  }
}

export function defaultSqlitePath() {
  return ENV.sqlitePath || "/data/forwardx.db";
}

function normalizeMysql(config: MysqlConfig): MysqlConfig {
  return {
    host: config.host.trim(),
    port: Number(config.port || 3306),
    user: config.user.trim(),
    password: config.password || "",
    database: config.database.trim(),
    ssl: !!config.ssl,
  };
}

function normalizePostgresql(config: PostgresqlConfig): PostgresqlConfig {
  return {
    host: config.host.trim(),
    port: Number(config.port || 5432),
    user: config.user.trim(),
    password: config.password || "",
    database: config.database.trim(),
    ssl: !!config.ssl,
  };
}

function parseMysqlVersion(version: unknown) {
  const match = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function isMysqlVersionSupported(version: readonly [number, number, number]) {
  for (let i = 0; i < MYSQL_MIN_VERSION_PARTS.length; i += 1) {
    if (version[i] > MYSQL_MIN_VERSION_PARTS[i]) return true;
    if (version[i] < MYSQL_MIN_VERSION_PARTS[i]) return false;
  }
  return true;
}

function mysqlVersionValue(queryResult: any) {
  const rows = Array.isArray(queryResult) ? queryResult[0] : queryResult;
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.version ?? row?.["VERSION()"] ?? row?.["@@version"] ?? "";
}

export async function assertSupportedMysqlServer(query: (sqlText: string) => Promise<any>) {
  const result = await query("SELECT VERSION() AS version");
  const versionText = String(mysqlVersionValue(result) || "").trim();
  const version = parseMysqlVersion(versionText);
  if (!version || !isMysqlVersionSupported(version)) {
    throw new Error(
      `Unsupported MySQL server version ${versionText || "unknown"}. NEX requires MySQL ${MYSQL_MIN_VERSION} or later. MySQL 5.7 does not support the current metrics queries and default-value DDL syntax.`,
    );
  }
}

function normalizeSqlite(config: SqliteConfig): SqliteConfig {
  return {
    path: (config.path || defaultSqlitePath()).trim() || defaultSqlitePath(),
  };
}

export function getDatabasePoolSettings() {
  return { ..._databasePoolSettings };
}

export function setDatabasePoolHostCount(value: unknown) {
  const hostCount = Math.max(0, Math.floor(Number(value) || 0));
  const previous = _databasePoolSettings;
  const next = databasePoolSettingsForHostCount(hostCount);
  _databasePoolHostCount = hostCount;
  _databasePoolSettings = next;

  // Both drivers read these limits when checking out a connection, so active transactions stay intact.
  const mysqlConfig = (_pool as any)?.pool?.config;
  if (mysqlConfig) {
    mysqlConfig.connectionLimit = next.maxOpen;
    mysqlConfig.maxIdle = next.maxIdle;
    mysqlConfig.idleTimeout = next.idleTimeoutMillis;
    mysqlConfig.queueLimit = next.queueLimit;
  }
  if (_pgPool) {
    _pgPool.options.max = next.maxOpen;
    _pgPool.options.min = next.maxIdle;
    _pgPool.options.idleTimeoutMillis = next.idleTimeoutMillis;
    _pgPool.options.maxLifetimeSeconds = next.maxLifetimeSeconds;
  }

  if ((_pool || _pgPool) && (previous.maxOpen !== next.maxOpen || previous.maxIdle !== next.maxIdle)) {
    console.info(`[Database] Pool capacity adjusted hosts=${hostCount} maxOpen=${next.maxOpen} maxIdle=${next.maxIdle} queueLimit=${next.queueLimit}`);
  }
  return getDatabasePoolSettings();
}

export async function refreshDatabasePoolSettings() {
  if (_kind !== "mysql" && _kind !== "postgresql") return getDatabasePoolSettings();
  const rows = await queryRaw<{ count: number | string }>("SELECT COUNT(*) AS count FROM hosts");
  return setDatabasePoolHostCount(rows[0]?.count ?? _databasePoolHostCount);
}

function readMysqlFromEnv(): MysqlConfig | null {
  if (ENV.mysqlUrl) {
    const url = new URL(ENV.mysqlUrl);
    return normalizeMysql({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\/+/, ""),
      ssl: url.searchParams.get("ssl") === "true",
    });
  }
  if (ENV.mysqlHost && ENV.mysqlUser && ENV.mysqlDatabase) {
    return normalizeMysql({
      host: ENV.mysqlHost,
      port: ENV.mysqlPort,
      user: ENV.mysqlUser,
      password: ENV.mysqlPassword,
      database: ENV.mysqlDatabase,
      ssl: ENV.mysqlSsl,
    });
  }
  return null;
}

function readPostgresqlFromEnv(): PostgresqlConfig | null {
  if (ENV.postgresUrl) {
    const url = new URL(ENV.postgresUrl);
    return normalizePostgresql({
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\/+/, ""),
      ssl: url.searchParams.get("ssl") === "true" || url.searchParams.get("sslmode") === "require",
    });
  }
  if (ENV.postgresHost && ENV.postgresUser && ENV.postgresDatabase) {
    return normalizePostgresql({
      host: ENV.postgresHost,
      port: ENV.postgresPort,
      user: ENV.postgresUser,
      password: ENV.postgresPassword,
      database: ENV.postgresDatabase,
      ssl: ENV.postgresSsl,
    });
  }
  return null;
}

function normalizeDatabaseType(value: string | null | undefined): DatabaseKind | "" {
  const type = String(value || "").toLowerCase();
  if (type === "postgresql" || type === "postgres" || type === "pg") return "postgresql";
  if (type === "mysql" || type === "sqlite") return type;
  return "";
}

export function readDatabaseConfig(): DatabaseConfig | null {
  const explicitType = normalizeDatabaseType(ENV.databaseType);
  const envMysql = readMysqlFromEnv();
  const envPostgresql = readPostgresqlFromEnv();
  if (explicitType === "sqlite") {
    return { type: "sqlite", sqlite: normalizeSqlite({ path: defaultSqlitePath() }) };
  }
  if (explicitType === "mysql" && envMysql) {
    return { type: "mysql", mysql: envMysql };
  }
  if (explicitType === "postgresql" && envPostgresql) {
    return { type: "postgresql", postgresql: envPostgresql };
  }
  if (envPostgresql) return { type: "postgresql", postgresql: envPostgresql };
  if (envMysql) return { type: "mysql", mysql: envMysql };

  const file = configFilePath();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const parsedType = normalizeDatabaseType(parsed?.type);
      if (parsedType === "sqlite") {
        return { type: "sqlite", sqlite: normalizeSqlite(parsed.sqlite || parsed) };
      }
      if (parsedType === "mysql") {
        const mysqlConfig = parsed.mysql || parsed;
        if (mysqlConfig?.host && mysqlConfig?.user && mysqlConfig?.database) {
          return { type: "mysql", mysql: normalizeMysql(mysqlConfig) };
        }
      }
      if (parsedType === "postgresql") {
        const postgresqlConfig = parsed.postgresql || parsed.postgres || parsed.pg || parsed;
        if (postgresqlConfig?.host && postgresqlConfig?.user && postgresqlConfig?.database) {
          return { type: "postgresql", postgresql: normalizePostgresql(postgresqlConfig) };
        }
      }
    } catch {
      return null;
    }
  }

  const legacy = legacyMysqlConfigPath();
  if (fs.existsSync(legacy)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, "utf8"));
      if (parsed?.host && parsed?.user && parsed?.database) {
        return { type: "mysql", mysql: normalizeMysql(parsed) };
      }
    } catch {
      return null;
    }
  }

  if (ENV.sqlitePath && fs.existsSync(ENV.sqlitePath)) {
    return { type: "sqlite", sqlite: normalizeSqlite({ path: ENV.sqlitePath }) };
  }
  return null;
}

export function maskDatabaseConfig(config: DatabaseConfig | null) {
  if (!config) return null;
  if (config.type === "sqlite") {
    return { type: "sqlite" as const, sqlite: { path: config.sqlite.path } };
  }
  if (config.type === "postgresql") {
    return {
      type: "postgresql" as const,
      postgresql: {
        ...config.postgresql,
        password: config.postgresql.password ? "********" : "",
      },
    };
  }
  return {
    type: "mysql" as const,
    mysql: {
      ...config.mysql,
      password: config.mysql.password ? "********" : "",
    },
  };
}

export function writeDatabaseConfig(config: DatabaseConfig) {
  const normalized: DatabaseConfig = config.type === "sqlite"
    ? { type: "sqlite", sqlite: normalizeSqlite(config.sqlite) }
    : config.type === "postgresql"
      ? { type: "postgresql", postgresql: normalizePostgresql(config.postgresql) }
      : { type: "mysql", mysql: normalizeMysql(config.mysql) };
  if (isDatabaseSetupPendingConfig()) {
    (normalized as any).setupPending = true;
  }
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2), { mode: 0o600 });
}

export function clearDatabaseSetupPendingConfig() {
  const file = configFilePath();
  try {
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.setupPending === undefined) return;
    delete parsed.setupPending;
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  } catch {
    // Ignore cleanup failures; setup locking also relies on the local marker.
  }
}

/**
 * 每条 MySQL 连接最多缓存多少条预处理语句。
 *
 * executeRaw 走 execute()，mysql2 按 SQL 文本给每条连接缓存预处理语句，默认上限 16000。
 * 批量插入的行数、IN 列表的长度一变就是一条新文本，缓存只增不减；而服务端 max_prepared_stmt_count
 * 默认只有 16382，而且是全实例共享的 —— 32 条连接各攒几百条就能把它顶满，之后这个 MySQL 实例上
 * 所有客户端的 prepare 都报 1461。调小之后 mysql2 自带的 LRU 会把最久没用的关掉（COM_STMT_CLOSE）。
 * 256 × 最多 32 条连接 = 8192，留一半给同实例的其他应用；固定文本的热语句一百来条，缓存装得下。
 * 不改成 query()：那样每条都得在客户端拼 SQL，固定语句的预处理收益也没了。
 */
export const MYSQL_MAX_PREPARED_STATEMENTS = 256;

function mysqlConnectionOptions(config: MysqlConfig): ConnectionOptions {
  const pool = getDatabasePoolSettings();
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: pool.connectTimeoutMillis,
    timezone: "+00:00",
    dateStrings: false,
    ssl: config.ssl ? {} : undefined,
    maxPreparedStatements: MYSQL_MAX_PREPARED_STATEMENTS,
  };
}

function poolOptions(config: MysqlConfig): PoolOptions {
  const pool = getDatabasePoolSettings();
  return {
    ...mysqlConnectionOptions(config),
    waitForConnections: true,
    connectionLimit: pool.maxOpen,
    maxIdle: pool.maxIdle,
    idleTimeout: pool.idleTimeoutMillis,
    queueLimit: pool.queueLimit,
  };
}

function pgPoolOptions(config: PostgresqlConfig): pg.PoolConfig {
  const pool = getDatabasePoolSettings();
  const options: pg.PoolConfig & { min?: number; maxLifetimeSeconds?: number } = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: pool.maxOpen,
    min: pool.maxIdle,
    idleTimeoutMillis: pool.idleTimeoutMillis,
    connectionTimeoutMillis: pool.connectTimeoutMillis,
    maxLifetimeSeconds: pool.maxLifetimeSeconds,
    // Let node-postgres use its default CA validation when TLS is enabled.
    // Passing rejectUnauthorized=false would allow a man-in-the-middle attack.
    ssl: config.ssl ? true : undefined,
  };
  return options;
}

export async function testMysqlConnection(config: MysqlConfig) {
  const normalized = normalizeMysql(config);
  const conn = await mysql.createConnection(mysqlConnectionOptions(normalized));
  try {
    await conn.ping();
    await assertSupportedMysqlServer((sqlText) => conn.query(sqlText));
  } finally {
    await conn.end();
  }
}

export async function testPostgresqlConnection(config: PostgresqlConfig) {
  const normalized = normalizePostgresql(config);
  const pool = new pg.Pool(pgPoolOptions(normalized));
  try {
    await pool.query("SELECT 1");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export function testSqliteConnection(config: SqliteConfig) {
  const normalized = normalizeSqlite(config);
  fs.mkdirSync(path.dirname(normalized.path), { recursive: true });
  const sqlite = new Database(normalized.path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.prepare("SELECT 1").get();
  } finally {
    sqlite.close();
  }
}

export async function testDatabaseConnection(config: DatabaseConfig) {
  if (config.type === "mysql") {
    await testMysqlConnection(config.mysql);
  } else if (config.type === "postgresql") {
    await testPostgresqlConnection(config.postgresql);
  } else {
    testSqliteConnection(config.sqlite);
  }
}

export async function connectDatabase(config = readDatabaseConfig()) {
  if (!config) {
    _kind = null;
    _pool = null;
    _pgPool = null;
    _sqlite = null;
    _db = null;
    clearSqliteStatementCache();
    return null;
  }
  if (_db && _kind === config.type) return _db;
  if (config.type !== SCHEMA_DIALECT) {
    throw new DatabaseDialectMismatchError(config.type, SCHEMA_DIALECT);
  }
  await closeDatabase();

  if (config.type === "mysql") {
    const normalized = normalizeMysql(config.mysql);
    _pool = mysql.createPool(poolOptions(normalized));
    await _pool.query("SELECT 1");
    await assertSupportedMysqlServer((sqlText) => _pool!.query(sqlText));
    _db = drizzleMysql(_pool) as Db;
    _kind = "mysql";
    console.log(`[Database] MySQL connected at ${normalized.host}:${normalized.port}/${normalized.database}`);
    return _db;
  }

  if (config.type === "postgresql") {
    const normalized = normalizePostgresql(config.postgresql);
    _pgPool = new pg.Pool(pgPoolOptions(normalized));
    await _pgPool.query("SELECT 1");
    _db = drizzlePostgres(_pgPool) as Db;
    _kind = "postgresql";
    console.log(`[Database] PostgreSQL connected at ${normalized.host}:${normalized.port}/${normalized.database}`);
    return _db;
  }

  const normalized = normalizeSqlite(config.sqlite);
  fs.mkdirSync(path.dirname(normalized.path), { recursive: true });
  _sqlite = new Database(normalized.path);
  applySqlitePragmas(_sqlite);
  _db = createSqliteDrizzleDatabase(_sqlite);
  _kind = "sqlite";
  console.log(`[Database] SQLite opened at ${normalized.path}`);
  return _db;
}

/*
  连接参数都写明，不依赖驱动的编译默认值：
  - WAL + synchronous=NORMAL：提交不再每次 fsync，断电最多丢最后几笔事务，不会损坏库；
  - busy_timeout：别的进程（备份、迁移工具）占着写锁时等 5 秒而不是立刻报 SQLITE_BUSY；
  - cache_size=-16000：16MB 页缓存；temp_store=MEMORY：排序 / 分组的临时表放内存；
  - mmap_size=128MB：读走内存映射，少一次拷贝。
*/
function applySqlitePragmas(sqlite: Database.Database) {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("cache_size = -16000");
  sqlite.pragma("temp_store = MEMORY");
  sqlite.pragma("mmap_size = 134217728");
  sqlite.pragma("foreign_keys = ON");
}

/**
 * 让 SQLite 按需更新查询规划用的统计信息（PRAGMA optimize）。启动建完表后跑一次，
 * 之后由调度器每隔几小时跑一次。SQLite 3.46 起 optimize 自带分析行数上限，很快。
 * 其它数据库什么也不做。
 */
export async function optimizeSqliteDatabase(options: { startup?: boolean } = {}) {
  if (_kind !== "sqlite" || !_sqlite) return false;
  const sqlite = _sqlite;
  await withSqliteConnectionLock(sqlite, () => {
    // 0x10002：启动时把所有表都看一遍（不只是本连接用过的表）
    sqlite.pragma(options.startup ? "optimize = 0x10002" : "optimize");
  }, "optimize");
  return true;
}

export async function closeDatabase() {
  clearSqliteStatementCache();
  if (_pool) {
    await _pool.end().catch(() => undefined);
  }
  if (_pgPool) {
    await _pgPool.end().catch(() => undefined);
  }
  if (_sqlite) {
    try {
      _sqlite.close();
    } catch {
      // ignore close failures during reconnect
    }
  }
  _pool = null;
  _pgPool = null;
  _sqlite = null;
  _db = null;
  _kind = null;
}

export async function reconnectDatabase() {
  await closeDatabase();
  return connectDatabase();
}

export async function getDb() {
  const active = transactionContext.getStore();
  if (active) return active.db;
  if (_db) return _db;
  return connectDatabase();
}

export function isDatabaseTransactionActive() {
  return !!transactionContext.getStore();
}

export async function afterDatabaseCommit(work: () => Promise<void> | void) {
  const active = transactionContext.getStore();
  if (active) {
    active.afterCommit.push(work);
    return;
  }
  await work();
}

export async function afterDatabaseTransactionSettled(work: () => Promise<void> | void) {
  const active = transactionContext.getStore();
  if (active) {
    active.afterSettled.push(work);
    return;
  }
  await work();
}

async function runAfterCommitCallbacks(callbacks: Array<() => Promise<void> | void>) {
  for (const callback of callbacks) await callback();
}

async function runAfterSettledCallbacks(callbacks: Array<() => Promise<void> | void>) {
  for (const callback of callbacks) await callback();
}

export async function withDatabaseTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (transactionContext.getStore()) return work();
  if (!_db || !_kind) await connectDatabase();
  if (_kind === "mysql") {
    if (!_pool) throw new DatabaseNotConfiguredError("MySQL database is not connected");
    const connection = await _pool.getConnection();
    const afterCommit: Array<() => Promise<void> | void> = [];
    const afterSettled: Array<() => Promise<void> | void> = [];
    let result: T;
    try {
      try {
        await connection.beginTransaction();
        const db = drizzleMysql(connection as any) as Db;
        result = await transactionContext.run({ db, mysqlConnection: connection, afterCommit, afterSettled }, work);
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    } finally {
      await runAfterSettledCallbacks(afterSettled);
    }
    await runAfterCommitCallbacks(afterCommit);
    return result;
  }
  if (_kind === "postgresql") {
    if (!_pgPool) throw new DatabaseNotConfiguredError("PostgreSQL database is not connected");
    const client = await _pgPool.connect();
    const afterCommit: Array<() => Promise<void> | void> = [];
    const afterSettled: Array<() => Promise<void> | void> = [];
    let result: T;
    try {
      try {
        await client.query("BEGIN");
        const db = drizzlePostgres(client as any) as Db;
        result = await transactionContext.run({ db, postgresClient: client, afterCommit, afterSettled }, work);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await runAfterSettledCallbacks(afterSettled);
    }
    await runAfterCommitCallbacks(afterCommit);
    return result;
  }
  if (_kind === "sqlite") {
    if (!_sqlite || !_db) throw new DatabaseNotConfiguredError("SQLite database is not connected");
    const sqlite = _sqlite;
    const db = _db;
    const afterCommit: Array<() => Promise<void> | void> = [];
    const afterSettled: Array<() => Promise<void> | void> = [];
    let result: T;
    try {
      result = await withSqliteConnectionLock(sqlite, async () => {
        let transactionResult: T;
        try {
          sqlite.exec("BEGIN IMMEDIATE");
          transactionResult = await transactionContext.run({ db, sqlite, afterCommit, afterSettled }, work);
          sqlite.exec("COMMIT");
        } catch (error) {
          try { sqlite.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
          throw error;
        }
        return transactionResult;
      }, "transaction");
    } finally {
      await runAfterSettledCallbacks(afterSettled);
    }
    await runAfterCommitCallbacks(afterCommit);
    return result;
  }
  throw new DatabaseNotConfiguredError();
}

export async function withSqliteExclusive<T>(work: (sqlite: Database.Database) => Promise<T> | T): Promise<T> {
  if (transactionContext.getStore()) throw new Error("SQLite exclusive work cannot start inside a database transaction");
  if (!_db || !_kind) await connectDatabase();
  if (_kind !== "sqlite" || !_sqlite) throw new Error("SQLite direct migration requires an active SQLite database");
  const sqlite = _sqlite;
  return withSqliteConnectionLock(sqlite, () => work(sqlite), "exclusive");
}

export function getDatabaseKind() {
  return _kind;
}

export function getConfiguredDatabaseKind() {
  return readDatabaseConfig()?.type ?? null;
}

export function getSchemaDialect() {
  return SCHEMA_DIALECT;
}

export function getPool() {
  return _pool;
}

export function getPostgresPool() {
  return _pgPool;
}

export function getSqlite() {
  return _sqlite;
}

export function requireSqlite() {
  if (!_sqlite) throw new DatabaseNotConfiguredError("SQLite database is not connected");
  return _sqlite;
}

function postgresSql(sqlText: string, params: any[] = []) {
  let index = 0;
  return {
    text: sqlText.replace(/\?/g, () => `$${++index}`),
    values: params,
  };
}

export async function executeRaw(sqlText: string, params: any[] = []) {
  const active = transactionContext.getStore();
  const normalizedParams = params.map((value) => normalizeRawValue(value, _kind));
  if (_kind === "mysql") {
    const executor = active?.mysqlConnection || _pool;
    if (!executor) throw new DatabaseNotConfiguredError("MySQL database is not connected");
    const [result] = await executor.execute(sqlText, normalizedParams);
    return result as any;
  }
  if (_kind === "sqlite") {
    const sqlite = active?.sqlite || _sqlite;
    if (!sqlite) throw new DatabaseNotConfiguredError("SQLite database is not connected");
    return withSqliteConnectionLock(sqlite, () => prepareSqliteStatement(sqlite, sqlText).run(...normalizedParams), "executeRaw");
  }
  if (_kind === "postgresql") {
    const executor = active?.postgresClient || _pgPool;
    if (!executor) throw new DatabaseNotConfiguredError("PostgreSQL database is not connected");
    const result = await executor.query(postgresSql(sqlText, normalizedParams));
    return result as any;
  }
  throw new DatabaseNotConfiguredError();
}

export async function queryRaw<T = Record<string, any>>(sqlText: string, params: any[] = []): Promise<T[]> {
  const active = transactionContext.getStore();
  const normalizedParams = params.map((value) => normalizeRawValue(value, _kind));
  if (_kind === "mysql") {
    const executor = active?.mysqlConnection || _pool;
    if (!executor) throw new DatabaseNotConfiguredError("MySQL database is not connected");
    const [rows] = await executor.query(sqlText, normalizedParams);
    return rows as T[];
  }
  if (_kind === "sqlite") {
    const sqlite = active?.sqlite || _sqlite;
    if (!sqlite) throw new DatabaseNotConfiguredError("SQLite database is not connected");
    return withSqliteConnectionLock(sqlite, () => {
      const statement = prepareSqliteStatement(sqlite, sqlText);
      if (statement.reader) statement.raw(false);
      return statement.all(...normalizedParams) as T[];
    }, "queryRaw");
  }
  if (_kind === "postgresql") {
    const executor = active?.postgresClient || _pgPool;
    if (!executor) throw new DatabaseNotConfiguredError("PostgreSQL database is not connected");
    const result = await executor.query(postgresSql(sqlText, normalizedParams));
    return result.rows as T[];
  }
  throw new DatabaseNotConfiguredError();
}

/**
 * 把一个参数值变成这种数据库吃得下的形状。
 *
 * 库切换那边（databaseSwitch）原来存着一份一模一样的 normalizeTargetValue ——
 * 迁移时写进新库的值，必须和面板平时写进去的走同一套转换，不然同一条数据
 * 迁完之后会跟原来长得不一样（时间变字符串、布尔变 true/false）。
 *
 * 默认的 kind 取当前连接；迁移那边连的是另一个库，所以要显式传。
 */
export function normalizeRawValue(value: any, kind = _kind) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "boolean" && kind !== "postgresql") return value ? 1 : 0;
  return value;
}

/**
 * 按库类型给标识符加引号，三处原来各存一份（建表 DDL、库切换迁移、运行时裸 SQL）。
 *
 * 引号规则错了不会报「语法错误」那么清楚 —— 更常见的是一个带保留字或大写的表名
 * 在 MySQL 上能跑、在 PostgreSQL 上找不到表。三份分头演化正是这类问题的温床。
 */
export function quoteIdentifierFor(kind: DatabaseKind | string, id: string) {
  if (kind === "mysql") return `\`${id.replace(/`/g, "``")}\``;
  return `"${id.replace(/"/g, "\"\"")}"`;
}

export function quoteDbIdentifier(id: string) {
  if (!_kind) return `"${id}"`;
  return quoteIdentifierFor(_kind, id);
}

export function rawAffectedRows(result: any) {
  return Number(result?.affectedRows ?? result?.changes ?? result?.rowCount ?? 0);
}

export async function insertAndGetId(tableName: string, values: Record<string, any>): Promise<number> {
  if (_kind === "mysql" || _kind === "postgresql") {
    const columns = Object.keys(values).filter((key) => values[key] !== undefined);
    const placeholders = columns.map(() => "?").join(", ");
    const quoted = columns.map((key) => quoteIdentifierFor(_kind as DatabaseKind, key)).join(", ");
    const table = quoteIdentifierFor(_kind as DatabaseKind, tableName);
    const returning = _kind === "postgresql" ? " RETURNING id" : "";
    const result: any = await executeRaw(
      `INSERT INTO ${table} (${quoted}) VALUES (${placeholders})${returning}`,
      columns.map((key) => normalizeRawValue(values[key], _kind)),
    );
    if (_kind === "postgresql") return Number(result?.rows?.[0]?.id || 0);
    return Number(result?.insertId || 0);
  }
  if (_kind === "sqlite") {
    const columns = Object.keys(values).filter((key) => values[key] !== undefined);
    const placeholders = columns.map(() => "?").join(", ");
    const quoted = columns.map((key) => `"${key}"`).join(", ");
    const result: any = await executeRaw(
      `INSERT INTO "${tableName}" (${quoted}) VALUES (${placeholders})`,
      columns.map((key) => normalizeRawValue(values[key], _kind)),
    );
    return Number(result?.lastInsertRowid || 0);
  }
  throw new DatabaseNotConfiguredError();
}

/**
 * 原生 SQL 查出来的时间列 → Date。
 *
 * 时间列在三种数据库里都存成「秒」，走 ORM 时由 epoch 列类型的 fromDriver 换成 Date；
 * queryRaw 绕过了它，拿到的是原始值：SQLite / MySQL 是数字秒，PostgreSQL 的 int 可能是字符串。
 * 前端拿数字秒直接 new Date() 会当成毫秒 —— 诊断对话框里「上次诊断」就显示成了 1970 年 1 月。
 * 大于 1e10 的按毫秒认（已经是毫秒的值原样用）。
 */
export function rawEpochToDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const n = Number(value);
  if (Number.isFinite(n)) {
    // 数字形态的只按秒 / 毫秒认；0 和负数当「没有」—— 不能落到下面去解析字符串，
    // V8 会把 new Date("0") 解析成 2000 年 1 月 1 日。
    return n > 0 ? new Date(n > 10_000_000_000 ? n : n * 1000) : null;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function nowDate() {
  return new Date();
}
