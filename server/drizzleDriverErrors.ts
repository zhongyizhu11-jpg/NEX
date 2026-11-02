import { DrizzleQueryError } from "drizzle-orm";
import { MySqlPreparedQuery } from "drizzle-orm/mysql-core";
import { PgPreparedQuery } from "drizzle-orm/pg-core";
import { SQLitePreparedQuery } from "drizzle-orm/sqlite-core";

/*
  drizzle-orm 0.44 起把驱动抛的每个错误包成 DrizzleQueryError：message 换成
  「Failed query: <SQL>\nparams: <参数>」，原来的错误挪到 cause。

  面板这边不能直接接受这个变化：
  - 判断唯一键冲突 / 表不存在的地方（isUniqueViolation、isMissingTableError 等）看的是
    驱动错误的 code 和 message，包一层以后全都认不出来了；
  - 没被接住的错误会原样进 tRPC 的报错 message 和日志，参数里可能有密码哈希、令牌、密钥，
    以前只会带出驱动那句「UNIQUE constraint failed: ...」。

  所以在三个方言共用的 PreparedQuery 基类上把这层拆掉，继续抛驱动原来的错误，
  行为和升级前（0.36）一致。只在 dbRuntime 加载时装一次。
*/

const UNWRAPPED = Symbol.for("forwardx.drizzleDriverErrors");

export function unwrapDrizzleQueryError(error: unknown): unknown {
  if (error instanceof DrizzleQueryError && error.cause !== undefined && error.cause !== null) return error.cause;
  return error;
}

function keepDriverErrors(prototype: any) {
  const original = prototype?.queryWithCache;
  if (typeof original !== "function" || original[UNWRAPPED]) return;
  const wrapped = async function (this: unknown, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (error) {
      throw unwrapDrizzleQueryError(error);
    }
  };
  (wrapped as any)[UNWRAPPED] = true;
  prototype.queryWithCache = wrapped;
}

export function installDrizzleDriverErrors() {
  keepDriverErrors(MySqlPreparedQuery.prototype);
  keepDriverErrors(PgPreparedQuery.prototype);
  keepDriverErrors(SQLitePreparedQuery.prototype);
}

installDrizzleDriverErrors();
