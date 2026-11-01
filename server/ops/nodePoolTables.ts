import { col, type TableDef } from "./tableDefs";

/*
  节点池（2.3.496，线路的一层候选，shared/routeLines.ts 的 layer.kind = "pool"）。

  一个池就是几台自己的机器加一个用途：中转（线路里一层选它，面板展开时在池里挑）或落地（2.3.500，
  server/landingPools.ts：同一份落地配置开在每台成员机上，订阅里整个池只出一条）。池里加减机器，
  用到它的线路自动重新展开（server/nodePools.ts）。入口组、出口组还是 forward_groups 那一套（它们有
  DNS、隧道出口这些运行时语义）；节点池页面把它们放在一起看，也能从它们「导入」成员建一个池。
    hostIdsJson：成员主机 id，按顺序（「按顺序」挑法时前面的优先；落地池里排第一的是首选）。
    role：relay / landing。2.3.499 以前还有 any（通用），读的时候当 relay。
    landingJson：落地池的那一份配置（shared/landingPool.ts 的 LandingConfig，含凭据和 REALITY 私钥，
      不出接口）。每台成员机上的入站（proxy_inbounds.nodePoolId）照它开，凭据一模一样。
    directDomain：直连用的域名（可选）。设了它，订阅里多一条直连，DNS 只解析到能用的成员；
      没设就只走中转。directDnsValue 是上次写进 DNS 的值，变了才再写。
    landingStateJson：上次同步每台成员的结果（端口、换端口了没有、为什么没开出来），给界面看。
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
      col("landingJson", "text"),
      col("directDomain", "text"),
      col("directDnsValue", "text"),
      col("landingStateJson", "text"),
      col("sortOrder", "int", { notNull: true, default: 0 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId", "sortOrder"]],
  },
];

/** 节点池是配置：换面板要带走。 */
export const nodePoolMigrationTables: string[] = ["node_pools"];
