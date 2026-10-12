import { col, type TableDef } from "./tableDefs";

/*
  安全巡检（#3）的三张表：

  host_security_findings —— 每台主机上每个「发现」一行，按 (hostId, fingerprint) 唯一。
    status：open 待处理 / acknowledged 已知道（同一件事之后再发生会重新打开）/
            expected 这是我的（不再提醒；expectedScope = host 只这台，all 所有主机）。
    persistent：状态类（端口开着、进程在跑）每次巡检都会再报；变化类（多了一把钥匙）只报一次。
    episodeAt：这一段从什么时候开始。状态类消失后再出现，episodeAt 会变大 —— 「已知道」的据此重开。
    resolvedAt：状态类在最近一次完整巡检里已经没有了。

  host_security_expected —— 「所有主机都别再提」的指纹。新主机、以后才出现的同一件事也认它。

  host_security_actions —— 停止进程 / 隔离文件 / 撤销隔离。pending 的随指令发给 Agent，
    Agent 核对后执行并回报结果（done / failed）。
*/
export const hostSecurityTables: TableDef[] = [
  {
    name: "host_security_findings",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("fingerprint", "varchar", { length: 64, notNull: true }),
      col("kind", "varchar", { length: 48, notNull: true }),
      col("severity", "varchar", { length: 16, notNull: true, default: "medium" }),
      col("title", "text", { notNull: true }),
      col("detail", "text"),
      col("evidenceJson", "text"),
      col("status", "varchar", { length: 16, notNull: true, default: "open" }),
      col("expectedScope", "varchar", { length: 8 }),
      col("persistent", "bool", { notNull: true, default: false }),
      col("episodeAt", "epoch"),
      col("firstSeenAt", "epoch", { notNull: true, default: "now" }),
      col("lastSeenAt", "epoch", { notNull: true, default: "now" }),
      col("resolvedAt", "epoch"),
      col("decidedAt", "epoch"),
      col("decidedBy", "int"),
    ],
    unique: [["hostId", "fingerprint"]],
    indexes: [["status", "lastSeenAt"], ["hostId", "status"], ["fingerprint"]],
  },
  {
    name: "host_security_expected",
    columns: [
      col("id", "id"),
      col("fingerprint", "varchar", { length: 64, notNull: true }),
      col("kind", "varchar", { length: 48 }),
      col("title", "text"),
      col("createdBy", "int"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["fingerprint"]],
  },
  {
    name: "host_security_actions",
    columns: [
      col("id", "id"),
      col("findingId", "int", { notNull: true }),
      col("hostId", "int", { notNull: true }),
      col("action", "varchar", { length: 16, notNull: true }),
      col("status", "varchar", { length: 16, notNull: true, default: "pending" }),
      col("payloadJson", "text"),
      col("message", "text"),
      col("quarantineId", "varchar", { length: 80 }),
      col("requestedBy", "int"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("finishedAt", "epoch"),
    ],
    indexes: [["hostId", "status"], ["findingId", "createdAt"]],
  },
];

/** 需要随「备份 / 迁移」一起导出的表名（只放配置类的表，流水和统计不放）。 */
export const hostSecurityMigrationTables: string[] = [];
