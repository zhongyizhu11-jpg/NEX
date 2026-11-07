import { col, type TableDef } from "./tableDefs";

/*
  user_login_devices：每个人登录过的「设备 + 网段」（server/ops/loginDevices.ts）。

  deviceKey = 「iPhone · Safari」这样的设备说法 + IP 网段（IPv4 /24、IPv6 /48）。手机在同一个
  运营商里换个 IP 落在同一段里，不算新设备；换了城市、换了运营商才算。
  只是用来判断「这次登录是不是没见过」，不放进备份 / 迁移：迁到新面板后第一次登录各台设备
  会被当成认识的（每个人的第一条记录不提醒），不会一迁移就把所有人的邮箱刷一遍。
*/
export const loginDevicesTables: TableDef[] = [
  {
    name: "user_login_devices",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("deviceKey", "varchar", { length: 160, notNull: true }),
      col("device", "varchar", { length: 64, notNull: true }),
      col("ipPrefix", "varchar", { length: 64, notNull: true }),
      col("lastIp", "varchar", { length: 64 }),
      col("countryCode", "varchar", { length: 8 }),
      col("loginCount", "int", { notNull: true, default: 1 }),
      col("firstSeenAt", "epoch", { notNull: true, default: "now" }),
      col("lastSeenAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["userId", "deviceKey"]],
    indexes: [["userId", "lastSeenAt"]],
  },
];

export const loginDevicesMigrationTables: string[] = [];
