import { col, type TableDef } from "./tableDefs";

/*
  user_impersonations：管理员「进入用户后台」的每一次代入（用户管理 › 进入后台）。

  一行就是一枚代入令牌：只存 sha256，明文只在签发那一刻交给新标签页。请求带着令牌来时按哈希找到这一行，
  再确认「管理员还是管理员、他签发时用的那个登录还在、目标还是启用着的普通用户、没到期、没结束」。
  所以管理员退出登录、改密码（会话全撤）、被停用，或者目标被停用 / 提成管理员，代入都立刻失效。

  parentSid / parentKind：签发时管理员所在的那个登录会话。代入是那次登录派生出来的能力，
  那次登录没了它也跟着没。

  不跟着备份 / 迁移走：最长一小时的临时凭据，换了机器没有意义。结束超过 30 天的行每天清一次。
*/
export const impersonationTables: TableDef[] = [
  {
    name: "user_impersonations",
    columns: [
      col("id", "id"),
      col("tokenHash", "varchar", { length: 64, notNull: true }),
      col("adminUserId", "int", { notNull: true }),
      col("targetUserId", "int", { notNull: true }),
      col("parentSid", "varchar", { length: 128, notNull: true }),
      col("parentKind", "varchar", { length: 16, notNull: true, default: "browser" }),
      col("ip", "varchar", { length: 64 }),
      col("userAgent", "varchar", { length: 256 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("expiresAt", "epoch", { notNull: true }),
      col("endedAt", "epoch"),
      col("endReason", "varchar", { length: 32 }),
    ],
    unique: [["tokenHash"]],
    indexes: [["adminUserId"], ["targetUserId"], ["expiresAt"]],
  },
];

export const impersonationMigrationTables: string[] = [];
