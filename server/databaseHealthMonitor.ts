import mysql from "mysql2/promise";
import pg from "pg";
import { databaseHealth, isSqliteStorageFailure } from "./databaseHealthState";
import { getSqlite, readDatabaseConfig, withSqliteExclusive, type DatabaseConfig } from "./dbRuntime";

/**
 * 诊断用的单独一条连接、3 秒超时：故障期间不能排在业务查询后面等，也不能往主连接池里
 * 越塞越多。SQLite 复用现有句柄和它的事务锁。
 */
export async function probeDatabase(config: DatabaseConfig) {
  if (config.type === "postgresql") {
    const pool = new pg.Pool({ ...config.postgresql, ssl: config.postgresql.ssl ? true : undefined, max: 1, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    pool.on("error", () => {}); // 探测结果由下面的 query 报，空闲连接的错误这里不用管。
    try { await pool.query("SELECT 1"); } finally { await pool.end().catch(() => undefined); }
    return;
  }
  if (config.type === "mysql") {
    const connection = await mysql.createConnection({ ...config.mysql, ssl: config.mysql.ssl ? {} : undefined, connectTimeout: 3000 });
    try { await connection.query({ sql: "SELECT 1", timeout: 3000 }); } finally { connection.destroy(); }
    return;
  }
  if (getSqlite()) await withSqliteExclusive((sqlite) => {
    sqlite.prepare("SELECT 1").get();
  });
}

/**
 * 每 15 秒确认一次主库状态，单飞（上一轮没跑完就跳过这一轮）。
 *
 * - 运行中断线后恢复：只把状态改回 healthy，不重跑建表迁移；
 * - 启动时就连不上（initialized=false）：恢复后补跑一次 initialize（initDatabase），
 *   成功了再调 onReady 启动调度器和 Telegram；启动时还没配置数据库的，初始化归安装向导，
 *   调用方传 initialized=true；
 * - 启动时是结构 / 配置错误（INITIALIZATION_FAILED）：不自动重试 —— 反复跑迁移修不好它，
 *   要管理员看日志、改好后重启。
 */
export function startDatabaseHealthMonitor(options: {
  initialized: boolean;
  initialize: () => Promise<{ ready: boolean }>;
  onReady: () => void;
  probe?: typeof probeDatabase;
  readConfig?: typeof readDatabaseConfig;
  intervalMs?: number;
}) {
  let initialized = options.initialized;
  let running: Promise<void> | null = null;
  let stopped = false;
  const runCheck = async () => {
    const config = (options.readConfig || readDatabaseConfig)();
    if (!config) { databaseHealth.notConfigured(); return; }
    databaseHealth.configure(config.type);
    try {
      await (options.probe || probeDatabase)(config);
      const current = databaseHealth.snapshot();
      if (isSqliteStorageFailure(current.reason?.code)) return;
      if (!initialized) {
        // 只有「启动时连不上」才由这里补跑初始化。还在安装向导里（not_configured）时初始化
        // 归向导管，这里插一脚会和向导的建表并发跑。
        if (current.state !== "unavailable") return;
        if (current.reason?.code === "INITIALIZATION_FAILED") return;
        const result = await options.initialize();
        if (!result.ready) return;
        initialized = true;
        options.onReady();
      }
      databaseHealth.healthy();
    } catch (error) {
      databaseHealth.unavailable(error, !initialized, true);
    }
  };
  const check = async () => {
    if (stopped) return;
    if (running) return running;
    running = runCheck().finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(() => { void check(); }, options.intervalMs || 15_000);
  timer.unref();
  return { check, stop: () => { stopped = true; clearInterval(timer); } };
}
