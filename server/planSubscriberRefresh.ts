/*
  套餐改了之后把变化推到每个订户（刷新他的转发端点 / 运行时）。

  原来在管理员保存套餐的那个请求里逐个订户串行刷：一个订户要读规则、算运行时、推 Agent，几百个订户
  就是几十秒，请求一直挂着，前端等到超时。现在：
    - 订户不多于 PLAN_SUBSCRIBER_REFRESH_INLINE_THRESHOLD（3）个时仍在请求里刷完 —— 小面板保存完立刻生效，
      行为和原来一样；
    - 多于 3 个时放到后台，PLAN_SUBSCRIBER_REFRESH_CONCURRENCY（3）路并发，请求立刻返回「排了多少个」，
      进度和失败写面板日志；同一个套餐连续保存两次时第二批排在第一批后面（createKeyedSerial），
      不会叠成 6 路。
  单个订户刷失败只记日志，不影响别的订户。
*/

import { mapWithConcurrency } from "./asyncPool";
import { createKeyedSerial } from "./keyedSerial";

export const PLAN_SUBSCRIBER_REFRESH_INLINE_THRESHOLD = 3;
export const PLAN_SUBSCRIBER_REFRESH_CONCURRENCY = 3;

export type PlanSubscriberRefreshMode = "inline" | "background";

export type PlanSubscriberRefreshResult = {
  mode: PlanSubscriberRefreshMode;
  /** 要刷的订户数（inline 时已经刷完，background 时是排进后台的个数）。 */
  queued: number;
  /** inline 时失败的个数（后台的失败只进日志）。 */
  failed: number;
  /** 测试 / 调用方要等后台跑完时用；inline 时已经是 resolved。 */
  done: Promise<void>;
};

export type PlanSubscriberRefreshDeps = {
  refresh: (userId: number, reason: string) => Promise<void>;
  log: (level: "info" | "warn", message: string) => void;
  inlineThreshold?: number;
  concurrency?: number;
};

const perPlan = createKeyedSerial<number>();

async function refreshEach(planId: number, userIds: readonly number[], reason: string, deps: PlanSubscriberRefreshDeps, concurrency: number) {
  let failed = 0;
  await mapWithConcurrency(userIds, concurrency, async (userId) => {
    try {
      await deps.refresh(userId, reason);
    } catch (error) {
      failed += 1;
      deps.log("warn", `[Plan] subscriber refresh failed plan=${planId} user=${userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return failed;
}

export function refreshPlanSubscribers(planId: number, userIds: readonly number[], reason: string, deps: PlanSubscriberRefreshDeps): Promise<PlanSubscriberRefreshResult> {
  const ids = Array.from(new Set(userIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const threshold = deps.inlineThreshold ?? PLAN_SUBSCRIBER_REFRESH_INLINE_THRESHOLD;
  const concurrency = deps.concurrency ?? PLAN_SUBSCRIBER_REFRESH_CONCURRENCY;
  if (ids.length <= threshold) {
    return refreshEach(planId, ids, reason, deps, concurrency).then((failed) => ({ mode: "inline", queued: ids.length, failed, done: Promise.resolve() }));
  }
  const done = perPlan(planId, async () => {
    const startedAt = Date.now();
    const failed = await refreshEach(planId, ids, reason, deps, concurrency);
    deps.log(failed > 0 ? "warn" : "info", `[Plan] subscriber refresh done plan=${planId} users=${ids.length} failed=${failed} elapsedMs=${Date.now() - startedAt}`);
  }).catch((error) => {
    deps.log("warn", `[Plan] subscriber refresh aborted plan=${planId}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return Promise.resolve({ mode: "background", queued: ids.length, failed: 0, done });
}
