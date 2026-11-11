import { col, type TableDef } from "./tableDefs";

/*
  网络拓扑的手动标注（shared/topologyManual.ts，读写见 server/topologyManual.ts）。

  topology_manual_nodes —— 用户自己画的外部节点（没装 Agent 的专线端点、上游机房……）。
  topology_manual_links —— 连线：两头是 manual:<id> / host:<id> / target:<地址:端口> 引用。

  每个账号各画各的（userId），只是展示，不进任何配置。跟着备份 / 迁移走：导入时 userId、
  引用里的主机 ID、标注节点 ID 重新映射（server/migration.ts），所以节点表要排在连线表前面。
*/
export const topologyManualTables: TableDef[] = [
  {
    name: "topology_manual_nodes",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("label", "varchar", { length: 64, notNull: true }),
      col("note", "text"),
      col("country", "varchar", { length: 8 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId"]],
  },
  {
    name: "topology_manual_links",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("fromRef", "varchar", { length: 191, notNull: true }),
      col("toRef", "varchar", { length: 191, notNull: true }),
      col("label", "varchar", { length: 64 }),
      col("note", "text"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId"]],
  },
];

/** 节点在前、连线在后（连线的引用要先有节点的 ID 映射）。 */
export const topologyManualMigrationTables: string[] = ["topology_manual_nodes", "topology_manual_links"];
