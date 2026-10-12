import { col, type TableDef } from "./tableDefs";

/*
  地区规则（#4）和 IP 封禁（#5）的表。规则本身（全局模式、国家、面板访问限制）存在系统设置里
  （ops.firewall.*），这里放的是按主机 / 按条目的东西。
*/
export const firewallTables: TableDef[] = [
  {
    // 各国 IP 段的本地缓存：只下载被选中的国家，一周刷新一次。v4 / v6 是合并后的 CIDR，一行一条。
    name: "firewall_country_data",
    columns: [
      col("id", "id"),
      col("country", "varchar", { length: 2, notNull: true }),
      col("v4", "longtext"),
      col("v6", "longtext"),
      col("v4Count", "int", { notNull: true, default: 0 }),
      col("v6Count", "int", { notNull: true, default: 0 }),
      col("source", "varchar", { length: 64 }),
      col("fetchedAt", "epoch"),
      col("attemptedAt", "epoch"),
      col("lastError", "text"),
    ],
    unique: [["country"]],
  },
  {
    // 主机单独的地区规则：follow 跟随全局 / custom 本机单独规则 / off 本机不限制。没有行等于 follow。
    name: "firewall_host_policies",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("policy", "varchar", { length: 16, notNull: true, default: "follow" }),
      col("mode", "varchar", { length: 16, notNull: true, default: "off" }),
      col("countries", "text"),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["hostId"]],
  },
  {
    // 封禁的 IP / 网段。expiresAt 为空是永久；过期的行在下发时就不算了，列表时顺手删掉。
    name: "firewall_blocked_ips",
    columns: [
      col("id", "id"),
      col("cidr", "varchar", { length: 64, notNull: true }),
      col("note", "varchar", { length: 200 }),
      col("expiresAt", "epoch"),
      col("createdBy", "int"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["cidr"]],
    indexes: [["expiresAt"]],
  },
  {
    // Agent 上报的最近一次状态和计数基线（since + 上次的累计值），算每天的增量用。
    name: "firewall_host_state",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("appliedHash", "varchar", { length: 64 }),
      col("countryHash", "varchar", { length: 64 }),
      col("backend", "varchar", { length: 16 }),
      col("active", "bool", { notNull: true, default: false }),
      col("lastError", "text"),
      col("since", "bigint", { notNull: true, default: 0 }),
      col("lastBlock", "bigint", { notNull: true, default: 0 }),
      col("lastCountry", "bigint", { notNull: true, default: 0 }),
      col("ports", "int", { notNull: true, default: 0 }),
      col("reportedAt", "epoch"),
    ],
    unique: [["hostId"]],
  },
  {
    // 每台主机每天拦了多少个连接（day 按北京时间 YYYY-MM-DD）。blocked = IP 封禁，country = 地区规则。
    name: "firewall_daily_stats",
    columns: [
      col("id", "id"),
      col("hostId", "int", { notNull: true }),
      col("day", "varchar", { length: 10, notNull: true }),
      col("blocked", "bigint", { notNull: true, default: 0 }),
      col("country", "bigint", { notNull: true, default: 0 }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["hostId", "day"]],
    indexes: [["day"]],
  },
];

/** 需要随「备份 / 迁移」一起导出的表名（只放配置类的表，流水和统计不放）。 */
export const firewallMigrationTables: string[] = ["firewall_host_policies", "firewall_blocked_ips"];
