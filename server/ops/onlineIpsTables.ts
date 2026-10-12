import { col, type TableDef } from "./tableDefs";

/*
  ip_sightings：在线 IP 的历史（「监控 › 在线 IP › IP 历史」和用户的「24 小时内用过几个 IP」）。

  一行 = 某台主机上、某个 IP、连的是某个用户的某条规则 / 某个入站。同一个键持续在线时只更新
  lastSeenAt（每个键最多一分钟写一次），connCount 记这段时间里同一时刻最多几条连接。
  保留 90 天，过期在收上报时顺手删（见 server/ops/onlineIps.ts）。
  ruleId / inboundId 没有的记 0（不用 NULL，好让「同一个键」的查询在三种库上写法一样）。
*/
export const onlineIpsTables: TableDef[] = [
  {
    name: "ip_sightings",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("ip", "varchar", { length: 64, notNull: true }),
      col("userId", "int", { notNull: true, default: 0 }),
      col("ruleId", "int", { notNull: true, default: 0 }),
      col("inboundId", "int", { notNull: true, default: 0 }),
      col("firstSeenAt", "epoch", { notNull: true, default: "now" }),
      col("lastSeenAt", "epoch", { notNull: true, default: "now" }),
      col("connCount", "int", { notNull: true, default: 0 }),
    ],
    indexes: [["lastSeenAt"], ["ip", "lastSeenAt"], ["userId", "lastSeenAt"], ["hostId", "lastSeenAt"], ["hostId", "ip", "userId", "ruleId", "inboundId"]],
  },
];

/** 需要随「备份 / 迁移」一起导出的表名（只放配置类的表，流水和统计不放）。 */
export const onlineIpsMigrationTables: string[] = [];
