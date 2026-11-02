import { col, type TableDef } from "./tableDefs";

/*
  网速测试（Agent 2.2.241 起，见 server/ops/nodeCheck.ts）。

  host_speed_tests —— 每次测速一行（每个对象留最近 10 次，见 trimSpeedTestHistory）。
    hostId：从哪台机器测的。
    nodeId：经哪个节点测的；0 = 测这台机器自己的出口。
    entryKey：2.3.502–2.3.504 订阅线路整链测速用的，那个测速 2.3.505 去掉了；列留着（老库里有），新记录不写，
      旧行在下一次测速落库时删掉（server/ops/nodeCheck.ts recordSpeedTest）。
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
