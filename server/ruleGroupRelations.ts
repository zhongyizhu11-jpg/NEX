import { executeRaw, getDatabaseKind, queryRaw, quoteDbIdentifier, withDatabaseTransaction } from "./dbRuntime";

/*
  个人分组的「关系」这一头（rule_group_members）跟着规则、主机、用户一起清。

  单独一个不依赖任何仓库的文件：删规则（forwardRuleRepository）、删主机（hostRepository）、删用户
  （userRepository）都要调它，而分组本身的读写（server/ruleGroups.ts）又要用规则仓库 —— 放在一起就成了环。

  为什么要在删除的同一个事务里先清：
    · 两张表没有外键，规则行删掉以后关系还留着，就是一行指向不存在的规则的数据。界面上看不见它，
      但备份 / 迁移导入时「成员指向的规则找不到」会被记成关键数据没导进来。
    · 分开两步的话，中间断一下（进程重启、第二条语句失败）就留下半截。

  为什么要先锁规则行（MySQL / PostgreSQL）：归组那边（server/ruleGroups.ts 的 moveRulesToPersonalGroups）
  是「先看规则还在不在，再写关系」。不锁的话可以这样错开：归组看到规则还在 → 这边清完关系、删掉规则 →
  归组把关系写进去，留下一行孤儿。两边都先 SELECT … FOR UPDATE 同一行规则，就只能一前一后：
  归组先，这边等它提交后把它刚写的那行一起清掉；这边先，归组等到的是「规则已经没了」。
  SQLite 的事务是 BEGIN IMMEDIATE，同一时刻只有一个写事务，本来就是一前一后。
*/

const q = quoteDbIdentifier;
export const RULE_GROUPS_TABLE = "rule_groups";
export const RULE_GROUP_MEMBERS_TABLE = "rule_group_members";

/** 行锁的后缀：SQLite 不认 FOR UPDATE，也用不着（见文件头）。 */
export function rowLockSuffix() {
  return getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
}

/**
 * 删一条规则前调：锁住规则行，清掉它在所有人的组里的关系。
 * 自己开事务（已经在事务里就并进去），调用方把「删规则行」放在同一个 withDatabaseTransaction 里。
 */
export async function clearRuleGroupMembersForRule(ruleId: number) {
  const id = Math.floor(Number(ruleId));
  if (!(id > 0)) return;
  await withDatabaseTransaction(async () => {
    await queryRaw(`SELECT ${q("id")} FROM ${q("forward_rules")} WHERE ${q("id")} = ?${rowLockSuffix()}`, [id]);
    await executeRaw(`DELETE FROM ${q(RULE_GROUP_MEMBERS_TABLE)} WHERE ${q("ruleId")} = ?`, [id]);
  });
}

/** 删主机前调：这台机器上的规则会整批删行，先把它们的分组关系一起清掉。 */
export async function clearRuleGroupMembersForHost(hostId: number) {
  const id = Math.floor(Number(hostId));
  if (!(id > 0)) return;
  await withDatabaseTransaction(async () => {
    await queryRaw(`SELECT ${q("id")} FROM ${q("forward_rules")} WHERE ${q("hostId")} = ?${rowLockSuffix()}`, [id]);
    await executeRaw(
      `DELETE FROM ${q(RULE_GROUP_MEMBERS_TABLE)} WHERE ${q("ruleId")} IN (SELECT ${q("id")} FROM ${q("forward_rules")} WHERE ${q("hostId")} = ?)`,
      [id],
    );
  });
}

/** 删用户时调：他自己建的组和组里的关系一起删（他的规则在别人组里的关系，跟着规则删除走）。 */
export async function clearPersonalRuleGroupsForUser(userId: number) {
  const id = Math.floor(Number(userId));
  if (!(id > 0)) return;
  await withDatabaseTransaction(async () => {
    await executeRaw(`DELETE FROM ${q(RULE_GROUP_MEMBERS_TABLE)} WHERE ${q("userId")} = ?`, [id]);
    await executeRaw(`DELETE FROM ${q(RULE_GROUPS_TABLE)} WHERE ${q("userId")} = ?`, [id]);
  });
}
