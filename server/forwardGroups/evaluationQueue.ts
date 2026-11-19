/*
  转发组的评估队列和到点重评（以前在 evaluateDriver.ts 里）：健康上报、主机上下线、入口组的状态写回这些地方只要
  「把这几个组排进去评估」，不用把整个评估驱动引进来 —— 以前 ddnsEntryGroup / health 为了这一个函数引 evaluateDriver，
  evaluateDriver 又引它们，绕成一个圈。

  真正跑评估的函数由 evaluateDriver.ts 加载时交进来（setForwardGroupEvaluationRunner）：没交之前排进来的先攒着，
  交了就开始跑。
*/

import { ForwardGroupEvaluationQueue, ForwardGroupHealthRecheckScheduler } from "../forwardGroupHealthRecheck";

export const FORWARD_GROUP_EVALUATION_DEBOUNCE_MS = 250;
export const FORWARD_GROUP_EVALUATION_RETRY_BASE_MS = 1_000;
export const FORWARD_GROUP_EVALUATION_RETRY_MAX_MS = 30_000;

type EvaluationRunner = (groupIds: number[]) => Promise<void>;
let runner: EvaluationRunner | null = null;
let waitingForRunner: Array<() => void> = [];

/** evaluateDriver.ts 加载时调：排队的评估「只算结论」那一轮由它跑。 */
export function setForwardGroupEvaluationRunner(next: EvaluationRunner) {
  runner = next;
  const waiting = waitingForRunner;
  waitingForRunner = [];
  for (const resolve of waiting) resolve();
}

async function runQueuedEvaluation(groupIds: number[]) {
  if (!runner) await new Promise<void>((resolve) => { waitingForRunner.push(resolve); });
  await runner!(groupIds);
}

const forwardGroupEvaluationQueue = new ForwardGroupEvaluationQueue(runQueuedEvaluation, {
  debounceMs: FORWARD_GROUP_EVALUATION_DEBOUNCE_MS,
  retryBaseMs: FORWARD_GROUP_EVALUATION_RETRY_BASE_MS,
  retryMaxMs: FORWARD_GROUP_EVALUATION_RETRY_MAX_MS,
  onError: (error, retryDelayMs) => {
    console.warn(`[ForwardGroup] queued health evaluation failed; retrying in ${retryDelayMs}ms: ${error instanceof Error ? error.message : String(error)}`);
  },
});

export function scheduleForwardGroupFailover(groupIds: number[]) {
  return forwardGroupEvaluationQueue.enqueue(groupIds);
}

export const forwardGroupHealthRechecks = new ForwardGroupHealthRecheckScheduler(
  (groupId) => { scheduleForwardGroupFailover([groupId]); },
  Date.now,
  setTimeout,
  clearTimeout,
  (error) => {
    console.warn(`[ForwardGroup] delayed health evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
  },
);
