import type { DatabaseHealth } from "../shared/databaseHealth";

/*
  面板主库的健康状态（上游 v2.3.281 移植）。

  谁在报：dbRuntime 里面板自己那几个连接池 / SQLite 句柄的每一次查询出错时报一下
  （reportingDatabaseClient / reportDatabaseErrors），pg 连接池的空闲连接被断开时也报；
  恢复由 databaseHealthMonitor 每 15 秒用一条单独的诊断连接 SELECT 1 来确认。

  只有「连不上 / 断了 / 认证失败 / 文件坏了」这类错误码会把状态打成 unavailable ——
  唯一键冲突、SQL 写错这种业务错误不算，测试别的数据库（设置页「测试连接」、库切换）
  和调外部 API（SMTP、GitHub）也碰不到这里，因为它们不走面板主库的连接。

  不可用的时候：tRPC 一律 503（不清登录 cookie）、/api/* 一律 503、调度器整轮跳过；
  Web 静态页和 /api/database-health 照常，前端据此显示故障页并自动轮询恢复。
*/

// 不对外暴露驱动的原始报错：里面可能有密码、SQL、参数、内网地址或文件路径。
// 错误码和说明都是白名单里写死的。
export function describeDatabaseError(error: unknown): NonNullable<DatabaseHealth["reason"]> | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 16; count++) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] };
    const code = String(value.code || "").toUpperCase();
    const message = String(value.message || "");
    const reason = (safeCode: string, text: string, suggestion: string) => ({ code: safeCode, message: text, suggestion });
    if (code === "ECONNREFUSED") return reason(code, "数据库连接被拒绝", "检查数据库服务是否启动、监听端口和容器网络是否正确。");
    if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return reason(code, "无法解析数据库地址", "检查数据库主机名、DNS 和容器网络。");
    if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code) || /connection terminated due to connection timeout|query read timeout|connect timeout|connection timeout|timeout exceeded when trying to connect/i.test(message)) {
      return reason("ETIMEDOUT", "数据库连接或响应超时", "检查数据库负载、网络、防火墙和连接池是否拥堵。");
    }
    if (["ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "PROTOCOL_CONNECTION_LOST", "57P01", "57P02", "57P03"].includes(code) || code.startsWith("08") || /connection terminated unexpectedly|connection is closed|database connection is not open|can't add new command when connection is in closed state/i.test(message)) {
      return reason(code || "CONNECTION_LOST", "数据库连接中断或服务正在停止", "检查数据库重启、服务日志和网络状态。");
    }
    if (["28P01", "28000", "ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR"].includes(code)) return reason(code, "数据库账号认证或访问权限失败", "由管理员检查数据库账号、密码和授权；不要在公开页面粘贴密码。");
    if (["3D000", "ER_BAD_DB_ERROR"].includes(code)) return reason(code, "配置的数据库不存在", "检查数据库是否存在，以及面板配置的数据库名是否正确。");
    if (["53300", "ER_CON_COUNT_ERROR", "ER_TOO_MANY_USER_CONNECTIONS"].includes(code)) return reason(code, "数据库连接数达到上限", "检查数据库连接数限制和其他应用的连接占用。");
    if (/^(SQLITE_(CANTOPEN|IOERR|CORRUPT|NOTADB|FULL|READONLY|BUSY|LOCKED))(_|$)/.test(code)) return reason(code.split("_").slice(0, 2).join("_"), "SQLite 文件访问、存储或锁状态异常", "检查磁盘空间、文件权限、数据库日志和是否有其他进程占用；勿删除数据库文件。");
    if (["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code)) return reason(code, "数据库 TLS 证书验证失败", "检查数据库证书有效期、证书链和连接主机名。");
    pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 8));
  }
  return null;
}

/** 这几类 SQLite 错误一条 SELECT 1 成功证明不了已经修好（能读不等于能写、坏库不会自己好）。 */
const SQLITE_STORAGE_FAILURE = /^SQLITE_(FULL|READONLY|CORRUPT|NOTADB|IOERR)$/;

export function isSqliteStorageFailure(code: string | null | undefined) {
  return SQLITE_STORAGE_FAILURE.test(code || "");
}

export class DatabaseHealthTracker {
  private health: DatabaseHealth = { state: "checking", databaseType: null, checkedAt: null, unavailableSince: null, reason: null, restartRequired: false };
  private lastLogAt = 0;
  private setupPending: () => boolean = () => false;
  constructor(private log: (message: string) => void = (message) => console.warn(message)) {}

  /**
   * 首次安装还没完成（database.json 里 setupPending）时库连不上，是安装向导要处理的事：
   * 向导允许重新填写数据库配置（setup.saveDatabase 的 allowDatabaseRecovery）。这时不能
   * 挡成故障页、也不能把 setup 接口 503 掉，状态记成 not_configured，前端照常进安装向导。
   */
  treatAsSetupWhile(predicate: () => boolean) { this.setupPending = predicate; }

  snapshot(): DatabaseHealth { return { ...this.health, reason: this.health.reason ? { ...this.health.reason } : null }; }

  isUnavailable() { return this.health.state === "unavailable"; }

  configure(databaseType: DatabaseHealth["databaseType"]) { this.health.databaseType = databaseType; }

  /**
   * 记一次失败。认不出的错误默认不算（业务错误），除非是启动初始化失败（initialization）
   * 或监控探测本身失败（force）。返回 true 表示这确实是一次数据库故障。
   */
  unavailable(error: unknown, initialization = false, force = false) {
    const reason = describeDatabaseError(error);
    if (!reason && !initialization && !force) return false;
    if (this.setupPending()) {
      if (this.health.state !== "not_configured") this.notConfigured();
      return false;
    }
    const now = Date.now();
    const changed = this.health.state !== "unavailable";
    const sqliteStorageFailure = isSqliteStorageFailure(reason?.code);
    this.health = {
      ...this.health,
      state: "unavailable",
      checkedAt: new Date(now).toISOString(),
      unavailableSince: this.health.unavailableSince || new Date(now).toISOString(),
      reason: reason || {
        code: initialization ? "INITIALIZATION_FAILED" : "DATABASE_CHECK_FAILED",
        message: initialization ? "数据库初始化失败" : "数据库健康检查失败",
        suggestion: "查看面板日志，检查数据库结构、权限和版本兼容性。",
      },
      restartRequired: this.health.restartRequired || initialization || sqliteStorageFailure,
    };
    // 故障期间每个请求都会报一次，日志一分钟最多一行。
    if (changed || now - this.lastLogAt >= 60_000) {
      this.lastLogAt = now;
      this.log(`[DatabaseHealth] unavailable type=${this.health.databaseType || "unknown"} code=${this.health.reason!.code}; ${this.health.reason!.message}`);
    }
    return true;
  }

  healthy() {
    if (this.health.state === "unavailable") this.log(`[DatabaseHealth] recovered type=${this.health.databaseType || "unknown"}`);
    this.health = { ...this.health, state: "healthy", checkedAt: new Date().toISOString(), unavailableSince: null, reason: null, restartRequired: false };
  }

  notConfigured() { this.health = { state: "not_configured", databaseType: null, checkedAt: new Date().toISOString(), unavailableSince: null, reason: null, restartRequired: false }; }
}

export const databaseHealth = new DatabaseHealthTracker();
