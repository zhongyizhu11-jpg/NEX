import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
  测试用：在一个独立子进程里连一份全新的 SQLite 库（建好全部表），跑一段测试脚本。

  以前每个测试文件各抄一份 runInDatabase，这里收成一份。子进程是为了让每个测试拿到干净的
  模块状态（dbRuntime、各种模块级缓存都是单例），库文件和日志目录放在临时目录里，跑完删掉。

  脚本里现成可用的名字：
    assert、path、url(file)（仓库内文件 → import 用的 URL）、
    runtime（server/dbRuntime.ts）、schema（server/dbSchema.ts）、
    exec(sql, params)、query(sql, params)、
    failWrite(name, { table, event, when, message })（让一种写入失败的触发器，两种库语法都对）、dropFailWrite(name, table)、
    skipUnless(kind)（只在某种库上跑的部分）、syncSequences()（PostgreSQL 上把自增序列拨到当前最大 id；setup 之后自动调一次，
    并装上 AFTER INSERT 触发器，之后脚本里再插带 id 的行序列会自动跟上）。
  测试自己再起的子进程用 process.env.FORWARDX_TEST_DB_CONFIG（JSON）连同一个库。
  setup 在建表之后、body 之前执行，适合放导入模块、建用户 / 主机这类公共准备。
  body 正常跑完会打印 OK 并退出（模块里的定时器不会把子进程挂住）。

  设了 FORWARDX_TEST_POSTGRES_URL（要能建库，如 postgres://postgres@127.0.0.1:5432/postgres）并且
  FORWARDX_TEST_DB_KIND=postgresql 时，改成在那个 PostgreSQL 上每次新建一个库跑，跑完删掉：
  同一批测试在 SQLite 和 PostgreSQL 上各过一遍，方言差异（FOR UPDATE、RETURNING、布尔、时间）就能
  在 CI 之外被抓到。脚本里的 runtime.getDatabaseKind() 能看出当前跑在哪种库上。
*/

function testDatabaseKind(): "sqlite" | "postgresql" {
  return String(process.env.FORWARDX_TEST_DB_KIND || "").toLowerCase() === "postgresql" && process.env.FORWARDX_TEST_POSTGRES_URL
    ? "postgresql"
    : "sqlite";
}

export type RunInDatabaseOptions = {
  /** 临时目录名前缀，出问题时方便认出是哪个测试留下的。 */
  name?: string;
  /** 建表之后、body 之前执行的公共脚本。 */
  setup?: string;
  /** 建表之前执行的脚本（比如先建一张老结构的表，测升级）。设置了它时 schema 照样会建。 */
  beforeSchema?: string;
  /** false 时不调用 ensureDatabaseSchema。 */
  ensureSchema?: boolean;
  /** 额外的环境变量。 */
  env?: Record<string, string | undefined>;
  /** 把 console.info / console.warn 静音（很多模块写入时会打日志）。 */
  quiet?: boolean;
  timeoutMs?: number;
};

export type RunInDatabaseResult = { stdout: string; stderr: string };

function buildDatabaseTestScript(body: string, options: RunInDatabaseOptions = {}): string {
  return String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    ${options.quiet ? "console.info = () => {}; console.warn = () => {};" : ""}
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const testPostgres = process.env.FORWARDX_TEST_PG_ADMIN_URL ? await (async () => {
      // PostgreSQL：在管理库上新建一个一次性库，跑完删掉（失败也删）。
      const pg = (await import("pg")).default;
      const adminUrl = new URL(process.env.FORWARDX_TEST_PG_ADMIN_URL);
      const database = process.env.FORWARDX_TEST_PG_DATABASE;
      const admin = new pg.Client({ connectionString: adminUrl.href });
      await admin.connect();
      await admin.query('DROP DATABASE IF EXISTS "' + database + '"');
      await admin.query('CREATE DATABASE "' + database + '"');
      await admin.end();
      // 测试脚本里的裸 SQL 按 SQLite 写布尔列：1 / 0。PostgreSQL 的 int4 → bool 转换默认只能显式写，
      // 这个一次性库里把它放宽成隐式，测试数据照样插得进去、比得了。只动测试库，产品代码不靠这个。
      const fresh = new pg.Client({ connectionString: Object.assign(new URL(adminUrl.href), { pathname: "/" + database }).href });
      await fresh.connect();
      await fresh.query("UPDATE pg_cast SET castcontext = 'i' WHERE castsource = 'int4'::regtype AND casttarget = 'bool'::regtype");
      await fresh.end();
      const drop = async () => {
        try {
          await runtime.closeDatabase?.();
          const cleaner = new pg.Client({ connectionString: adminUrl.href });
          await cleaner.connect();
          await cleaner.query('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
          await cleaner.end();
        } catch (error) { console.warn("test database cleanup failed: " + (error instanceof Error ? error.message : String(error))); }
      };
      process.on("uncaughtException", async (error) => { console.error(error); await drop(); process.exit(1); });
      process.on("unhandledRejection", async (error) => { console.error(error); await drop(); process.exit(1); });
      return {
        config: { type: "postgresql", postgresql: { host: adminUrl.hostname, port: Number(adminUrl.port || 5432), user: decodeURIComponent(adminUrl.username), password: decodeURIComponent(adminUrl.password), database, ssl: false } },
        drop,
      };
    })() : null;
    const databaseConfig = testPostgres ? testPostgres.config : { type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } };
    // 测试自己再起的子进程（并发测试）用这个连同一个库，不要再写死 SQLite
    process.env.FORWARDX_TEST_DB_CONFIG = JSON.stringify(databaseConfig);
    await runtime.connectDatabase(databaseConfig);
    // 测试脚本里的裸 SQL 是按 SQLite 写的：驼峰列名不带引号。PostgreSQL 会把裸标识符折成小写，
    // 这里把字符串字面量以外的驼峰词加上双引号（SQL 关键字全小写 / 全大写，不会被碰到）。
    const portableSql = (sql) => testPostgres
      ? String(sql).split(/('(?:[^']|'')*')/).map((part, index) => index % 2 ? part : part.replace(/(?<![\w"])([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)(?![\w"])/g, '"$1"')).join("")
      : sql;
    const exec = (sql, params = []) => runtime.executeRaw(portableSql(sql), params);
    const query = (sql, params = []) => runtime.queryRaw(portableSql(sql), params);
    const finish = async (code) => { if (testPostgres) await testPostgres.drop(); process.exit(code); };
    // 只能在某种库上跑的测试：skipUnless("sqlite") 之后的部分不跑，照样算通过
    const SKIP = Symbol("skip");
    const skipUnless = (kind) => { if (runtime.getDatabaseKind() !== kind) throw SKIP; };
    // 让某张表的某种写入在条件成立时失败（事务回滚测试用）；两种库各写各的触发器语法
    const failWrite = async (name, { table, event, when, message = "injected failure" }) => {
      if (runtime.getDatabaseKind() === "postgresql") {
        await exec("CREATE FUNCTION " + name + "_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF " + (when || "TRUE") + " THEN RAISE EXCEPTION '" + message + "'; END IF; RETURN " + (event === "DELETE" ? "OLD" : "NEW") + "; END $$");
        await exec("CREATE TRIGGER " + name + " BEFORE " + event + " ON " + table + " FOR EACH ROW EXECUTE FUNCTION " + name + "_fn()");
      } else {
        await exec("CREATE TRIGGER " + name + " BEFORE " + event + " ON " + table + (when ? " WHEN " + when : "") + " BEGIN SELECT RAISE(ABORT, '" + message + "'); END");
      }
    };
    const dropFailWrite = async (name, table) => {
      await exec(runtime.getDatabaseKind() === "postgresql" ? "DROP TRIGGER " + name + " ON " + table : "DROP TRIGGER " + name);
      if (runtime.getDatabaseKind() === "postgresql") await exec("DROP FUNCTION " + name + "_fn()");
    };
    // 测试数据常带着写死的 id 插进去；PostgreSQL 的自增序列不会跟着走，之后的自增插入会撞主键。
    // setup 之后调一下，把每张表的序列拨到当前最大值；同时给每张带序列的表装一个 AFTER INSERT 触发器：
    // 之后（body 里）再插带 id 的行，插进来的 id 比序列大就顺手把序列拨上去，测试不用再自己调 syncSequences()。
    let sequenceTriggersInstalled = false;
    const syncSequences = async () => {
      if (!testPostgres) return;
      const rows = await runtime.queryRaw(
        "SELECT t.relname AS tbl, a.attname AS col, s.relname AS seq FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i') JOIN pg_class t ON t.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid WHERE s.relkind = 'S' AND t.relnamespace = 'public'::regnamespace",
      );
      for (const row of rows) {
        await runtime.executeRaw('SELECT setval(\'"' + row.seq + '"\', COALESCE((SELECT MAX("' + row.col + '") FROM "' + row.tbl + '"), 0) + 1, false)');
      }
      if (sequenceTriggersInstalled) return;
      sequenceTriggersInstalled = true;
      await runtime.executeRaw(
        "CREATE OR REPLACE FUNCTION nex_test_bump_sequence() RETURNS trigger LANGUAGE plpgsql AS $$ "
        + "DECLARE v bigint; last bigint; called boolean; BEGIN "
        + "EXECUTE format('SELECT ($1).%I', TG_ARGV[1]) INTO v USING NEW; "
        + "IF v IS NOT NULL THEN "
        + "EXECUTE format('SELECT last_value, is_called FROM %I', TG_ARGV[0]) INTO last, called; "
        + "IF NOT called OR v > last THEN PERFORM setval(format('%I', TG_ARGV[0])::regclass, GREATEST(v, CASE WHEN called THEN last ELSE 0 END), true); END IF; "
        + "END IF; RETURN NEW; END $$",
      );
      for (const row of rows) {
        await runtime.executeRaw('CREATE TRIGGER "nex_test_seq_' + row.tbl + '" AFTER INSERT ON "' + row.tbl + '" FOR EACH ROW EXECUTE FUNCTION nex_test_bump_sequence(\'' + row.seq + '\', \'' + row.col + '\')');
      }
    };
    try {
      ${options.beforeSchema || ""}
      const schema = await import(url("server/dbSchema.ts"));
      ${options.ensureSchema === false ? "" : "await schema.ensureDatabaseSchema();"}
      ${options.setup || ""}
      await syncSequences();
      ${body}
    } catch (error) {
      if (error !== SKIP) {
        console.error(error);
        await finish(1);
      }
    }
    console.log("OK");
    await finish(0);
  `;
}

/** 跑一段测试脚本；子进程失败或没打印 OK 时断言失败，并带上子进程的输出。 */
export function runInDatabase(body: string, options: RunInDatabaseOptions = {}): RunInDatabaseResult {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `forwardx-${options.name || "db-test"}-`));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", buildDatabaseTestScript(body, options)], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...(testDatabaseKind() === "postgresql"
          ? {
            DATABASE_TYPE: "postgresql",
            FORWARDX_TEST_PG_ADMIN_URL: process.env.FORWARDX_TEST_POSTGRES_URL,
            FORWARDX_TEST_PG_DATABASE: `nex_test_${(options.name || "db").replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 40)}_${process.pid}_${Date.now().toString(36)}`,
          }
          : { DATABASE_TYPE: "sqlite" }),
        FORWARDX_TEST_DB: path.join(directory, "test.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        ...options.env,
      },
      timeout: options.timeoutMs ?? 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
    return { stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
