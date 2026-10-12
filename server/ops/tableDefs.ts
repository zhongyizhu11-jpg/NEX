/*
  第五套主题「朱砂」带来的那批运维功能（事件、地区规则、IP 封禁、在线 IP、安全巡检、
  Agent 中转、API 令牌、通行密钥、异地备份……）各自的表，在这里汇总后交给 dbSchema。

  每个功能一份 server/ops/<功能>Tables.ts，只往自己那份里加表，互不改同一个文件。
  表和别的表一样由 ensureDatabaseSchema 自动建 / 补列，三种数据库通用。
*/
import type { ColumnDef, ColumnType, TableDef } from "../dbSchema";

export const col = (name: string, type: ColumnType, opts: Omit<ColumnDef, "name" | "type"> = {}): ColumnDef => ({ name, type, ...opts });

export type { TableDef };
