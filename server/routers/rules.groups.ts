import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  MAX_PERSONAL_RULE_GROUPS,
  MAX_PERSONAL_RULE_GROUP_CHANGE,
  PERSONAL_RULE_GROUP_MOVE_MODES,
  personalRuleGroupIdsSchema,
  personalRuleGroupSaveSchema,
} from "../../shared/ruleGroups";
import {
  deletePersonalRuleGroup,
  getPersonalRuleGroupOverview,
  moveRulesToPersonalGroups,
  reorderPersonalRuleGroups,
  savePersonalRuleGroup,
} from "../ruleGroups";

/*
  转发规则个人分组的接口（rules.personalGroups / savePersonalGroup / …，并进 rulesRouter）。

  组的主人永远是 ctx.user —— 这里没有任何一个入参能指定「替谁操作」，管理员也不行。
  personalGroups 的 scope / userId 只决定「数哪些规则」（和规则列表的用户筛选同一个意思），
  普通用户传什么都只数自己的；返回的组仍然只是当前登录的人自己的。
*/
export const personalRuleGroupsRouter = router({
  personalGroups: protectedProcedure
    .input(z.object({
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
    }).optional())
    .query(({ ctx, input }) => {
      const isAdmin = ctx.user.role === "admin";
      const ownerUserId = isAdmin
        ? input?.scope === "all" ? undefined : input?.userId ?? ctx.user.id
        : ctx.user.id;
      return getPersonalRuleGroupOverview(ctx.user.id, { ownerUserId, category: "all", page: 1, pageSize: 1 });
    }),
  savePersonalGroup: protectedProcedure
    .input(personalRuleGroupSaveSchema)
    .mutation(({ ctx, input }) => savePersonalRuleGroup(ctx.user, input)),
  deletePersonalGroup: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => deletePersonalRuleGroup(ctx.user, input.id)),
  reorderPersonalGroups: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).max(MAX_PERSONAL_RULE_GROUPS) }))
    .mutation(({ ctx, input }) => reorderPersonalRuleGroups(ctx.user, input.ids)),
  moveToPersonalGroups: protectedProcedure
    .input(z.object({
      ids: z.array(z.number().int().positive()).min(1).max(MAX_PERSONAL_RULE_GROUP_CHANGE),
      groupIds: personalRuleGroupIdsSchema,
      mode: z.enum(PERSONAL_RULE_GROUP_MOVE_MODES),
    }))
    .mutation(({ ctx, input }) => moveRulesToPersonalGroups(ctx.user, input.ids, input.groupIds, input.mode)),
});
