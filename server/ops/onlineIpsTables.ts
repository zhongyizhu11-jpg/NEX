import type { TableDef } from "./tableDefs";

export const onlineIpsTables: TableDef[] = [];

/** 需要随「备份 / 迁移」一起导出的表名（只放配置类的表，流水和统计不放）。 */
export const onlineIpsMigrationTables: string[] = [];
