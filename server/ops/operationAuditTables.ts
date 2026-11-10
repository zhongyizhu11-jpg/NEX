import { col, type TableDef } from "./tableDefs";

/*
  operation_audit_events：操作审计（监控 › 操作审计）。所有登录用户的写操作（tRPC mutation）一行，
  由 server/_core/trpc.ts 的 recordOperationAudit 中间件写，逻辑在 server/operationAudit.ts。

  和 config_audit_events 分开放：那张表的 id 是下发给 Agent 的配置版本号（latestConfigRevision），
  写一行就让所有机器的心跳计划失效；改个昵称、建个套餐不能去碰它。两边靠 requestId 串起来。

  inputJson 是打过码的参数摘要（shared/operationAudit.ts redactAuditInput），最多 4KB。
  不跟着备份 / 迁移走：它是流水，不是配置；按「保留天数」（默认 90 天）每天清理。
*/
export const operationAuditTables: TableDef[] = [
  {
    name: "operation_audit_events",
    columns: [
      col("id", "id"),
      col("actorUserId", "int"),
      col("actorName", "varchar", { length: 128 }),
      col("actorRole", "varchar", { length: 16 }),
      col("apiTokenId", "int"),
      col("apiTokenName", "varchar", { length: 64 }),
      // 管理员代入用户后台时做的操作：actor* 是管理员，这两列是被代入的用户（平时为空）。
      col("onBehalfOfUserId", "int"),
      col("onBehalfOfName", "varchar", { length: 128 }),
      col("channel", "varchar", { length: 16, notNull: true, default: "web" }),
      col("path", "varchar", { length: 128, notNull: true }),
      col("module", "varchar", { length: 96, notNull: true }),
      col("result", "varchar", { length: 16, notNull: true, default: "ok" }),
      col("errorCode", "varchar", { length: 32 }),
      col("errorMessage", "text"),
      col("inputJson", "text"),
      col("ip", "varchar", { length: 64 }),
      col("userAgent", "varchar", { length: 256 }),
      col("requestId", "varchar", { length: 64 }),
      col("durationMs", "int"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["createdAt"], ["actorUserId", "id"], ["module", "id"], ["result", "id"], ["requestId"]],
  },
];

export const operationAuditMigrationTables: string[] = [];
