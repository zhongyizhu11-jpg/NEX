import assert from "node:assert/strict";
import test from "node:test";

import {
  UNGROUPED_PERSONAL_RULE_RANK,
  canChangePersonalRuleGroups,
  matchesPersonalRuleGroup,
  nextPersonalRuleGroupIds,
  personalRuleGroupIdsSchema,
  personalRuleGroupRank,
  personalRuleGroupSaveSchema,
} from "./ruleGroups";

test("分组筛选：不筛 / 未分组 / 某个组", () => {
  assert.equal(matchesPersonalRuleGroup([1, 2], null), true);
  assert.equal(matchesPersonalRuleGroup(undefined, undefined), true);
  assert.equal(matchesPersonalRuleGroup([], 0), true);
  assert.equal(matchesPersonalRuleGroup(undefined, 0), true);
  assert.equal(matchesPersonalRuleGroup([3], 0), false);
  // 在两个组里的规则，按哪个组筛都筛得出来
  assert.equal(matchesPersonalRuleGroup([1, 2], 2), true);
  assert.equal(matchesPersonalRuleGroup([1, 2], 3), false);
});

test("加入 / 移出 / 替换只动所选的组，不出重复", () => {
  assert.deepEqual(nextPersonalRuleGroupIds([1], [2, 2, 1], "add"), [1, 2]);
  assert.deepEqual(nextPersonalRuleGroupIds([1, 2, 3], [2], "remove"), [1, 3]);
  assert.deepEqual(nextPersonalRuleGroupIds([1, 2], [3, 3], "replace"), [3]);
  assert.deepEqual(nextPersonalRuleGroupIds([1, 2], [], "replace"), []);
});

test("批量调整分组只列出真的会被改到的规则（上游 2.3.290）", () => {
  // 加入：已经在全部所选组里的不列，只在其中一部分里的照样列（补齐）
  assert.equal(canChangePersonalRuleGroups([1, 2], "add", [1, 2]), false);
  assert.equal(canChangePersonalRuleGroups([1], "add", [1, 2]), true);
  assert.equal(canChangePersonalRuleGroups([], "add", [1]), true);
  // 移出：所选组一个都不在的不列
  assert.equal(canChangePersonalRuleGroups([3], "remove", [1, 2]), false);
  assert.equal(canChangePersonalRuleGroups([2, 3], "remove", [1, 2]), true);
  // 还没选目标分组：一条都不列
  assert.equal(canChangePersonalRuleGroups([1], "add", []), false);
  assert.equal(canChangePersonalRuleGroups([1], "remove", []), false);
});

test("按分组排序：跟着所在组里最靠前的那个组，未分组排最后", () => {
  const rank = new Map([[10, 0], [20, 1], [30, 2]]);
  assert.equal(personalRuleGroupRank([30, 20], rank), 1);
  assert.equal(personalRuleGroupRank([10], rank), 0);
  assert.equal(personalRuleGroupRank([], rank), UNGROUPED_PERSONAL_RULE_RANK);
  // 组已经删了（关系还没刷新过来）：当作未分组
  assert.equal(personalRuleGroupRank([99], rank), UNGROUPED_PERSONAL_RULE_RANK);
  const ordered = [[], [30], [20, 10], [20]].sort((a, b) => personalRuleGroupRank(a, rank) - personalRuleGroupRank(b, rank));
  assert.deepEqual(ordered, [[20, 10], [20], [30], []]);
});

test("入参校验：去重、上限、同一条规则不能同时加入和移出", () => {
  assert.deepEqual(personalRuleGroupIdsSchema.parse([1, 2, 1]), [1, 2]);
  for (const value of [[0], [-1], [1.5], Array.from({ length: 101 }, (_, index) => index + 1)]) {
    assert.equal(personalRuleGroupIdsSchema.safeParse(value).success, false);
  }
  assert.deepEqual(personalRuleGroupSaveSchema.parse({ name: "  游戏 ", addRuleIds: [1, 1] }), { name: "游戏", addRuleIds: [1], removeRuleIds: [] });
  assert.equal(personalRuleGroupSaveSchema.safeParse({ name: "   " }).success, false);
  assert.equal(personalRuleGroupSaveSchema.safeParse({ name: "x".repeat(65) }).success, false);
  assert.equal(personalRuleGroupSaveSchema.safeParse({ name: "a", addRuleIds: [1], removeRuleIds: [1] }).success, false);
  const many = Array.from({ length: 300 }, (_, index) => index + 1);
  assert.equal(personalRuleGroupSaveSchema.safeParse({ name: "a", addRuleIds: many, removeRuleIds: many.map((id) => id + 1000) }).success, false);
});
