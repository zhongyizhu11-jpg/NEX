import { col, type TableDef } from "./tableDefs";

/*
  ops_agent_relay：经其他主机连面板（#8），一台主机一行。

    viaHostId             这台机器连面板时经由哪台主机（空 = 直连）
    autoViaHostId         自动切换：在面板上掉线太多时，自动改走这台（空 = 不自动）
    autoThresholdMinutes  4 小时里累计离线超过几分钟就切
    autoSwitchedAt        自动切过的时间（只切一次，不自动切回）
    listenPort            这台机器给别人当中转时听的端口（分配后一直留着，直到没人经由它）
*/
export const agentRelayTables: TableDef[] = [
  {
    name: "ops_agent_relay",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("viaHostId", "int"),
      col("autoViaHostId", "int"),
      col("autoThresholdMinutes", "int", { notNull: true, default: 3 }),
      col("autoSwitchedAt", "epoch"),
      col("listenPort", "int"),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["hostId"]],
  },
];

/** 需要随「备份 / 迁移」一起导出的表名（只放配置类的表，流水和统计不放）。 */
export const agentRelayMigrationTables: string[] = ["ops_agent_relay"];
