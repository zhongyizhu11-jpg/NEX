import { col, type TableDef } from "./tableDefs";

/*
  api_tokens：个人 API 令牌（设置 › 进阶 › API 令牌与 MCP）。

  只存令牌的 sha256，明文只在创建那一刻给用户看一次 —— 库被拖走也拿不到能用的令牌。
  prefix 是令牌开头 8 个字符，列表里让人认出是哪一个。scope 只有 read / full 两档：
  read 只能跑查询，full 和网页上本人的权限一样（但永远碰不到令牌、密码、2FA、通行密钥、登录设备）。
*/
export const apiTokensTables: TableDef[] = [
  {
    name: "api_tokens",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("name", "varchar", { length: 64, notNull: true }),
      col("prefix", "varchar", { length: 16, notNull: true }),
      col("tokenHash", "varchar", { length: 64, notNull: true }),
      col("scope", "varchar", { length: 16, notNull: true, default: "read" }),
      col("lastUsedAt", "epoch"),
      col("lastUsedIp", "varchar", { length: 64 }),
      col("expiresAt", "epoch"),
      col("revokedAt", "epoch"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["tokenHash"]],
    indexes: [["userId"]],
  },
];

/** 需要随「备份 / 迁移」一起导出的表名（只放配置类的表，流水和统计不放）。 */
export const apiTokensMigrationTables: string[] = ["api_tokens"];
