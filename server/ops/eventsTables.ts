import { col, type TableDef } from "./tableDefs";

/*
  panel_events：面板的事件时间线（第五套主题「监控 › 事件」和首页「最近动态」）。
  每条是一句写给人看的话（message），加上便于筛选的 kind / level / hostId / userId。
  dataJson 留给前端按需展开的细节（例如断线时长、被拒的 IP 列表），可以为空。
*/
export const eventsTables: TableDef[] = [
  {
    name: "panel_events",
    columns: [
      col("id", "id"),
      col("kind", "varchar", { length: 64, notNull: true }),
      col("level", "varchar", { length: 16, notNull: true, default: "info" }),
      col("hostId", "int"),
      col("userId", "int"),
      col("ruleId", "int"),
      col("message", "text", { notNull: true }),
      col("dataJson", "text"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["createdAt"], ["hostId", "createdAt"], ["userId", "createdAt"], ["level", "createdAt"], ["kind", "createdAt"]],
  },
];

export const eventsMigrationTables: string[] = [];
