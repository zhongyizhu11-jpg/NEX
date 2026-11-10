import { col, type TableDef } from "./tableDefs";

/*
  转发规则的个人分组（上游 2.3.287，shared/ruleGroups.ts；读写在 server/ruleGroups.ts）。

  rule_groups：一个账号自己的组。名字在同一个账号里不重复（唯一索引兜底），sortOrder 是「管理分组」里
    拖出来的顺序。
  rule_group_members：哪条规则在哪个组里，多对多。userId 是「组的主人」，不是规则的主人 —— 管理员可以
    把别人的规则放进自己的组，这一行记的是管理员。带着它是为了按「谁在看」直接查，不用每次都连到
    rule_groups 上去认主人。

  表名、列名和上游一样：上游导出的备份里这两张表能直接导进来。
  两张表里都没有外键：规则 / 主机 / 用户删掉时由 server/ruleGroupRelations.ts 在同一个事务里先清关系。
*/
export const ruleGroupsTables: TableDef[] = [
  {
    name: "rule_groups",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("name", "varchar", { length: 64, notNull: true }),
      col("sortOrder", "int", { notNull: true, default: 0 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["userId", "name"]],
    indexes: [["userId", "sortOrder"]],
  },
  {
    name: "rule_group_members",
    columns: [
      col("id", "id"),
      col("userId", "int", { notNull: true }),
      col("ruleId", "int", { notNull: true }),
      col("groupId", "int", { notNull: true }),
    ],
    unique: [["userId", "ruleId", "groupId"]],
    // groupId 开头的那条给「这个组里有哪些规则」；ruleId 那条给删规则时清关系。
    indexes: [["userId", "groupId", "ruleId"], ["ruleId"]],
  },
];

/** 分组是用户自己整理出来的配置：备份 / 换面板要带走。先组后成员（成员指向组）。 */
export const ruleGroupsMigrationTables: string[] = ["rule_groups", "rule_group_members"];
