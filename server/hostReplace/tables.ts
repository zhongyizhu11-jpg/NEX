/*
  主机替换的记录（server/hostReplace/）：一次替换一行，撤回靠它。

  changesJson 记的是这次改了哪些行、每一列原来是什么、改成了什么（按单元分组，见 ./changes.ts），
  撤回时先核对「现在还是不是我们改成的那个值」，对得上才改回去。summaryJson 是给界面看的数量和
  需要手动处理的清单。不进面板迁移：记的是这个库里的行 id，换了库没有意义。
*/
import type { ColumnDef, ColumnType, TableDef } from "../dbSchema";

const col = (name: string, type: ColumnType, opts: Omit<ColumnDef, "name" | "type"> = {}): ColumnDef => ({ name, type, ...opts });

export const HOST_REPLACE_TABLE_DEFS: TableDef[] = [
  {
    name: "host_replacements",
    columns: [
      col("id", "id"),
      col("oldHostId", "int", { notNull: true }),
      col("newHostId", "int", { notNull: true }),
      col("status", "varchar", { length: 16, notNull: true, default: "done" }),
      col("actorUserId", "int"),
      col("summaryJson", "longtext"),
      col("changesJson", "longtext"),
      col("undoReportJson", "text"),
      col("maintenanceSet", "bool", { notNull: true, default: false }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("undoneAt", "epoch"),
      col("expiresAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["oldHostId", "id"], ["newHostId", "id"], ["expiresAt"]],
  },
];
