import { col, type TableDef } from "./tableDefs";

/*
  user_passkeys：用户的通行密钥（WebAuthn 凭据）。

  publicKey 是 SPKI DER 的 base64url，alg 是 COSE 算法号（-7 ES256 / -257 RS256 / -8 Ed25519）；
  signCount 用来发现被复制的认证器。credentialId 全局唯一：登录时用户不填用户名，
  浏览器只交回凭据 ID，我们靠它找到人。
*/
export const passkeysTables: TableDef[] = [
  {
    name: "user_passkeys",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("name", "varchar", { length: 64, notNull: true }),
      col("credentialId", "varchar", { length: 512, notNull: true }),
      col("publicKey", "text", { notNull: true }),
      col("alg", "int", { notNull: true }),
      col("signCount", "bigint", { notNull: true, default: 0 }),
      col("transports", "varchar", { length: 128 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("lastUsedAt", "epoch"),
    ],
    unique: [["credentialId"]],
    indexes: [["userId"]],
  },
];

/** 需要随「备份 / 迁移」一起导出的表名（只放配置类的表，流水和统计不放）。 */
export const passkeysMigrationTables: string[] = ["user_passkeys"];
