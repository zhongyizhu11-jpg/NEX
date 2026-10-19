import { col, type TableDef } from "./tableDefs";

/*
  逐跳连接监控（server/ops/connStats.ts）：FXP 每分钟报一次，每个（主机, 隧道, 规则, 角色, 阶段, 端点）一行。
  留 7 天。统计流水，不进备份 / 迁移（换了面板重新开始攒即可）。
*/
export const connStatsTables: TableDef[] = [
  {
    name: "connection_stage_stats",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("tunnelId", "int", { notNull: true }),
      col("ruleId", "int", { notNull: true, default: 0 }),
      col("role", "varchar", { length: 16, notNull: true }),
      col("stage", "varchar", { length: 16, notNull: true }),
      col("endpoint", "varchar", { length: 160, notNull: true }),
      /** 这一行所在的那一分钟（Unix 秒，整分）。 */
      col("minuteAt", "epoch", { notNull: true }),
      col("attempts", "int", { notNull: true, default: 0 }),
      col("failures", "int", { notNull: true, default: 0 }),
      col("sumMs", "bigint", { notNull: true, default: 0 }),
      col("maxMs", "int", { notNull: true, default: 0 }),
      col("b50", "int", { notNull: true, default: 0 }),
      col("b100", "int", { notNull: true, default: 0 }),
      col("b200", "int", { notNull: true, default: 0 }),
      col("b500", "int", { notNull: true, default: 0 }),
      col("b1000", "int", { notNull: true, default: 0 }),
      col("bOver", "int", { notNull: true, default: 0 }),
      col("lastError", "text"),
      /** 单连接叠加的「每一路」（stage=leg）：哪一路（relay#主机 ID / stream#N）、这一分钟送出 / 收到多少字节。 */
      col("via", "varchar", { length: 32, notNull: true, default: "" }),
      col("bytesUp", "bigint", { notNull: true, default: 0 }),
      col("bytesDown", "bigint", { notNull: true, default: 0 }),
    ],
    indexes: [["tunnelId", "minuteAt"], ["minuteAt"]],
  },
];

export const connStatsMigrationTables: string[] = [];
