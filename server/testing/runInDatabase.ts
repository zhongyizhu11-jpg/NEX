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
    exec(sql, params)、query(sql, params)。
  setup 在建表之后、body 之前执行，适合放导入模块、建用户 / 主机这类公共准备。
  body 正常跑完会打印 OK 并退出（模块里的定时器不会把子进程挂住）。
*/

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

export function buildDatabaseTestScript(body: string, options: RunInDatabaseOptions = {}): string {
  return String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    ${options.quiet ? "console.info = () => {}; console.warn = () => {};" : ""}
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    ${options.beforeSchema || ""}
    const schema = await import(url("server/dbSchema.ts"));
    ${options.ensureSchema === false ? "" : "await schema.ensureDatabaseSchema();"}
    ${options.setup || ""}
    ${body}
    console.log("OK");
    process.exit(0);
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
        DATABASE_TYPE: "sqlite",
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
