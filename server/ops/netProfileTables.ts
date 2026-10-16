import { col, type TableDef } from "./tableDefs";

/*
  主机网络画像（Agent 2.2.226 起）：每台主机一行，存最近一次检测的完整结果和最近 30 次的摘要。

  profileJson —— shared/netProfile.ts 的 NetProfileReport（双栈、25 端口、DNSBL）。
  historyJson —— NetProfileHistoryItem[]，最近 30 次，旧的在前。每次只是十几个字段，30 条不到 3KB。
  checkedAt —— 最近一次任何来源的检测；agentCheckedAt —— Agent 最近一次上报（扩展通道下发给 Agent
    当作「面板已经收到」的回执，也用来判断 6 小时到没到）。
*/
export const netProfileTables: TableDef[] = [
  {
    name: "host_network_profiles",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("profileJson", "longtext"),
      col("historyJson", "longtext"),
      col("checkedAt", "epoch"),
      col("agentCheckedAt", "epoch"),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["hostId"]],
  },
];

/** 随「备份 / 迁移」一起走：换面板后不用等 6 小时就有画像。老面板的库里没有这张表（见 migration.ts 的可选表）。 */
export const netProfileMigrationTables: string[] = ["host_network_profiles"];
