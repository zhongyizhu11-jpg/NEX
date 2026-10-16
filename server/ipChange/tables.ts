/*
  自动换 IP 的三张表，交给 dbSchema 统一建表 / 补列（三种数据库通用）。

  - ip_change_cloud_accounts：云账号。credentialsJson 是加密后的密文（见 ./secrets.ts）。
  - ip_change_host_configs：每台主机一行。探测目标、阈值、冷却、上限，以及运行状态
    （state / consecutiveFailures / lastCheckAt / lastChangeAt / lastError / generation）。
  - ip_change_events：每一次更换（手动 / 自动）一行。触发来源这一列叫 triggerKind ——
    TRIGGER 在 MySQL 里是保留字，任何一处裸写列名都会炸，干脆避开。
*/
import type { ColumnDef, ColumnType, TableDef } from "../dbSchema";

const col = (name: string, type: ColumnType, opts: Omit<ColumnDef, "name" | "type"> = {}): ColumnDef => ({ name, type, ...opts });

export const IP_CHANGE_TABLE_DEFS: TableDef[] = [
  {
    name: "ip_change_cloud_accounts",
    columns: [
      col("id", "id"),
      col("name", "varchar", { length: 128, notNull: true }),
      col("provider", "varchar", { length: 64, notNull: true }),
      col("credentialsJson", "longtext"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
  },
  {
    name: "ip_change_host_configs",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("enabled", "bool", { notNull: true, default: false }),
      col("autoEnabled", "bool", { notNull: true, default: false }),
      col("cloudAccountId", "int"),
      col("targetJson", "text"),
      col("checkTargets", "text"),
      col("checkMethod", "varchar", { length: 16, notNull: true, default: "tcp" }),
      col("failureThreshold", "int", { notNull: true, default: 5 }),
      col("checkIntervalSeconds", "int", { notNull: true, default: 60 }),
      col("cooldownMinutes", "int", { notNull: true, default: 30 }),
      col("maxChangesPerDay", "int", { notNull: true, default: 3 }),
      col("releaseOldIp", "bool", { notNull: true, default: true }),
      col("state", "varchar", { length: 32, notNull: true, default: "idle" }),
      col("consecutiveFailures", "int", { notNull: true, default: 0 }),
      col("lastCheckAt", "epoch"),
      col("lastChangeAt", "epoch"),
      col("lastError", "text"),
      col("generation", "int", { notNull: true, default: 0 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["hostId"]],
    indexes: [["cloudAccountId"]],
  },
  {
    name: "ip_change_events",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("triggerKind", "varchar", { length: 16, notNull: true, default: "manual" }),
      col("provider", "varchar", { length: 64 }),
      col("oldIp", "varchar", { length: 64 }),
      col("newIp", "varchar", { length: 64 }),
      col("ipRole", "varchar", { length: 16 }),
      col("status", "varchar", { length: 16, notNull: true, default: "running" }),
      col("error", "text"),
      col("notes", "text"),
      col("startedAt", "epoch", { notNull: true, default: "now" }),
      col("finishedAt", "epoch"),
    ],
    indexes: [["hostId", "id"], ["startedAt"], ["status"]],
  },
];

/** 跟着备份 / 迁移 / 切换数据库走的表。事件是历史记录，精简迁移时不带（见 migration.ts）。 */
export const IP_CHANGE_MIGRATION_TABLES = ["ip_change_cloud_accounts", "ip_change_host_configs", "ip_change_events"] as const;
