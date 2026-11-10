import { col, type TableDef } from "./tableDefs";

/*
  password_reset_tokens：登录页「忘记密码」发出去的一次性重置链接。

  只存令牌的 sha256，明文只在发出去的那条邮件 / 消息里 —— 库被拖走也拿不到能用的链接。
  一行绑定一个用户；同一个人再申请一次，之前没用掉的行全部作废（invalidatedAt）。
  usedAt 非空 = 已经用过，改密码时用「usedAt 为空」做条件更新，两个人同时点同一条链接只有一个能成。

  credentialMark：签发那一刻「这个账号的密码哈希」的指纹。用户中途自己想起密码改掉了、
  管理员帮他重置了，或者这个 id 后来成了另一个账号，旧链接对不上指纹，一律作废。

  不跟着备份 / 迁移走：半小时的临时凭据。过期 7 天以上的行每天清一次。
*/
export const passwordResetTables: TableDef[] = [
  {
    name: "password_reset_tokens",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("tokenHash", "varchar", { length: 64, notNull: true }),
      col("credentialMark", "varchar", { length: 64, notNull: true }),
      // 发到了哪几个渠道（逗号分隔：email,telegram,discord），审计用。
      col("channels", "varchar", { length: 64 }),
      col("requestIp", "varchar", { length: 64 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("expiresAt", "epoch", { notNull: true }),
      col("usedAt", "epoch"),
      col("invalidatedAt", "epoch"),
    ],
    unique: [["tokenHash"]],
    indexes: [["userId"], ["expiresAt"]],
  },
];

export const passwordResetMigrationTables: string[] = [];
