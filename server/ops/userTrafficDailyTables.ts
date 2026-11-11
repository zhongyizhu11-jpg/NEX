import { col, type TableDef } from "./tableDefs";

/*
  每个用户每条规则每天的流量（server/userTrafficHistory.ts）：给管理员在「用户管理」里看某个用户
  最近 30 / 90 天的流量走势和用量最多的规则。

  不是新的采集：数据全部来自已有的 traffic_stat_buckets（30 分钟桶，Agent 上报的规则流量），
  面板每 10 分钟把最近 3 天重算一遍写到这里。原来的桶只留 72 小时，这张表一天一行，留 100 天。
  ruleId 是用户看得见的那条规则（转发组成员的子规则记到模板规则上）；规则删了行还在，名字显示成「已删除」。
*/
export const userTrafficDailyTables: TableDef[] = [
  {
    name: "user_traffic_daily",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("ruleId", "int", { notNull: true, default: 0 }),
      col("dayStart", "epoch", { notNull: true }),
      col("bytesIn", "bigint", { notNull: true, default: 0 }),
      col("bytesOut", "bigint", { notNull: true, default: 0 }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["userId", "ruleId", "dayStart"]],
    indexes: [["userId", "dayStart"], ["dayStart"]],
  },
];

/** 跟着备份 / 迁移走（用户、规则 ID 重新映射，见 server/migration.ts）；导不进来也只是少几天历史。 */
export const userTrafficDailyMigrationTables: string[] = ["user_traffic_daily"];
