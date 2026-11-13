import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  buildForwardxMigrationSnapshot,
  describeForwardxSource,
  formatForwardxMigrationReport,
  inspectForwardxSource,
  openForwardxSourceDatabase,
  resolveForwardxSourceConfig,
  type ForwardxSourceConfig,
} from "./forwardxMigration";

/*
  从原版 ForwardX 迁到 NEX 的命令行（打包成 dist/migrate-forwardx.js）。
  平时由安装脚本的 migrate-forwardx 动作调用（scripts/install-panel-local.sh、install-panel-docker.sh），
  也可以手动跑：

    node dist/migrate-forwardx.js inspect --source-config /备份/data/database.json [--json]
    node dist/migrate-forwardx.js import  --source-config ... --target-sqlite /opt/forwardx-panel/data/forwardx.db.nex-import

  inspect 只读原版的库，打印能迁什么；import 把原版的数据导进一个「全新」的 NEX 数据库：
  - 目标是 SQLite 时文件必须还不存在；目标是 MySQL / PostgreSQL（--target-config）时库里不能有数据；
  - 原版的库只读打开，一个字节都不改。

  目标库的方言必须在加载 NEX 的数据库模块之前定下来（drizzle/schema.ts 在加载时读 DATABASE_TYPE），
  所以导入相关的模块都是在 main 里设好环境变量以后动态加载的。
*/

// 只拿类型（编译后不留 import），不会提前加载 NEX 的数据库模块
type TargetConfig = import("./dbRuntime").DatabaseConfig;
type PathOption = "sourceSqlite" | "sourceConfig" | "sourceMysqlConfig" | "sourceEnvFile" | "defaultSqlite" | "targetSqlite" | "targetConfig" | "reportFile" | "jwtSecretFile";

type CliOptions = {
  command: "inspect" | "import" | "help";
  json: boolean;
  sourceSqlite: string | null;
  sourceConfig: string | null;
  sourceMysqlConfig: string | null;
  sourceEnvFile: string | null;
  defaultSqlite: string | null;
  pathMap: Array<[string, string]>;
  targetSqlite: string | null;
  targetConfig: string | null;
  reportFile: string | null;
  jwtSecretFile: string | null;
};

export const FORWARDX_MIGRATION_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  /** 源库不是原版 ForwardX 的库（已经是 NEX，或者缺表） */
  notForwardx: 3,
  /** 目标库已经有数据 / 目标文件已存在 */
  targetNotEmpty: 4,
} as const;

class CliError extends Error {
  constructor(message: string, public exitCode: number) {
    super(message);
  }
}

function usage() {
  return [
    "从原版 ForwardX 迁移到 NEX",
    "",
    "用法：",
    "  node dist/migrate-forwardx.js inspect <来源> [--json]",
    "  node dist/migrate-forwardx.js import  <来源> <目标> [--report 文件] [--json]",
    "",
    "来源（原版面板的数据库，只读）：",
    "  --source-sqlite 路径          直接指定原版的 SQLite 文件",
    "  --source-config 路径          原版的 database.json",
    "  --source-mysql-config 路径    原版老的 mysql.json",
    "  --source-env-file 路径        原版部署的 .env（里面的 DATABASE_TYPE / MYSQL_* / POSTGRES_* / SQLITE_PATH）",
    "  --default-sqlite 路径         上面都没写数据库时的 SQLite 位置",
    "  --map-path 原路径=新路径      配置里的 SQLite 路径换个位置读（备份目录、容器挂载），可写多次",
    "",
    "目标（全新的 NEX 数据库）：",
    "  --target-sqlite 路径          新建 SQLite 文件（必须还不存在）",
    "  --target-config 路径          NEX 格式的 database.json，指向一个空的 MySQL / PostgreSQL 库",
    "",
    "其他：",
    "  --report 路径                 迁移报告另存一份 JSON",
    "  --jwt-secret-file 路径        没设 JWT_SECRET 时面板用的密钥文件（密钥类设置要用它加密）",
    "  --json                        输出 JSON",
  ].join("\n");
}

function takeValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError(`${option} 需要一个值`, FORWARDX_MIGRATION_EXIT.usage);
  return value;
}

export function parseForwardxMigrationArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "help",
    json: false,
    sourceSqlite: null,
    sourceConfig: null,
    sourceMysqlConfig: null,
    sourceEnvFile: null,
    defaultSqlite: null,
    pathMap: [],
    targetSqlite: null,
    targetConfig: null,
    reportFile: null,
    jwtSecretFile: null,
  };
  const valueOptions: Record<string, PathOption> = {
    "--source-sqlite": "sourceSqlite",
    "--source-config": "sourceConfig",
    "--source-mysql-config": "sourceMysqlConfig",
    "--source-env-file": "sourceEnvFile",
    "--default-sqlite": "defaultSqlite",
    "--target-sqlite": "targetSqlite",
    "--target-config": "targetConfig",
    "--report": "reportFile",
    "--jwt-secret-file": "jwtSecretFile",
  };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!commandSeen && (arg === "inspect" || arg === "import" || arg === "help")) {
      options.command = arg;
      commandSeen = true;
      continue;
    }
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg === "--map-path") {
      const value = takeValue(argv, index, arg);
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) throw new CliError("--map-path 的格式是 原路径=新路径", FORWARDX_MIGRATION_EXIT.usage);
      options.pathMap.push([value.slice(0, separator), value.slice(separator + 1)]);
      index += 1;
    } else if (valueOptions[arg]) {
      options[valueOptions[arg]] = takeValue(argv, index, arg);
      index += 1;
    } else {
      throw new CliError(`不认识的参数：${arg}`, FORWARDX_MIGRATION_EXIT.usage);
    }
  }
  if (options.command === "import" && !options.targetSqlite && !options.targetConfig) {
    throw new CliError("import 要指定目标：--target-sqlite 或 --target-config", FORWARDX_MIGRATION_EXIT.usage);
  }
  if (options.targetSqlite && options.targetConfig) {
    throw new CliError("--target-sqlite 和 --target-config 只能写一个", FORWARDX_MIGRATION_EXIT.usage);
  }
  return options;
}

function sourceConfigFromOptions(options: CliOptions): ForwardxSourceConfig {
  return resolveForwardxSourceConfig({
    sqlitePath: options.sourceSqlite,
    configPath: options.sourceConfig,
    legacyMysqlPath: options.sourceMysqlConfig,
    envFile: options.sourceEnvFile,
    pathMap: options.pathMap,
    defaultSqlitePath: options.defaultSqlite,
  });
}

export function readTargetConfig(options: Pick<CliOptions, "targetSqlite" | "targetConfig">): TargetConfig {
  if (options.targetSqlite) {
    const target = path.resolve(options.targetSqlite);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (fs.existsSync(target + suffix)) {
        throw new CliError(`目标文件已经存在：${target}${suffix}（迁移只往全新的库里导，删掉它或换个路径）`, FORWARDX_MIGRATION_EXIT.targetNotEmpty);
      }
    }
    return { type: "sqlite", sqlite: { path: target } };
  }
  const file = path.resolve(String(options.targetConfig));
  let parsed: Record<string, unknown>;
  try {
    parsed = jsonObject(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    throw new CliError(`读不了目标数据库配置 ${file}：${error instanceof Error ? error.message : String(error)}`, FORWARDX_MIGRATION_EXIT.usage);
  }
  const type = String(parsed?.type || "").toLowerCase();
  const server = (value: unknown, port: number) => {
    const input = jsonObject(value);
    if (!input?.host || !input?.user || !input?.database) {
      throw new CliError(`目标数据库配置 ${file} 不完整（要有 host / user / database）`, FORWARDX_MIGRATION_EXIT.usage);
    }
    return {
      host: String(input.host),
      port: Number(input.port || port),
      user: String(input.user),
      password: String(input.password ?? ""),
      database: String(input.database),
      ssl: input.ssl === true || input.ssl === "true",
    };
  };
  if (type === "mysql") return { type: "mysql", mysql: server(parsed.mysql || parsed, 3306) };
  if (type === "postgresql" || type === "postgres" || type === "pg") {
    return { type: "postgresql", postgresql: server(parsed.postgresql || parsed.postgres || parsed, 5432) };
  }
  if (type === "sqlite") {
    return readTargetConfig({ targetSqlite: String(jsonObject(parsed.sqlite).path || parsed.path || ""), targetConfig: null });
  }
  throw new CliError(`目标数据库配置 ${file} 的 type 不认识：${type || "空"}`, FORWARDX_MIGRATION_EXIT.usage);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function print(options: CliOptions, text: string, json: unknown) {
  // --json 时标准输出只放这一份 JSON（NEX 模块自己的日志在 main 里改到了标准错误）
  if (options.json) process.stdout.write(JSON.stringify(json, null, 2) + "\n");
  else console.log(text);
}

async function runInspect(options: CliOptions) {
  const config = sourceConfigFromOptions(options);
  const source = await openForwardxSourceDatabase(config);
  try {
    const inspection = await inspectForwardxSource(source);
    const lines = [
      `来源：${describeForwardxSource(config)}`,
      `用户 ${inspection.counts.users}、主机 ${inspection.counts.hosts}、转发规则 ${inspection.counts.forwardRules}、隧道 ${inspection.counts.tunnels}、转发组 ${inspection.counts.forwardGroups}`,
    ];
    if (inspection.looksLikeNex) lines.push(`这已经是 NEX 的数据库（有 ${inspection.nexMarkerTables.join("、")}），不用迁移，直接 upgrade 即可`);
    else if (!inspection.isForwardx) lines.push(`不像原版 ForwardX 的数据库：缺少 ${inspection.missingTables.join("、")}`);
    print(options, lines.join("\n"), { source: describeForwardxSource(config), ...inspection });
    if (!inspection.isForwardx) process.exitCode = FORWARDX_MIGRATION_EXIT.notForwardx;
  } finally {
    await source.close();
  }
}

async function runImport(options: CliOptions) {
  const sourceConfig = sourceConfigFromOptions(options);
  const target = readTargetConfig(options);
  const source = await openForwardxSourceDatabase(sourceConfig);
  let built: Awaited<ReturnType<typeof buildForwardxMigrationSnapshot>>;
  let sourcePanelUrl = "";
  try {
    const inspection = await inspectForwardxSource(source);
    if (inspection.looksLikeNex) {
      throw new CliError(`来源已经是 NEX 的数据库（有 ${inspection.nexMarkerTables.join("、")}），不用迁移`, FORWARDX_MIGRATION_EXIT.notForwardx);
    }
    if (!inspection.isForwardx) {
      throw new CliError(`来源不像原版 ForwardX 的数据库：缺少 ${inspection.missingTables.join("、")}`, FORWARDX_MIGRATION_EXIT.notForwardx);
    }
    const settings = await source.selectAll("system_settings");
    sourcePanelUrl = String(settings.find((row) => row.key === "panelPublicUrl")?.value || "").trim();

    // 目标方言定下来以后才加载 NEX 的数据库模块
    process.env.DATABASE_TYPE = target.type;
    if (target.type === "sqlite") {
      // 面板的密钥文件按 SQLITE_PATH 所在目录找（server/env.ts readOrCreateCookieSecret），目标库和正式库在同一目录
      process.env.SQLITE_PATH = target.sqlite.path.replace(/\.nex-import$/, "");
    }
    if (options.jwtSecretFile && !String(process.env.JWT_SECRET || "").trim()) process.env.FORWARDX_JWT_SECRET_PATH = path.resolve(options.jwtSecretFile);
    const schema = await import("./dbSchema");
    built = await buildForwardxMigrationSnapshot(source, {
      targetDefs: schema.getDatabaseTableDefs(),
      migrationTables: schema.MIGRATION_TABLES,
      sourcePanelUrl: sourcePanelUrl || undefined,
    });
  } finally {
    await source.close();
  }

  const runtime = await import("./dbRuntime");
  const schema = await import("./dbSchema");
  const migration = await import("./migration");
  const settingsRepository = await import("./repositories/settingsRepository");
  const { FORWARDX_AGENT_MIGRATION_SETTING } = await import("./forwardxAgentMigration");
  await runtime.connectDatabase(target);
  try {
    await schema.ensureDatabaseSchema();
    const existing = await migration.getPanelDataSummary({ useCache: false });
    if (existing.hasExistingData || existing.userCount > 0) {
      throw new CliError("目标数据库里已经有数据，迁移只往全新的库里导（换一个空库）", FORWARDX_MIGRATION_EXIT.targetNotEmpty);
    }
    const result = await migration.importMigrationSnapshot(built.snapshot, {
      targetPanelUrl: sourcePanelUrl || undefined,
      onProgress: options.json ? undefined : (progress, step) => console.log(`[NEX] 导入 ${progress}% ${step}`),
    });
    const kind = runtime.getDatabaseKind() || target.type;
    await settingsRepository.setSettings({
      databaseConfigured: "true",
      databaseType: kind,
      mysqlConfigured: kind === "mysql" ? "true" : "false",
      postgresqlConfigured: kind === "postgresql" ? "true" : "false",
      sqlitePath: kind === "sqlite" ? String(process.env.SQLITE_PATH || "") : "",
      [FORWARDX_AGENT_MIGRATION_SETTING]: JSON.stringify({ enabled: true, migratedAt: Math.floor(Date.now() / 1000) }),
    });
    const output = {
      success: true,
      source: describeForwardxSource(sourceConfig),
      target: target.type === "sqlite" ? `SQLite ${target.sqlite.path}` : target.type,
      report: built.report,
      import: {
        mode: result.mode,
        partial: result.partial,
        warnings: result.warnings,
        insertedRows: result.insertedRows,
        skippedRows: result.skippedRows,
        skipped: result.skipped,
      },
    };
    if (options.reportFile) {
      fs.mkdirSync(path.dirname(path.resolve(options.reportFile)), { recursive: true });
      fs.writeFileSync(options.reportFile, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
    }
    const lines = [
      `[NEX] 迁移完成：${output.source} → ${output.target}`,
      formatForwardxMigrationReport(built.report),
      `导入 ${result.insertedRows} 行，跳过 ${result.skippedRows} 行${result.skippedRows > 0 ? `（${Object.entries(result.skipped).map(([table, count]) => `${table} ${count}`).join("，")}）` : ""}`,
      ...result.warnings.map((warning) => `注意：${warning}`),
    ];
    print(options, lines.join("\n"), output);
  } finally {
    if (target.type === "sqlite") {
      // 把 WAL 里的内容并回主文件，安装脚本只需要挪一个文件
      try { runtime.getSqlite()?.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 关库时也会合并 */ }
    }
    await runtime.closeDatabase();
  }
}

export async function runForwardxMigrationCli(argv: string[]) {
  const options = parseForwardxMigrationArgs(argv);
  if (options.command === "help") {
    console.log(usage());
    return;
  }
  if (options.json) {
    // 数据库模块、流量汇总这些会往 console.log 打日志，--json 时挪到标准错误，标准输出能直接解析
    console.log = console.error;
    console.info = console.error;
  }
  if (options.command === "inspect") await runInspect(options);
  else await runImport(options);
}

const invokedDirectly = (() => {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return /migrate-forwardx\.js$|forwardxMigrationCli\.ts$/.test(entry);
})();

if (invokedDirectly) {
  runForwardxMigrationCli(process.argv.slice(2))
    .then(() => {
      // NEX 的模块里有定时器（写批处理、缓存清理），命令跑完直接退出
      process.exit(process.exitCode ?? 0);
    })
    .catch((error) => {
      console.error(`[ERROR] 迁移失败：${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof CliError ? error.exitCode : FORWARDX_MIGRATION_EXIT.failed);
    });
}
