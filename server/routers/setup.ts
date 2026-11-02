import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../_core/trpc";
import { MIGRATION_TABLES, ensureDatabaseSchema } from "../dbSchema";
import {
  DatabaseConfig,
  DatabaseDialectMismatchError,
  closeDatabase,
  defaultSqlitePath,
  executeRaw,
  getConfiguredDatabaseKind,
  getDb,
  getDatabaseKind,
  getSchemaDialect,
  isDatabaseSetupPendingConfig,
  maskDatabaseConfig,
  queryRaw,
  readDatabaseConfig,
  reconnectDatabase,
  testDatabaseConnection,
  withDatabaseTransaction,
  writeDatabaseConfig,
} from "../dbRuntime";
import { countAll, quoteIdentifier } from "../dbCompat";
import { createInitialAdmin, hasAdminUser, updateInitialAdmin } from "../db";
import { getAllSettings, setSettings } from "../repositories/settingsRepository";
import { getMigrationJob, hasActivePanelMigration, startPanelMigration } from "../migration";
import {
  hasLocalSetupCompleteMarker,
  markLocalSetupComplete,
} from "../setupState";
import { startBackgroundServices } from "../backgroundServices";
import { isDevPanelMode } from "../devPanel";
import { PANEL_MIGRATION_SCOPES } from "../../shared/panelMigration";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { revokeAllUserApiTokens } from "../ops/apiTokens";

let setupSchemaReadyKey = "";
const SETUP_WRITE_LOCK_KEY = "panel-setup-write";

function friendlyDatabaseError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const code = String((error as any)?.code || "");
  const hostname = String((error as any)?.hostname || "").trim();
  if (code === "ENOTFOUND" || /getaddrinfo ENOTFOUND/i.test(raw)) {
    const hostMatch = raw.match(/ENOTFOUND\s+([^\s]+)/i);
    const host = hostname || hostMatch?.[1] || "数据库地址";
    return `无法解析数据库地址 ${host}。如果面板通过 Docker/1Panel 部署，请确认这个主机名在面板容器内部可解析，或改用数据库容器服务名、同网络容器名、宿主机内网 IP 或可访问的域名。`;
  }
  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(raw)) {
    return "数据库连接被拒绝。请检查数据库服务是否启动、端口是否正确，以及防火墙或 Docker 网络是否允许面板容器访问。";
  }
  if (code === "ETIMEDOUT" || /timeout|timed out/i.test(raw)) {
    return "数据库连接超时。请检查数据库地址、端口、防火墙、安全组和 Docker 网络。";
  }
  if (/password authentication failed|access denied/i.test(raw)) {
    return "数据库账号或密码验证失败，请检查用户名、密码和数据库权限。";
  }
  return raw;
}

const mysqlConfigInput = z.object({
  host: z.string().trim().min(1, "请输入 MySQL 地址"),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  user: z.string().trim().min(1, "请输入 MySQL 用户名"),
  password: z.string().default(""),
  database: z.string().trim().min(1, "请输入数据库名"),
  ssl: z.boolean().default(false),
});

const postgresqlConfigInput = z.object({
  host: z.string().trim().min(1, "请输入 PostgreSQL 地址"),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  user: z.string().trim().min(1, "请输入 PostgreSQL 用户名"),
  password: z.string().default(""),
  database: z.string().trim().min(1, "请输入数据库名"),
  ssl: z.boolean().default(false),
});

const databaseConfigInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mysql"), mysql: mysqlConfigInput }),
  z.object({ type: z.literal("postgresql"), postgresql: postgresqlConfigInput }),
  z.object({
    type: z.literal("sqlite"),
    sqlite: z.object({
      path: z.string().trim().min(1).default(defaultSqlitePath()),
    }),
  }),
]);
const databaseSetupInput = databaseConfigInput;

async function ensureSetupSchemaReady() {
  const db = await getDb();
  if (!db) throw new Error("Database is not connected");
  const key = `${getConfiguredDatabaseKind() || ""}:${getDatabaseKind() || ""}`;
  if (setupSchemaReadyKey !== key) {
    await ensureDatabaseSchema();
    setupSchemaReadyKey = key;
  }
  return db;
}

async function setupStatus() {
  const localSetupComplete = hasLocalSetupCompleteMarker();
  if (isDevPanelMode()) {
    return {
      databaseConfigured: true,
      databaseConnected: true,
      databaseType: "sqlite" as const,
      activeDatabaseType: getDatabaseKind(),
      schemaReady: true,
      hasAdmin: true,
      hasExistingData: false,
      existingData: null,
      setupDataChoice: "new-panel",
      setupComplete: true,
      setupLocked: false,
      config: maskDatabaseConfig(readDatabaseConfig()),
      needsRestart: false,
      defaultSqlitePath: defaultSqlitePath(),
      error: null,
    };
  }

  const config = readDatabaseConfig();
  if (!config) {
    return {
      databaseConfigured: false,
      databaseConnected: false,
      databaseType: null,
      activeDatabaseType: getDatabaseKind(),
      schemaReady: false,
      hasAdmin: false,
      hasExistingData: false,
      existingData: null,
      setupDataChoice: null,
      setupComplete: false,
      setupLocked: localSetupComplete,
      config: null,
      needsRestart: false,
      defaultSqlitePath: defaultSqlitePath(),
      error: null,
    };
  }

  try {
    const db = await getDb();
    if (!db) throw new Error("数据库未连接");
    await ensureSetupSchemaReady();
    const hasAdmin = await hasAdminUser();
    const migrationActive = hasActivePanelMigration();
    const settings = await getAllSettings();
    const setupDataChoice = settings.setupDataChoice || null;
    const existingData = hasAdmin || localSetupComplete ? null : await getExistingDataSummary();
    const hasExistingData = existingData?.hasExistingData ?? false;
    return {
      databaseConfigured: true,
      databaseConnected: true,
      databaseType: config.type,
      activeDatabaseType: getDatabaseKind(),
      schemaReady: true,
      hasAdmin,
      hasExistingData,
      existingData,
      setupDataChoice,
      setupComplete: hasAdmin && !migrationActive,
      setupLocked: localSetupComplete && !hasAdmin,
      config: maskDatabaseConfig(config),
      needsRestart: false,
      defaultSqlitePath: defaultSqlitePath(),
      error: null,
    };
  } catch (error) {
    const needsRestart = error instanceof DatabaseDialectMismatchError || getConfiguredDatabaseKind() !== getDatabaseKind();
    return {
      databaseConfigured: true,
      databaseConnected: false,
      databaseType: config.type,
      activeDatabaseType: getDatabaseKind(),
      schemaReady: false,
      hasAdmin: false,
      hasExistingData: false,
      existingData: null,
      setupDataChoice: null,
      setupComplete: false,
      setupLocked: localSetupComplete,
      config: maskDatabaseConfig(config),
      needsRestart,
      defaultSqlitePath: defaultSqlitePath(),
      error: friendlyDatabaseError(error),
    };
  }
}

/*
  安装向导的写接口（切库、清库、建/改首位管理员、迁移）只在「还没装好」时开放。
  装好（本机有完成标记，或库里已有管理员）以后对所有人拒绝，管理员和管理员的 API 令牌也不例外：
  以前管理员直接放行，一枚管理员令牌调 resetExistingData 就能清库、调 updateAdmin 就能改写
  首位管理员的邮箱和密码。数据库故障恢复（首次安装没完成、库连不上）那条路照旧保留。
*/
async function ensureSetupWriteAllowed(options: { allowDatabaseRecovery?: boolean } = {}) {
  if (hasActivePanelMigration()) {
    throw new TRPCError({ code: "CONFLICT", message: "SETUP_MIGRATION_RUNNING" });
  }
  if (hasLocalSetupCompleteMarker()) {
    throw new TRPCError({ code: "FORBIDDEN", message: "SETUP_LOCKED" });
  }
  const config = readDatabaseConfig();
  if (!config) {
    return;
  }
  try {
    await ensureSetupSchemaReady();
    if (!await hasAdminUser()) return;
  } catch {
    if (options.allowDatabaseRecovery && isDatabaseSetupPendingConfig()) {
      return;
    }
    throw new TRPCError({ code: "FORBIDDEN", message: "SETUP_LOCKED" });
  }
  throw new TRPCError({ code: "FORBIDDEN", message: "SETUP_LOCKED" });
}

async function withSetupWriteLock<T>(
  work: () => Promise<T>,
  options: { allowDatabaseRecovery?: boolean } = {},
) {
  return withKeyedTaskLock(SETUP_WRITE_LOCK_KEY, async () => {
    await ensureSetupWriteAllowed(options);
    return work();
  });
}

async function lockInitialAdminCreation() {
  const kind = getDatabaseKind();
  if (!kind || kind === "sqlite") return;
  const table = quoteIdentifier("system_settings");
  const key = quoteIdentifier("key");
  await queryRaw(`SELECT ${key} FROM ${table} WHERE ${key} = ? FOR UPDATE`, ["registrationEnabled"]);
}

function redactSetupStatusForPublic(status: Awaited<ReturnType<typeof setupStatus>>) {
  return {
    ...status,
    hasExistingData: false,
    existingData: null,
    setupDataChoice: null,
    config: null,
    defaultSqlitePath: "",
    error: status.setupComplete || status.hasAdmin || status.setupLocked ? null : status.error,
  };
}

async function countTableRows(table: string) {
  try {
    const rows = await queryRaw<{ count: number }>(`SELECT ${countAll()} FROM ${quoteIdentifier(table)}`);
    return Number(rows[0]?.count || 0);
  } catch {
    return 0;
  }
}

async function getExistingDataSummary() {
  const counts: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) {
    counts[table] = await countTableRows(table);
  }
  const userCount = counts.users || 0;
  const hostCount = counts.hosts || 0;
  const ruleCount = counts.forward_rules || 0;
  const tunnelCount = counts.tunnels || 0;
  const businessDataCount = Object.entries(counts).reduce((sum, [table, count]) => {
    if (table === "system_settings") return sum;
    if (table === "users") return sum + Math.max(0, count - 1);
    return sum + count;
  }, 0);
  const hasExistingData = businessDataCount > 0;
  return { hasExistingData, businessDataCount, userCount, hostCount, ruleCount, tunnelCount, counts };
}

async function clearExistingPanelData() {
  await reconnectDatabase();
  await ensureDatabaseSchema();
  await withDatabaseTransaction(async () => {
    const settings = await getAllSettings();
    for (const table of [...MIGRATION_TABLES].reverse()) {
      await executeRaw(`DELETE FROM ${quoteIdentifier(table)}`);
    }
    await setSettings({
      storeEnabled: settings.storeEnabled ?? "false",
      homepageEnabled: settings.homepageEnabled ?? "true",
      homepageCustomEnabled: settings.homepageCustomEnabled ?? "false",
      homepageHtml: settings.homepageHtml ?? "",
      redemptionEnabled: settings.redemptionEnabled ?? "true",
      discountEnabled: settings.discountEnabled ?? "true",
      databaseConfigured: "true",
      databaseType: getDatabaseKind() || "",
      mysqlConfigured: getDatabaseKind() === "mysql" ? "true" : "false",
      mysqlHost: settings.mysqlHost ?? "",
      mysqlDatabase: settings.mysqlDatabase ?? "",
      postgresqlConfigured: getDatabaseKind() === "postgresql" ? "true" : "false",
      postgresqlHost: settings.postgresqlHost ?? "",
      postgresqlDatabase: settings.postgresqlDatabase ?? "",
      sqlitePath: settings.sqlitePath ?? "",
      setupDataChoice: "new-panel",
    });
  });
}

async function saveDatabase(input: DatabaseConfig) {
  await testDatabaseConnection(input);
  writeDatabaseConfig(input);
  if (getSchemaDialect() !== input.type) {
    await closeDatabase();
    setTimeout(() => process.exit(0), 800);
    return {
      ...(await setupStatus()),
      needsRestart: true,
      databaseConfigured: true,
      databaseType: input.type,
      error: "数据库类型已切换，服务正在重启以加载对应的数据库方言",
    };
  }
  const db = await reconnectDatabase();
  if (!db) throw new Error("数据库连接未建立");
  await ensureDatabaseSchema();
  startBackgroundServices();
  await setSettings({
    databaseConfigured: "true",
    databaseType: input.type,
    mysqlConfigured: input.type === "mysql" ? "true" : "false",
    mysqlHost: input.type === "mysql" ? input.mysql.host.trim() : "",
    mysqlDatabase: input.type === "mysql" ? input.mysql.database.trim() : "",
    postgresqlConfigured: input.type === "postgresql" ? "true" : "false",
    postgresqlHost: input.type === "postgresql" ? input.postgresql.host.trim() : "",
    postgresqlDatabase: input.type === "postgresql" ? input.postgresql.database.trim() : "",
    sqlitePath: input.type === "sqlite" ? input.sqlite.path.trim() : "",
  });
  return setupStatus();
}

export const setupRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    const status = await setupStatus();
    if (ctx.user?.role === "admin") return status;
    if (status.setupComplete || status.hasAdmin || status.setupLocked) return redactSetupStatusForPublic(status);
    return status;
  }),

  testDatabase: publicProcedure
    .input(databaseSetupInput)
    .mutation(async ({ input }) => {
      return withSetupWriteLock(async () => {
        await testDatabaseConnection(input as DatabaseConfig);
        return { success: true };
      }, { allowDatabaseRecovery: true });
    }),

  saveDatabase: publicProcedure
    .input(databaseSetupInput)
    .mutation(async ({ input }) => {
      return withSetupWriteLock(() => saveDatabase(input as DatabaseConfig), { allowDatabaseRecovery: true });
    }),

  testMysql: publicProcedure
    .input(mysqlConfigInput)
    .mutation(async ({ input }) => {
      return withSetupWriteLock(async () => {
        await testDatabaseConnection({ type: "mysql", mysql: input });
        return { success: true };
      }, { allowDatabaseRecovery: true });
    }),

  saveMysql: publicProcedure
    .input(mysqlConfigInput)
    .mutation(async ({ input }) => {
      return withSetupWriteLock(() => saveDatabase({ type: "mysql", mysql: input }), { allowDatabaseRecovery: true });
    }),

  startMigration: publicProcedure
    .input(z.object({
      oldPanelUrl: z.string().trim().min(1, "请输入旧面板地址"),
      migrationCode: z.string().trim().min(1, "请输入旧面板迁移码"),
      targetPanelUrl: z.string().trim().min(1, "请输入新面板访问地址"),
      dataScope: z.enum(PANEL_MIGRATION_SCOPES).default("essential"),
    }))
    .mutation(async ({ input }) => {
      return withSetupWriteLock(async () => {
        await reconnectDatabase();
        await ensureDatabaseSchema();
        return startPanelMigration(input);
      });
    }),

  migrationStatus: publicProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(({ input }) => getMigrationJob(input.jobId)),

  useExistingData: publicProcedure.mutation(async () => withSetupWriteLock(async () => {
    await reconnectDatabase();
    await ensureDatabaseSchema();
    await setSettings({ setupDataChoice: "use-existing" });
    return setupStatus();
  })),

  resetExistingData: publicProcedure.mutation(async () => withSetupWriteLock(async () => {
    await clearExistingPanelData();
    return setupStatus();
  })),

  createAdmin: publicProcedure
    .input(z.object({
      email: z.string().email("请输入有效邮箱地址").max(320),
      password: z.string().min(8, "密码至少 8 位").max(128).refine((value) => !!value.trim(), "请输入管理员密码"),
      name: z.string().trim().max(64).optional(),
    }))
    .mutation(async ({ input }) => {
      return withSetupWriteLock(async () => {
        await reconnectDatabase();
        await ensureDatabaseSchema();
        const id = await withDatabaseTransaction(async () => {
          await lockInitialAdminCreation();
          const createdId = await createInitialAdmin(input);
          await setSettings({ setupDataChoice: "new-panel" });
          return createdId;
        });
        markLocalSetupComplete();
        return { id, success: true };
      });
    }),

  updateAdmin: publicProcedure
    .input(z.object({
      email: z.string().email("请输入有效邮箱地址").max(320),
      password: z.string().max(128).optional(),
      name: z.string().trim().max(64).optional(),
    }))
    .mutation(async ({ input }) => {
      return withSetupWriteLock(async () => {
        await reconnectDatabase();
        await ensureDatabaseSchema();
        if (input.password !== undefined && !input.password.trim()) {
          throw new Error("新密码不能为空");
        }
        if (input.password && input.password.length < 8) {
          throw new Error("密码至少 8 位");
        }
        const id = await withDatabaseTransaction(async () => {
          const updatedId = await updateInitialAdmin(input);
          if (input.password?.trim()) await revokeAllUserApiTokens(updatedId, "password_reset_setup");
          const existingData = await getExistingDataSummary();
          await setSettings({ setupDataChoice: existingData.hasExistingData ? "use-existing" : "new-panel" });
          return updatedId;
        });
        markLocalSetupComplete();
        return { id, success: true };
      });
    }),
});
