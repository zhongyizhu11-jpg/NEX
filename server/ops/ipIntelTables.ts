import { col, type TableDef } from "./tableDefs";

/*
  网络画像的 IP 信息缓存（Agent 2.2.253 起，见 shared/ipIntel.ts、server/ops/ipIntel.ts）。

  host_ip_intel —— 每台主机 × 每个协议族（4 / 6）× 每家数据库一行，存最近一次的结果：
    via：agent 从主机出口查的 / panel 面板代查的（带 Key 的那几家、旧 Agent 的兜底）。
    ok + reason：查没查到；没查到时 reason 是界面上「暂不可用（原因）」里那句话。
    infoJson：shared/ipIntel.ts 的 IpIntelInfo（已经按面板规则读好的字段，不存原始响应）。
    checkedAt：查的时间，过了一天（失败的半小时）才会再查。

  只是缓存：不进备份 / 迁移，换面板后下一轮检测自然补上。
*/
export const ipIntelTables: TableDef[] = [
  {
    name: "host_ip_intel",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("family", "int", { notNull: true, default: 4 }),
      col("provider", "varchar", { length: 24, notNull: true }),
      col("via", "varchar", { length: 8, notNull: true, default: "panel" }),
      col("address", "varchar", { length: 64 }),
      col("ok", "bool", { notNull: true, default: false }),
      col("reason", "text"),
      col("infoJson", "text"),
      col("checkedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["hostId", "family", "provider"]],
    indexes: [["hostId"]],
  },
];
