import { col, type TableDef } from "./tableDefs";

/*
  节点池（2.3.496，线路的一层候选，shared/routeLines.ts 的 layer.kind = "pool"）。

  一个池就是几台自己的机器加一个用途标签（中转 / 落地 / 通用），线路里某一层选它，面板展开时
  在池里挑。池里加减机器，用到它的线路自动重新展开（server/nodePools.ts）。入口组、出口组还是
  forward_groups 那一套（它们有 DNS、隧道出口这些运行时语义）；节点池页面把它们放在一起看，
  也能从它们「导入」成员建一个池。
    hostIdsJson：成员主机 id，按顺序（「按顺序」挑法时前面的优先）。
*/
export const nodePoolTables: TableDef[] = [
  {
    name: "node_pools",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("name", "text", { notNull: true }),
      col("role", "varchar", { length: 16, notNull: true, default: "relay" }),
      col("hostIdsJson", "text", { notNull: true }),
      col("note", "text"),
      col("sortOrder", "int", { notNull: true, default: 0 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId", "sortOrder"]],
  },
];

/** 节点池是配置：换面板要带走。 */
export const nodePoolMigrationTables: string[] = ["node_pools"];
