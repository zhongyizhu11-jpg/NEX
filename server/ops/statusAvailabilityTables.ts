import { col, type TableDef } from "./tableDefs";

/*
  公开状态页的可用率（#1）。

  host_availability_days：每台主机每天（北京时间）一行，记「看着它的秒数」和「其中断线的秒数」。
    observedSeconds 只算面板自己在跑、确实看着它的时间 —— 面板停机那段既不算在线也不算断线，
    否则面板升级重启一次，所有主机都会白白挨一次「断线」。
  host_availability_incidents：一次断线一行，endedAt 为空表示还没恢复。

  两张都是统计流水，不进备份 / 迁移（换了面板重新开始攒即可）。
*/
export const statusAvailabilityTables: TableDef[] = [
  {
    name: "host_availability_days",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("day", "varchar", { length: 10, notNull: true }),
      col("downSeconds", "int", { notNull: true, default: 0 }),
      col("observedSeconds", "int", { notNull: true, default: 0 }),
      /** 采样次数（每分钟一次；回填的那几天按心跳条数算） */
      col("samples", "int", { notNull: true, default: 0 }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["hostId", "day"], ["day"]],
  },
  {
    name: "host_availability_incidents",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("startedAt", "epoch", { notNull: true }),
      col("endedAt", "epoch"),
      col("durationSeconds", "int", { notNull: true, default: 0 }),
    ],
    indexes: [["hostId", "startedAt"], ["startedAt"], ["endedAt"]],
  },
];

/** 需要随「备份 / 迁移」一起导出的表名（只放配置类的表，流水和统计不放）。 */
export const statusAvailabilityMigrationTables: string[] = [];
