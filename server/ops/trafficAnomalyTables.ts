import { col, type TableDef } from "./tableDefs";

/*
  流量异常的自动临时限速（server/ops/trafficAnomalyThrottles.ts）：每条根规则最多一行。
  落库只为一件事 —— 面板重启后知道「之前给谁加过、该什么时候撤」，启动时收回。
  心跳下发读的是内存里的那份，不读这张表。运行时状态，不进备份 / 迁移。
*/
export const trafficAnomalyTables: TableDef[] = [
  {
    name: "traffic_anomaly_throttles",
    columns: [
      col("id", "id"),
      /** 根规则（转发组成员归模板、线路组中转跳归父规则，和 ruleLimitRootId 同一口径）。 */
      col("ruleId", "int", { notNull: true }),
      col("mbps", "int", { notNull: true, default: 0 }),
      /** 加限速那一刻的基线和异常线（Mbps × 10，存整数），重启后恢复告警状态用。 */
      col("baselineDeciMbps", "int", { notNull: true, default: 0 }),
      col("thresholdDeciMbps", "int", { notNull: true, default: 0 }),
      col("appliedAt", "epoch", { notNull: true }),
      col("expiresAt", "epoch", { notNull: true }),
    ],
    unique: [["ruleId"]],
    indexes: [["expiresAt"]],
  },
];

export const trafficAnomalyMigrationTables: string[] = [];
