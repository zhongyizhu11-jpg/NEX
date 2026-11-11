import { TRPCError } from "@trpc/server";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, withDatabaseTransaction } from "./dbRuntime";
import { inList } from "./dbCompat";
import { RULE_GROUPS_TABLE, RULE_GROUP_MEMBERS_TABLE, rowLockSuffix } from "./ruleGroupRelations";
import {
  getForwardRulePersonalGroupCounts,
  lockGroupableForwardRuleIds,
  type ForwardRuleListQuery,
} from "./repositories/forwardRuleRepository";
import {
  MAX_PERSONAL_RULE_GROUPS,
  nextPersonalRuleGroupIds,
  type PersonalRuleGroup,
  type PersonalRuleGroupMoveMode,
} from "../shared/ruleGroups";

/*
  转发规则个人分组的读写（上游 2.3.287 / 2.3.290；表在 server/ops/ruleGroupsTables.ts，
  跟着规则 / 主机 / 用户删除清关系在 server/ruleGroupRelations.ts）。

  几条规矩：

  · 组是「谁登录谁的」。这里每个函数的第一个参数都是当前登录的人，由路由从会话里取，
    从不收客户端传来的主人 id —— 管理员也一样，看「所有用户」时看到、能改的仍然只是自己的组。
  · 谁能把哪条规则放进组里：自己的规则放自己的组；管理员能看到所有人的规则，所以能把任何一条放进
    **自己的**组（关系行记的是管理员，规则的主人看不到也不受影响）。别人的组谁都碰不到。
  · 只认「列表里看得见的规则」（没在等删除、不是转发组 / 线路组展开出来的子规则），和列表筛选同一份条件。
  · 所有写入都在 withPersonalRuleGroupLock 里，并且**在锁里现读**当前的组和关系再算要写什么。
    不这样的话，两个请求各拿一份旧快照就会互相盖：一边刚删了组，另一边按删之前读到的关系
    「先删后插」，把指向已删分组的关系又插了回去（创建 / 导入后归组、批量归组都是这条路）。
*/

const q = quoteDbIdentifier;

/** 当前登录的人：只用到 id 和是不是管理员。 */
export type RuleGroupActor = { id: number; role?: string | null };

type GroupRow = { id: number; name: string; sortOrder: number };

/** 多行 INSERT 一次带多少行：三个参数一行，SQLite 老版本一条语句最多 999 个参数。 */
const MEMBER_INSERT_BATCH = 200;
const ID_QUERY_BATCH = 400;

function positiveIds(values: readonly unknown[]) {
  return [...new Set(values.map((value) => Math.floor(Number(value))).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

/**
 * 同一个账号的分组写入排成一队。
 *
 * 用数据库的锁（锁住这个账号在 users 里的那一行），不用进程里的 JS 锁：面板可以起好几个实例连同一个库，
 * JS 锁各管各的；而且写入本来就要在事务里，锁跟着事务提交 / 回滚一起放，不会漏放。
 * SQLite 的事务是 BEGIN IMMEDIATE，同一时刻只有一个写事务，不需要（也不认）FOR UPDATE。
 */
export function withPersonalRuleGroupLock<T>(userId: number, work: () => Promise<T>): Promise<T> {
  return withDatabaseTransaction(async () => {
    const rows = await queryRaw(`SELECT ${q("id")} FROM ${q("users")} WHERE ${q("id")} = ?${rowLockSuffix()}`, [userId]);
    if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
    return work();
  });
}

async function readGroups(userId: number): Promise<GroupRow[]> {
  const rows = await queryRaw<GroupRow>(
    `SELECT ${q("id")}, ${q("name")}, ${q("sortOrder")} FROM ${q(RULE_GROUPS_TABLE)} WHERE ${q("userId")} = ? ORDER BY ${q("sortOrder")} ASC, ${q("id")} ASC`,
    [userId],
  );
  return rows.map((row) => ({ id: Number(row.id), name: String(row.name || ""), sortOrder: Number(row.sortOrder || 0) }));
}

/** 这些组是不是都还在、都是这个人的。要在锁里调，读到的才是「此刻」的。 */
async function assertOwnGroups(userId: number, groupIds: readonly number[]) {
  const ids = positiveIds(groupIds);
  if (ids.length === 0) return;
  const list = inList(ids);
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} FROM ${q(RULE_GROUPS_TABLE)} WHERE ${q("userId")} = ? AND ${q("id")} IN ${list.sql}`,
    [userId, ...list.params],
  );
  if (rows.length !== ids.length) throw new TRPCError({ code: "NOT_FOUND", message: "分组不存在或已被删除，请刷新后重试" });
}

/**
 * 每条规则在 userId 的哪几个组里（按组的顺序）。给列表上的分组标签用：连上 rule_groups 认主人，
 * 组行不在了的关系不算。
 */
export async function getRulePersonalGroupIds(userId: number, ruleIds: readonly number[]): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  const ids = positiveIds(ruleIds);
  for (let index = 0; index < ids.length; index += ID_QUERY_BATCH) {
    const list = inList(ids.slice(index, index + ID_QUERY_BATCH));
    const rows = await queryRaw<{ ruleId: number; groupId: number }>(
      `SELECT pm.${q("ruleId")} AS ${q("ruleId")}, pm.${q("groupId")} AS ${q("groupId")}`
        + ` FROM ${q(RULE_GROUP_MEMBERS_TABLE)} pm`
        + ` INNER JOIN ${q(RULE_GROUPS_TABLE)} pg ON pg.${q("id")} = pm.${q("groupId")} AND pg.${q("userId")} = pm.${q("userId")}`
        + ` WHERE pm.${q("userId")} = ? AND pm.${q("ruleId")} IN ${list.sql}`
        + ` ORDER BY pg.${q("sortOrder")} ASC, pg.${q("id")} ASC`,
      [userId, ...list.params],
    );
    for (const row of rows) {
      const ruleId = Number(row.ruleId);
      const groups = result.get(ruleId);
      if (groups) groups.push(Number(row.groupId));
      else result.set(ruleId, [Number(row.groupId)]);
    }
  }
  return result;
}

/** 写入前现读的关系：只看关系表本身（组行不在了的也算，否则再插一次会撞唯一索引）。 */
async function readMemberships(userId: number, ruleIds: readonly number[]) {
  const result = new Map<number, number[]>();
  for (let index = 0; index < ruleIds.length; index += ID_QUERY_BATCH) {
    const list = inList(ruleIds.slice(index, index + ID_QUERY_BATCH));
    const rows = await queryRaw<{ ruleId: number; groupId: number }>(
      `SELECT ${q("ruleId")}, ${q("groupId")} FROM ${q(RULE_GROUP_MEMBERS_TABLE)} WHERE ${q("userId")} = ? AND ${q("ruleId")} IN ${list.sql}`,
      [userId, ...list.params],
    );
    for (const row of rows) {
      const ruleId = Number(row.ruleId);
      const groups = result.get(ruleId);
      if (groups) groups.push(Number(row.groupId));
      else result.set(ruleId, [Number(row.groupId)]);
    }
  }
  return result;
}

/**
 * 分组栏要的那一份：这个人的组（按顺序，带每组的规则数），加上范围里一共多少条规则、多少条未分组。
 * scope 是规则列表的「谁的规则」那一档（见 getForwardRulePersonalGroupCounts）。
 */
export async function getPersonalRuleGroupOverview(
  userId: number,
  scope: ForwardRuleListQuery,
): Promise<{ groups: PersonalRuleGroup[]; total: number; ungrouped: number }> {
  const [groups, counts] = await Promise.all([
    readGroups(userId),
    getForwardRulePersonalGroupCounts(scope, userId),
  ]);
  return {
    groups: groups.map((group) => ({ ...group, count: counts.byGroup.get(group.id) || 0 })),
    total: counts.total,
    ungrouped: counts.ungrouped,
  };
}

/**
 * 把 ruleIds 这些规则按 mode 归到 groupIds 这些组里。**只在锁和事务里调**（调用方已经核对过组是自己的）。
 *
 *   加入 / 替换：规则得是这个人此刻看得见、能整理的（见文件头），有一条不是就整批拒绝，不做一半。
 *   移出：只删自己名下的关系，不要求规则还看得见 —— 管理员降成普通用户以后，
 *         以前放进组里的别人的规则也得能清出去。
 *
 * 只动差出来的那几行（该删的删、该插的插），不整批先删后插：关系是在锁里现读的，差量就是对的。
 */
async function applyMembershipChange(
  actor: RuleGroupActor,
  ruleIds: readonly number[],
  groupIds: readonly number[],
  mode: PersonalRuleGroupMoveMode,
) {
  const ids = positiveIds(ruleIds);
  const targets = positiveIds(groupIds);
  if (ids.length === 0) return 0;
  if (mode !== "remove") {
    const groupable = await lockGroupableForwardRuleIds(ids, actor.role === "admin" ? undefined : actor.id);
    if (groupable.length !== ids.length) {
      throw new TRPCError({ code: "FORBIDDEN", message: "只能整理自己能看到的规则，且规则必须仍然存在" });
    }
  }
  const current = await readMemberships(actor.id, ids);
  const inserts: Array<[number, number]> = [];
  const removals = new Map<number, number[]>();
  for (const ruleId of ids) {
    const before = current.get(ruleId) || [];
    const beforeSet = new Set(before);
    const next = new Set(nextPersonalRuleGroupIds(before, targets, mode));
    for (const groupId of next) if (!beforeSet.has(groupId)) inserts.push([ruleId, groupId]);
    for (const groupId of beforeSet) {
      if (next.has(groupId)) continue;
      const rules = removals.get(groupId);
      if (rules) rules.push(ruleId);
      else removals.set(groupId, [ruleId]);
    }
  }
  for (const [groupId, rules] of removals) {
    for (let index = 0; index < rules.length; index += ID_QUERY_BATCH) {
      const list = inList(rules.slice(index, index + ID_QUERY_BATCH));
      await executeRaw(
        `DELETE FROM ${q(RULE_GROUP_MEMBERS_TABLE)} WHERE ${q("userId")} = ? AND ${q("groupId")} = ? AND ${q("ruleId")} IN ${list.sql}`,
        [actor.id, groupId, ...list.params],
      );
    }
  }
  for (let index = 0; index < inserts.length; index += MEMBER_INSERT_BATCH) {
    const batch = inserts.slice(index, index + MEMBER_INSERT_BATCH);
    await executeRaw(
      `INSERT INTO ${q(RULE_GROUP_MEMBERS_TABLE)} (${q("userId")}, ${q("ruleId")}, ${q("groupId")}) VALUES ${batch.map(() => "(?, ?, ?)").join(", ")}`,
      batch.flatMap(([ruleId, groupId]) => [actor.id, ruleId, groupId]),
    );
  }
  return ids.length;
}

/**
 * 建组（不给 id）或改组（给 id）：名字和这次勾选 / 取消勾选的规则一起生效，要么都成要么都不成。
 * addRuleIds / removeRuleIds 只是这次动过的规则（管理弹窗分页勾的），不是整组的成员表。
 */
export async function savePersonalRuleGroup(
  actor: RuleGroupActor,
  input: { id?: number; name: string; addRuleIds?: readonly number[]; removeRuleIds?: readonly number[] },
) {
  const name = String(input.name || "").trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "分组名不能为空" });
  return withPersonalRuleGroupLock(actor.id, async () => {
    const groups = await readGroups(actor.id);
    let id = input.id ? Math.floor(Number(input.id)) : 0;
    if (id && !groups.some((group) => group.id === id)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "分组不存在或已被删除，请刷新后重试" });
    }
    // 不分大小写比：「Game」和「game」并排两个组只会让人选错。库里的唯一索引是最后一道。
    const lowered = name.toLocaleLowerCase();
    if (groups.some((group) => group.id !== id && group.name.toLocaleLowerCase() === lowered)) {
      throw new TRPCError({ code: "CONFLICT", message: "分组名称已存在" });
    }
    if (id) {
      await executeRaw(
        `UPDATE ${q(RULE_GROUPS_TABLE)} SET ${q("name")} = ? WHERE ${q("id")} = ? AND ${q("userId")} = ?`,
        [name, id, actor.id],
      );
    } else {
      if (groups.length >= MAX_PERSONAL_RULE_GROUPS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `最多创建 ${MAX_PERSONAL_RULE_GROUPS} 个分组` });
      }
      // 新组排在最后。
      const sortOrder = groups.reduce((max, group) => Math.max(max, group.sortOrder), -1) + 1;
      id = await insertAndGetId(RULE_GROUPS_TABLE, { userId: actor.id, name, sortOrder });
    }
    if (input.addRuleIds?.length) await applyMembershipChange(actor, input.addRuleIds, [id], "add");
    if (input.removeRuleIds?.length) await applyMembershipChange(actor, input.removeRuleIds, [id], "remove");
    return { id };
  });
}

/** 删组：只删这个组和它的关系。规则本身、规则在别的组里的关系都不动，也不会重启、停用任何转发。 */
export async function deletePersonalRuleGroup(actor: RuleGroupActor, id: number) {
  return withPersonalRuleGroupLock(actor.id, async () => {
    await assertOwnGroups(actor.id, [id]);
    await executeRaw(`DELETE FROM ${q(RULE_GROUP_MEMBERS_TABLE)} WHERE ${q("userId")} = ? AND ${q("groupId")} = ?`, [actor.id, id]);
    await executeRaw(`DELETE FROM ${q(RULE_GROUPS_TABLE)} WHERE ${q("userId")} = ? AND ${q("id")} = ?`, [actor.id, id]);
    return { success: true as const };
  });
}

/** 拖动排序：ids 必须正好是这个人此刻全部的组（多了少了都说明列表旧了，让他刷新，不猜）。 */
export async function reorderPersonalRuleGroups(actor: RuleGroupActor, ids: readonly number[]) {
  return withPersonalRuleGroupLock(actor.id, async () => {
    const groups = await readGroups(actor.id);
    const ordered = positiveIds(ids);
    const known = new Set(groups.map((group) => group.id));
    if (ordered.length !== ids.length || ordered.length !== groups.length || ordered.some((id) => !known.has(id))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "分组列表已变化，请刷新后重试" });
    }
    for (const [sortOrder, id] of ordered.entries()) {
      await executeRaw(
        `UPDATE ${q(RULE_GROUPS_TABLE)} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ? AND ${q("userId")} = ?`,
        [sortOrder, id, actor.id],
      );
    }
    return { success: true as const };
  });
}

/**
 * 批量归组：加入（add）、移出（remove）、替换（replace，groupIds 给空就是清空归属）。
 * 加入 / 移出不选分组没有意义，直接拒绝，不当成「什么都不做也算成功」。
 */
export async function moveRulesToPersonalGroups(
  actor: RuleGroupActor,
  ruleIds: readonly number[],
  groupIds: readonly number[],
  mode: PersonalRuleGroupMoveMode,
) {
  const targets = positiveIds(groupIds);
  if (mode !== "replace" && targets.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "请先选择分组" });
  }
  return withPersonalRuleGroupLock(actor.id, async () => {
    await assertOwnGroups(actor.id, targets);
    const count = await applyMembershipChange(actor, ruleIds, targets, mode);
    return { success: true as const, count };
  });
}
