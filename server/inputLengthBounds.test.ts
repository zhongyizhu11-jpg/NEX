import assert from "node:assert/strict";
import test from "node:test";
import { usersRouter } from "./routers/users";
import { billingRouter } from "./routers/billing";
import { tunnelsRouter } from "./routers/tunnels";
import { rulesRouter } from "./routers/rules";
import { forwardGroupsRouter } from "./routers/forwardGroups";
import { plansRouter } from "./routers/plans";
import { agentTokensRouter } from "./routers/agentTokens";
import { proxySubscriptionsRouter } from "./routers/proxySubscriptions";

/**
 * 字符串、数组入参的长度上限（P2-10）：上限都远高于正常用法，只挡离谱的输入。
 * 校验在处理函数之前发生，不用建库。
 */
const admin = { user: { id: 1, role: "admin", username: "admin" }, req: { headers: {} }, res: { setHeader: () => {} } } as any;

/** 要因为「超长」被挡（too_big），而不是因为别的字段没填。 */
async function rejectsInput(run: () => Promise<unknown>, label: string, issue = "too_big") {
  await assert.rejects(run, (error: any) => error?.code === "BAD_REQUEST" && String(error?.message || "").includes(issue), label);
}

const many = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

test("字符串和数组入参有上限", async () => {
  await rejectsInput(() => usersRouter.createCaller(admin).setHostPermissions({ userId: 2, hostIds: many(50_001) }), "主机权限列表过长");
  await rejectsInput(() => usersRouter.createCaller(admin).create({ username: "u", password: "x".repeat(1025) } as any), "密码过长");
  await rejectsInput(() => usersRouter.createCaller(admin).updateTrafficSettings({ userId: 2, allowedForwardTypes: "x".repeat(2049) }), "转发方式列表过长");
  await rejectsInput(() => rulesRouter.createCaller(admin).reorder({ category: "local", ids: many(50_001) }), "规则排序 id 过多");
  await rejectsInput(() => forwardGroupsRouter.createCaller(admin).reorder({ groupId: 1, memberIds: many(1001) }), "成员排序过长");
  await rejectsInput(() => plansRouter.createCaller(admin).create({ name: "p", hostIds: many(50_001) } as any), "套餐主机过多");
  await rejectsInput(() => agentTokensRouter.createCaller(admin).create({ description: "x".repeat(501) }), "令牌备注过长");
  await rejectsInput(() => billingRouter.createCaller(admin).createDiscountCode({ discountType: "amount", discountValue: 1, planIds: many(1001) }), "折扣码套餐过多");
  await rejectsInput(() => billingRouter.createCaller(admin).createRedemptionCodes({ type: "balance", amountCents: 1, startsAt: "x".repeat(65) }), "日期串过长");
  await rejectsInput(() => billingRouter.createCaller(admin).listRedemptionCodes({ limit: 0 }), "分页 limit 为 0", "too_small");

  const subs = proxySubscriptionsRouter.createCaller(admin);
  await rejectsInput(() => subs.updateToken({ id: 1, options: { customRules: "x".repeat(70 * 1024) } }), "外观选项过大", "内容太长");
  await rejectsInput(() => subs.updateToken({ id: 1, scope: "not-an-object" as any }), "作用域不是对象", "invalid_type");
  await rejectsInput(() => subs.updateToken({ id: 1, scope: [1, 2] as any }), "作用域是数组", "invalid_type");
});

test("隧道排序 id 有上限", async () => {
  await rejectsInput(() => tunnelsRouter.createCaller(admin).reorder({ ids: many(50_001) }), "隧道排序 id 过多");
  await rejectsInput(() => forwardGroupsRouter.createCaller(admin).reorderGroups({ ids: many(50_001) } as any), "转发组排序 id 过多");
});
