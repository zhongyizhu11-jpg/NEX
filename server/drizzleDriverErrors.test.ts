import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { MySqlPreparedQuery } from "drizzle-orm/mysql-core";
import { PgPreparedQuery } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SQLitePreparedQuery } from "drizzle-orm/sqlite-core";
import "./dbRuntime";
import { isUniqueViolation } from "./repositories/tlsInboundRepository";

// drizzle 0.44+ 会把驱动错误包成 DrizzleQueryError（message 里带 SQL 和参数）。
// 面板要的是驱动原来的错误：code 还在、message 里不带参数。

const SECRET = "secret-token-should-not-leak";

function assertDriverError(error: unknown, code: string) {
  const value = error as { code?: unknown; message?: unknown; name?: unknown };
  assert.equal(value.code, code);
  assert.notEqual(value.name, "DrizzleQueryError");
  assert.doesNotMatch(String(value.message), /Failed query/);
  assert.doesNotMatch(String(value.message), new RegExp(SECRET));
  return true;
}

test("dbRuntime installs the driver-error unwrapping on all three dialects", () => {
  for (const prototype of [MySqlPreparedQuery.prototype, PgPreparedQuery.prototype, SQLitePreparedQuery.prototype]) {
    assert.equal((prototype as any).queryWithCache[Symbol.for("forwardx.drizzleDriverErrors")], true);
  }
});

test("SQLite unique violations keep the better-sqlite3 error code and message", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec('CREATE TABLE "tokens" ("id" INTEGER PRIMARY KEY, "value" TEXT NOT NULL UNIQUE)');
  const tokens = sqliteTable("tokens", { id: integer("id").primaryKey(), value: text("value").notNull() });
  const db = drizzleSqliteProxy(async (sqlText, params, method) => {
    const statement = sqlite.prepare(sqlText);
    if (method === "run") return { rows: [], ...statement.run(...params) } as any;
    return { rows: statement.raw(true).all(...params) } as any;
  });
  await db.insert(tokens).values({ id: 1, value: SECRET });
  let caught: unknown;
  await assert.rejects(async () => {
    try {
      await db.insert(tokens).values({ id: 2, value: SECRET });
    } catch (error) {
      caught = error;
      throw error;
    }
  }, (error) => assertDriverError(error, "SQLITE_CONSTRAINT_UNIQUE"));
  assert.equal(isUniqueViolation(caught), true);
  sqlite.close();
});

test("PostgreSQL and MySQL driver errors are rethrown unchanged", async () => {
  const pgError = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  const pgDb = drizzlePostgres({ query: async () => { throw pgError; } } as any);
  await assert.rejects(() => pgDb.execute(sql`select ${SECRET}`), (error) => {
    assert.equal(error, pgError);
    return assertDriverError(error, "23505");
  });

  const mysqlError = Object.assign(new Error("Duplicate entry 'x' for key 'tokens.value'"), { code: "ER_DUP_ENTRY" });
  const failing = async () => { throw mysqlError; };
  const mysqlDb = drizzleMysql({ query: failing, execute: failing } as any);
  await assert.rejects(() => mysqlDb.execute(sql`select ${SECRET}`), (error) => {
    assert.equal(error, mysqlError);
    return assertDriverError(error, "ER_DUP_ENTRY");
  });
});
