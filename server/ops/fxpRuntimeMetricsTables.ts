import { col, type TableDef } from "./tableDefs";

/*
  FXP 数据面运行时指标（server/ops/fxpRuntimeMetrics.ts）：每个 FXP 进程每分钟报一次，每个（主机, 隧道, 规则, 角色, 名字）一行，
  counter 是这一分钟发生的次数、gauge 是取数那一刻的值。留 7 天，/metrics 导出最近 5 分钟。统计流水，不进备份 / 迁移。
*/
export const fxpRuntimeMetricsTables: TableDef[] = [
  {
    name: "fxp_runtime_metrics",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      /** 0 = 进程级（没有隧道可挂的事件，比如半关闭到期回收）。 */
      col("tunnelId", "int", { notNull: true, default: 0 }),
      col("ruleId", "int", { notNull: true, default: 0 }),
      col("role", "varchar", { length: 16, notNull: true }),
      col("name", "varchar", { length: 32, notNull: true }),
      col("kind", "varchar", { length: 8, notNull: true }),
      /** 这一行所在的那一分钟（Unix 秒，整分）。 */
      col("minuteAt", "epoch", { notNull: true }),
      col("value", "bigint", { notNull: true, default: 0 }),
    ],
    indexes: [["minuteAt"], ["hostId", "minuteAt"]],
  },
];

export const fxpRuntimeMetricsMigrationTables: string[] = [];
