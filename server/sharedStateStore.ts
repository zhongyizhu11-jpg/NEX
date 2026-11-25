import { executeRaw, getDatabaseKind, queryRaw, rawAffectedRows } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";
import { databaseNowMsSql } from "./panelLease";

/*
  多实例共享状态的三张表（server/sharedState.ts 决定什么时候用；表定义在 dbSchema.ts，不进迁移）。
  三种库共用一套 SQL，时刻按库的时钟（和 panelLease.ts 一样：各实例的时钟差多少都没关系）：

    api_rate_limit_windows  接口限流的固定窗口计数：(key, windowStart) 一行，hits 一条原子 upsert 加一。
                            PostgreSQL 一条语句（INSERT … ON CONFLICT DO UPDATE … RETURNING，顺带把上一个窗口
                            的数带回来）；MySQL 是 ON DUPLICATE KEY UPDATE 再读一次；SQLite 的 RETURNING 也支持，
                            只是生产里 SQLite 永远走内存（见 sharedState.ts）。
    auth_attempt_counters   登录失败 / 验证码失败 / 2FA 挑战签发 / 找回密码这类低频计数：(scope, key) 一行，
                            hits + firstAt + lastAt。窗口过了就从 1 重数，过没过期在同一条 upsert 里按库的时钟判断
                            （anchor = 从最后一次算还是从第一次算，由调用方按它的语义定）。
    auth_captcha_challenges 验证码挑战和令牌：(kind, token) 一行（列叫 token，不叫 id：id 在别处是自增主键的名字），用一次就删（consume 是 DELETE 看影响行数，
                            两个实例同时用同一枚只有一个成功）。expiresAt 是签发实例的时钟（Cap.js 自己比对），
                            各实例要大致对时（部署文档本来就要求 NTP）。
*/

type ClockOptions = {
  /** 测试用：在库的时钟上加一个偏移（毫秒），模拟时间过去。生产里不传。 */
  clockOffsetMs?: () => number;
};

/**
 * 拼 SQL 时按出现顺序收集参数：clock() 放一个「库的时钟 + 偏移」表达式并记下偏移参数，
 * value() 放一个 ? 并记下值。模板字符串从左到右求值，所以参数顺序和 ? 的顺序一致。
 */
function sqlBuilder(options: ClockOptions) {
  const params: unknown[] = [];
  const offset = Math.round(Number(options.clockOffsetMs?.() ?? 0)) || 0;
  const nowSql = databaseNowMsSql();
  return {
    params,
    clock: () => { params.push(offset); return `(${nowSql} + ?)`; },
    value: (value: unknown) => { params.push(value); return "?"; },
  };
}

const q = quoteIdentifier;

export type WindowHit = {
  /** 这个窗口加一之后的总数（全体实例）。 */
  current: number;
  /** 上一个窗口的总数；没要（或 MySQL / SQLite 没查）时为 null。 */
  previous: number | null;
};

/** api_rate_limit_windows。 */
export class SqlWindowCounterStore {
  constructor(private readonly options: ClockOptions = {}) {}

  private table() {
    return q("api_rate_limit_windows");
  }

  /** key 在 windowStart 这个窗口里加一，返回加完的总数；wantPrevious 时顺便带上 windowStart − windowMs 那个窗口的数。 */
  async hit(key: string, windowStart: number, windowMs: number, wantPrevious: boolean): Promise<WindowHit> {
    const table = this.table();
    const previousStart = windowStart - windowMs;
    const kind = getDatabaseKind();
    if (kind === "postgresql") {
      const rows = await queryRaw<{ current: unknown; previous: unknown }>(
        `WITH up AS (
          INSERT INTO ${table} (${q("key")}, ${q("windowStart")}, ${q("hits")}) VALUES (?, ?, 1)
          ON CONFLICT (${q("key")}, ${q("windowStart")}) DO UPDATE SET ${q("hits")} = ${table}.${q("hits")} + 1
          RETURNING ${q("hits")}
        )
        SELECT up.${q("hits")} AS ${q("current")},
          COALESCE((SELECT ${q("hits")} FROM ${table} WHERE ${q("key")} = ? AND ${q("windowStart")} = ?), 0) AS ${q("previous")}
        FROM up`,
        [key, windowStart, key, previousStart],
      );
      // 同一条语句顺带带回上一个窗口（没有就是 0），不管要没要：多知道一个数没坏处。
      return { current: Number(rows[0]?.current ?? 0) || 0, previous: Number(rows[0]?.previous ?? 0) || 0 };
    }
    let current: number;
    if (kind === "mysql") {
      await executeRaw(
        `INSERT INTO ${table} (${q("key")}, ${q("windowStart")}, ${q("hits")}) VALUES (?, ?, 1)
          ON DUPLICATE KEY UPDATE ${q("hits")} = ${q("hits")} + 1`,
        [key, windowStart],
      );
      const rows = await queryRaw<{ windowStart: unknown; hits: unknown }>(
        `SELECT ${q("windowStart")}, ${q("hits")} FROM ${table} WHERE ${q("key")} = ? AND ${q("windowStart")} IN (?, ?)`,
        [key, windowStart, wantPrevious ? previousStart : windowStart],
      );
      current = Number(rows.find((row) => Number(row.windowStart) === windowStart)?.hits ?? 0) || 0;
      const previousRow = wantPrevious ? rows.find((row) => Number(row.windowStart) === previousStart) : undefined;
      return { current, previous: previousRow ? Number(previousRow.hits) || 0 : wantPrevious ? 0 : null };
    }
    // SQLite：RETURNING 要用 queryRaw（executeRaw 走 run()，拿不到返回的行）。
    const rows = await queryRaw<{ hits: unknown }>(
      `INSERT INTO ${table} (${q("key")}, ${q("windowStart")}, ${q("hits")}) VALUES (?, ?, 1)
        ON CONFLICT (${q("key")}, ${q("windowStart")}) DO UPDATE SET ${q("hits")} = ${table}.${q("hits")} + 1
        RETURNING ${q("hits")}`,
      [key, windowStart],
    );
    current = Number(rows[0]?.hits ?? 0) || 0;
    if (!wantPrevious) return { current, previous: null };
    const previous = await queryRaw<{ hits: unknown }>(
      `SELECT ${q("hits")} FROM ${table} WHERE ${q("key")} = ? AND ${q("windowStart")} = ?`,
      [key, previousStart],
    );
    return { current, previous: Number(previous[0]?.hits ?? 0) || 0 };
  }

  /** 删掉两个窗口之前的行（滑动估算只用当前和上一个窗口）。 */
  async prune(windowMs: number) {
    const b = sqlBuilder(this.options);
    const result = await executeRaw(
      `DELETE FROM ${this.table()} WHERE ${q("windowStart")} < ${b.clock()} - ${b.value(2 * Math.max(1, Math.round(windowMs)))}`,
      b.params,
    );
    return rawAffectedRows(result);
  }
}

export type AttemptCounterAnchor = "first" | "last";

export type AttemptCounterRow = {
  hits: number;
  /** 这一轮窗口里第一次的时刻（毫秒，库的时钟）。 */
  firstAt: number;
  /** 最近一次的时刻（毫秒，库的时钟）。 */
  lastAt: number;
  /** 库现在的时刻（同一条语句里取的）：调用方拿它把上面两个换算成本机时钟。 */
  now: number;
};

function counterRow(row: Record<string, unknown> | undefined): AttemptCounterRow | null {
  if (!row) return null;
  return {
    hits: Number(row.hits ?? 0) || 0,
    firstAt: Number(row.firstAt ?? 0) || 0,
    lastAt: Number(row.lastAt ?? 0) || 0,
    now: Number(row.now ?? 0) || 0,
  };
}

export function attemptCounterKey(scope: string, key: string) {
  return `${scope}\n${key}`;
}

/** auth_attempt_counters。 */
export class SqlAttemptCounterStore {
  constructor(private readonly options: ClockOptions = {}) {}

  private table() {
    return q("auth_attempt_counters");
  }

  /**
   * (scope, key) 加一并返回加完的行。anchor 这一列距离现在超过 windowMs 就算新一轮：hits 从 1 起、firstAt 重置。
   * 过没过期和写进去的时刻都按库的时钟，在一条语句里算完，并发加一不会丢数。
   */
  async bump(scope: string, key: string, windowMs: number, anchor: AttemptCounterAnchor): Promise<AttemptCounterRow> {
    const table = this.table();
    const anchorColumn = q(anchor === "first" ? "firstAt" : "lastAt");
    const window = Math.max(1, Math.round(windowMs));
    const b = sqlBuilder(this.options);
    if (getDatabaseKind() === "mysql") {
      // MySQL 的 ON DUPLICATE KEY UPDATE 按顺序赋值、后面的能看到前面改过的值：anchor 列放最后改，前面的条件都看旧值。
      const expired = () => `${anchorColumn} <= ${b.clock()} - ${b.value(window)}`;
      await executeRaw(
        `INSERT INTO ${table} (${q("scope")}, ${q("key")}, ${q("hits")}, ${q("firstAt")}, ${q("lastAt")})
          VALUES (${b.value(scope)}, ${b.value(key)}, 1, ${b.clock()}, ${b.clock()})
          ON DUPLICATE KEY UPDATE
            ${q("hits")} = IF(${expired()}, 1, ${q("hits")} + 1),
            ${q("firstAt")} = IF(${expired()}, ${b.clock()}, ${q("firstAt")}),
            ${q("lastAt")} = ${b.clock()}`,
        b.params,
      );
      const read = sqlBuilder(this.options);
      const rows = await queryRaw(
        `SELECT ${q("hits")}, ${q("firstAt")}, ${q("lastAt")}, ${read.clock()} AS ${q("now")} FROM ${table}
          WHERE ${q("scope")} = ${read.value(scope)} AND ${q("key")} = ${read.value(key)}`,
        read.params,
      );
      return counterRow(rows[0]) ?? { hits: 1, firstAt: 0, lastAt: 0, now: 0 };
    }
    const expired = () => `${table}.${anchorColumn} <= ${b.clock()} - ${b.value(window)}`;
    const rows = await queryRaw(
      `INSERT INTO ${table} (${q("scope")}, ${q("key")}, ${q("hits")}, ${q("firstAt")}, ${q("lastAt")})
        VALUES (${b.value(scope)}, ${b.value(key)}, 1, ${b.clock()}, ${b.clock()})
        ON CONFLICT (${q("scope")}, ${q("key")}) DO UPDATE SET
          ${q("hits")} = CASE WHEN ${expired()} THEN 1 ELSE ${table}.${q("hits")} + 1 END,
          ${q("firstAt")} = CASE WHEN ${expired()} THEN ${b.clock()} ELSE ${table}.${q("firstAt")} END,
          ${q("lastAt")} = ${b.clock()}
        RETURNING ${q("hits")}, ${q("firstAt")}, ${q("lastAt")}, ${b.clock()} AS ${q("now")}`,
      b.params,
    );
    return counterRow(rows[0]) ?? { hits: 1, firstAt: 0, lastAt: 0, now: 0 };
  }

  /** 一次读几个 (scope, key)，返回 attemptCounterKey → 行；库里没有的不在结果里。 */
  async read(entries: Array<{ scope: string; key: string }>) {
    const result = new Map<string, AttemptCounterRow>();
    if (entries.length === 0) return result;
    const b = sqlBuilder(this.options);
    const nowSql = b.clock();
    const where = entries.map((entry) => `(${q("scope")} = ${b.value(entry.scope)} AND ${q("key")} = ${b.value(entry.key)})`).join(" OR ");
    const rows = await queryRaw(
      `SELECT ${q("scope")}, ${q("key")}, ${q("hits")}, ${q("firstAt")}, ${q("lastAt")}, ${nowSql} AS ${q("now")} FROM ${this.table()} WHERE ${where}`,
      b.params,
    );
    for (const row of rows) {
      const parsed = counterRow(row);
      if (parsed) result.set(attemptCounterKey(String(row.scope), String(row.key)), parsed);
    }
    return result;
  }

  async clear(scope: string, key: string) {
    await executeRaw(`DELETE FROM ${this.table()} WHERE ${q("scope")} = ? AND ${q("key")} = ?`, [scope, key]);
  }

  /** 删掉最近一次已经在 olderThanMs 之前的行（按库的时钟）。 */
  async prune(olderThanMs: number) {
    const b = sqlBuilder(this.options);
    const result = await executeRaw(
      `DELETE FROM ${this.table()} WHERE ${q("lastAt")} < ${b.clock()} - ${b.value(Math.max(0, Math.round(olderThanMs)))}`,
      b.params,
    );
    return rawAffectedRows(result);
  }
}

export type CaptchaChallengeRow = {
  kind: string;
  id: string;
  ip: string | null;
  purpose: string | null;
  data: string | null;
  /** 签发实例的时钟（毫秒）。 */
  expiresAt: number;
};

function challengeRow(row: Record<string, unknown> | undefined): CaptchaChallengeRow | null {
  if (!row) return null;
  return {
    kind: String(row.kind ?? ""),
    id: String(row.id ?? ""),
    ip: row.ip === null || row.ip === undefined ? null : String(row.ip),
    purpose: row.purpose === null || row.purpose === undefined ? null : String(row.purpose),
    data: row.data === null || row.data === undefined ? null : String(row.data),
    expiresAt: Number(row.expiresAt ?? 0) || 0,
  };
}

/** auth_captcha_challenges。 */
export class SqlCaptchaChallengeStore {
  private table() {
    return q("auth_captcha_challenges");
  }

  private columns() {
    return `${q("kind")}, ${q("token")} AS ${q("id")}, ${q("ip")}, ${q("purpose")}, ${q("data")}, ${q("expiresAt")}`;
  }

  async put(row: CaptchaChallengeRow) {
    // id 是随机的（nanoid / Cap 的 randomHex），不会撞；撞了就是重放，让它报错。
    await executeRaw(
      `INSERT INTO ${this.table()} (${q("kind")}, ${q("token")}, ${q("ip")}, ${q("purpose")}, ${q("data")}, ${q("expiresAt")}) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.kind, row.id, row.ip, row.purpose, row.data, Math.round(row.expiresAt)],
    );
  }

  async get(kind: string, id: string) {
    const rows = await queryRaw(`SELECT ${this.columns()} FROM ${this.table()} WHERE ${q("kind")} = ? AND ${q("token")} = ?`, [kind, id]);
    return challengeRow(rows[0]);
  }

  /** 读出来并删掉：删到了才算拿到（两个实例同时用同一枚，只有一个成功）。 */
  async consume(kind: string, id: string) {
    const row = await this.get(kind, id);
    if (!row) return null;
    const deleted = await executeRaw(`DELETE FROM ${this.table()} WHERE ${q("kind")} = ? AND ${q("token")} = ?`, [kind, id]);
    return rawAffectedRows(deleted) > 0 ? row : null;
  }

  async remove(kind: string, id: string) {
    await executeRaw(`DELETE FROM ${this.table()} WHERE ${q("kind")} = ? AND ${q("token")} = ?`, [kind, id]);
  }

  /** 删掉过期超过 graceMs 的行。expiresAt 是签发实例的时钟，这里也按本机时钟比（都要求对了时）。 */
  async prune(graceMs: number, now = Date.now()) {
    const result = await executeRaw(`DELETE FROM ${this.table()} WHERE ${q("expiresAt")} < ?`, [Math.round(now - Math.max(0, graceMs))]);
    return rawAffectedRows(result);
  }
}
