import { z } from "zod";

/*
  转发规则的「个人分组」（上游 2.3.287 / 2.3.290）。

  分组是每个账号自己的整理方式：一条规则可以同时在好几个组里，组有名字和顺序，删组不删规则。
  它和链路管理里的「转发组」「线路组」不是一回事 —— 不改授权、不改计费、不改转发，只是列表上的标签。

  这里只放两边都要用的东西：接口入参的形状、上限，以及几个「规则在不在这个组里」的纯函数
  （列表筛选、批量管理里「哪些规则还能加 / 能移」、按分组排序时未分组排最后）。
*/

/** 一个账号最多建多少个组。 */
export const MAX_PERSONAL_RULE_GROUPS = 100;
/** 分组名最长多少个字符（和库里的列一样长）。 */
export const PERSONAL_RULE_GROUP_NAME_MAX = 64;
/** 一次归组最多动多少条规则。 */
export const MAX_PERSONAL_RULE_GROUP_CHANGE = 500;

export const ruleGroupNameSchema = z.string().trim()
  .min(1, "分组名不能为空")
  .max(PERSONAL_RULE_GROUP_NAME_MAX, `分组名最多 ${PERSONAL_RULE_GROUP_NAME_MAX} 个字符`);

const ruleMembershipIdsSchema = z.array(z.number().int().positive())
  .max(MAX_PERSONAL_RULE_GROUP_CHANGE)
  .default([])
  .transform((ids) => [...new Set(ids)]);

/**
 * 建组 / 改组。addRuleIds、removeRuleIds 只带「这次动过的」规则，不是整组的成员表：
 * 管理弹窗里的规则是分页勾的，拿整表覆盖会把别的页上的成员冲掉。
 */
export const personalRuleGroupSaveSchema = z.object({
  id: z.number().int().positive().optional(),
  name: ruleGroupNameSchema,
  addRuleIds: ruleMembershipIdsSchema,
  removeRuleIds: ruleMembershipIdsSchema,
})
  .refine((input) => input.addRuleIds.length + input.removeRuleIds.length <= MAX_PERSONAL_RULE_GROUP_CHANGE, `每次最多调整 ${MAX_PERSONAL_RULE_GROUP_CHANGE} 条规则`)
  .refine((input) => !input.addRuleIds.some((id) => input.removeRuleIds.includes(id)), "同一条规则不能同时加入和移出分组");

export const personalRuleGroupIdsSchema = z.array(z.number().int().positive())
  .max(MAX_PERSONAL_RULE_GROUPS)
  .transform((ids) => [...new Set(ids)]);

/** 列表按分组筛：不传 / null = 不筛，0 = 未分组，正数 = 那个组。 */
export const ruleGroupFilterSchema = z.number().int().min(0).nullable().optional();

export const PERSONAL_RULE_GROUP_MOVE_MODES = ["add", "remove", "replace"] as const;
export type PersonalRuleGroupMoveMode = (typeof PERSONAL_RULE_GROUP_MOVE_MODES)[number];

export type PersonalRuleGroup = { id: number; name: string; sortOrder: number; count: number };

/** 这条规则过不过得了分组筛选（filter 的含义同 ruleGroupFilterSchema）。 */
export function matchesPersonalRuleGroup(groupIds: readonly number[] | null | undefined, filter: number | null | undefined): boolean {
  if (filter === null || filter === undefined) return true;
  if (filter === 0) return !groupIds?.length;
  return !!groupIds?.includes(filter);
}

/** 归组之后这条规则在哪几个组里。before 是它现在的组，target 是这次选的组。 */
export function nextPersonalRuleGroupIds(
  before: readonly number[],
  target: readonly number[],
  mode: PersonalRuleGroupMoveMode,
): number[] {
  if (mode === "replace") return [...new Set(target)];
  if (mode === "add") return [...new Set([...before, ...target])];
  const removed = new Set(target);
  return before.filter((id) => !removed.has(id));
}

/**
 * 批量「加入 / 移出分组」时，这条规则还有没有得改（上游 2.3.290）：
 *   加入：已经在所选的每一个组里了 —— 没得加，不列出来；只在其中几个组里的照样列，可以补齐；
 *   移出：所选的组一个都不在 —— 没得移，不列出来。
 * 还没选目标分组时一条都不列，免得先勾了规则、再选组时勾着的其实是没得改的。
 */
export function canChangePersonalRuleGroups(
  groupIds: readonly number[] | null | undefined,
  mode: "add" | "remove",
  targetGroupIds: readonly number[],
): boolean {
  if (targetGroupIds.length === 0) return false;
  const current = new Set(groupIds || []);
  return mode === "add"
    ? targetGroupIds.some((id) => !current.has(id))
    : targetGroupIds.some((id) => current.has(id));
}

/** 未分组的规则按分组排序时的名次：比任何一个组都靠后。 */
export const UNGROUPED_PERSONAL_RULE_RANK = Number.MAX_SAFE_INTEGER;

/**
 * 按分组排序时这条规则的名次：它所在的组里排得最靠前的那个组的顺序；一个组都不在就排最后。
 * rankByGroupId 是「组 id → 顺序」（管理分组里拖出来的那个顺序）。
 */
export function personalRuleGroupRank(
  groupIds: readonly number[] | null | undefined,
  rankByGroupId: ReadonlyMap<number, number>,
): number {
  let rank = UNGROUPED_PERSONAL_RULE_RANK;
  for (const id of groupIds || []) {
    const value = rankByGroupId.get(Number(id));
    if (value !== undefined && value < rank) rank = value;
  }
  return rank;
}
