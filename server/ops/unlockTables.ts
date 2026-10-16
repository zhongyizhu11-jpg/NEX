import { col, type TableDef } from "./tableDefs";

/*
  流媒体 / AI 解锁检测（Agent 2.2.226 起，见 server/ops/unlock.ts）。

  host_unlock_checks —— 每次检测一行（每台主机留最近 10 次，见 trimUnlockHistory）。
    family：auto / ipv4 / ipv6，同一台机器 v4、v6 出口的解锁情况可能不一样，分开存。
    latest：这台主机这个 family 最新的一行（卡片和详情只读这些，不用每次扫历史）。
    resultsJson：shared/unlockCheck.ts 的 UnlockServiceResult[]（校验过才落库）。
    triggerKind：manual 手动 / schedule 计划检测。
*/
export const unlockTables: TableDef[] = [
  {
    name: "host_unlock_checks",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("family", "varchar", { length: 8, notNull: true, default: "auto" }),
      col("runId", "varchar", { length: 64, notNull: true }),
      col("triggerKind", "varchar", { length: 16, notNull: true, default: "manual" }),
      col("latest", "bool", { notNull: true, default: false }),
      col("resultsJson", "text", { notNull: true }),
      col("requestedBy", "int"),
      col("checkedAt", "epoch", { notNull: true, default: "now" }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["runId"]],
    indexes: [["hostId", "checkedAt"], ["hostId", "latest"]],
  },
];

/** 检测结果和主机绑定，换面板时跟着主机走（导入时 hostId 重新映射，见 server/migration.ts）。 */
export const unlockMigrationTables: string[] = ["host_unlock_checks"];
