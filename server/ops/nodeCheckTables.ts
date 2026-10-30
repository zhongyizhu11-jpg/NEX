import { col, type TableDef } from "./tableDefs";

/*
  网速测试（Agent 2.2.241 起，见 server/ops/nodeCheck.ts）。

  host_speed_tests —— 每次测速一行（每个对象留最近 10 次，见 trimSpeedTestHistory）。
    hostId：从哪台机器测的。
    nodeId：经哪个节点测的；0 = 测这台机器自己的出口。
    entryKey：测的是订阅里哪条线路（rule-<规则 id> / direct-<模板 id>）；从 hostId 那台机器连线路入口走完整条链。
    resultJson：shared/nodeCheck.ts 的 SpeedTestResult（校验过才落库，曲线也在里面）。
  经节点的出口检测只放内存（一小时），不落库：那是临时看一眼的东西。换面板时测速记录也不搬。
*/
export const nodeCheckTables: TableDef[] = [
  {
    name: "host_speed_tests",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("nodeId", "int", { notNull: true, default: 0 }),
      col("entryKey", "varchar", { length: 48 }),
      col("runId", "varchar", { length: 64, notNull: true }),
      col("requestedBy", "int"),
      col("resultJson", "text", { notNull: true }),
      col("checkedAt", "epoch", { notNull: true, default: "now" }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["runId"]],
    indexes: [["hostId", "checkedAt"], ["nodeId", "checkedAt"], ["entryKey", "checkedAt"]],
  },
];

/** 测速记录是临时量出来的数，换面板不搬。 */
export const nodeCheckMigrationTables: string[] = [];
