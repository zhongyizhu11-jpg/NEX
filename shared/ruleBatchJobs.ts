import { z } from "zod";

/*
  转发规则的批量任务（上游 2.3.290 / 2.3.292：批量启停、重启 + 服务端任务队列）。

  批量启用 / 暂停 / 重启 / 删除 / 复制不再由浏览器一条条地发：提交一次，面板在服务端排成一个任务慢慢做，
  请求马上带回任务号。右下角的小窗按任务号轮询进度，换页面、刷新都接得上；可以停下剩下的、只重试失败的。

  任务只放在面板进程的内存里：面板重启任务就没了（已经做完的那些规则当然还是做完了），
  做完的任务过几分钟自动忘掉。每条规则都按单条接口原样过权限（rules.toggle / restart / delete / create），
  批量不开后门。
*/

export const RULE_BATCH_JOB_OPERATIONS = ["enable", "pause", "restart", "delete", "copy"] as const;
export type RuleBatchJobOperation = (typeof RULE_BATCH_JOB_OPERATIONS)[number];

export const RULE_BATCH_JOB_OPERATION_LABELS: Record<RuleBatchJobOperation, string> = {
  enable: "批量启用",
  pause: "批量暂停",
  restart: "批量重启",
  delete: "批量删除",
  copy: "批量复制",
};

export const RULE_BATCH_JOB_LIMITS = {
  /** 一个任务最多多少项。 */
  maxItems: 5000,
  /** 同一个账号同时在跑的任务数。 */
  maxRunningPerUser: 2,
  /** 做完的任务留多久（之后查不到了）。 */
  retentionMs: 10 * 60 * 1000,
  /** 一个账号最多留着多少个任务（含做完的）；超了先忘最早做完的。 */
  maxStoredPerUser: 20,
  /** 快照里最多带多少条失败明细。 */
  maxFailuresInSnapshot: 200,
  /** 复制时单条规则的参数最多多大（JSON 字节数）。 */
  maxCopyItemBytes: 16 * 1024,
} as const;

export const RULE_BATCH_CONFLICT_STRATEGIES = ["error", "auto", "skip"] as const;

const copyItemSchema = z.object({
  label: z.string().trim().max(160).default(""),
  /** rules.create 的参数。服务端逐条交给 rules.create 自己校验，这里只限大小。 */
  input: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= RULE_BATCH_JOB_LIMITS.maxCopyItemBytes, "单条规则的参数太大"),
});

export const startRuleBatchJobSchema = z.object({
  operation: z.enum(RULE_BATCH_JOB_OPERATIONS),
  title: z.string().trim().max(80).optional(),
  /** 启用 / 暂停 / 重启 / 删除：要处理的规则 id。 */
  ruleIds: z.array(z.number().int().positive()).max(RULE_BATCH_JOB_LIMITS.maxItems).optional(),
  /** 只给 ruleIds 用的显示名（失败明细里显示），按 id 对应。 */
  ruleLabels: z.record(z.string(), z.string().max(160)).optional(),
  /** 复制：每条要新建的规则。 */
  copyItems: z.array(copyItemSchema).max(RULE_BATCH_JOB_LIMITS.maxItems).optional(),
  /** 复制时端口冲突怎么办：报错 / 自动换端口 / 跳过（和原来的批量复制一样）。 */
  conflictStrategy: z.enum(RULE_BATCH_CONFLICT_STRATEGIES).default("error"),
});
export type StartRuleBatchJobInput = z.infer<typeof startRuleBatchJobSchema>;

export type RuleBatchJobState = "running" | "stopping" | "completed" | "stopped";

export type RuleBatchJobFailure = { index: number; label: string; ruleId?: number; error: string };

export type RuleBatchJobSnapshot = {
  id: string;
  operation: RuleBatchJobOperation;
  title: string;
  state: RuleBatchJobState;
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** 停下时还没做的项数。 */
  notRun: number;
  percent: number;
  createdAt: number;
  finishedAt: number | null;
  /** 做完以后什么时候被忘掉（毫秒时间戳）；还在跑是 null。 */
  forgetAt: number | null;
  stopReason: string | null;
  /** 从哪个任务「重试失败项」来的。 */
  retryOf: string | null;
  failures: RuleBatchJobFailure[];
  /** 失败明细超出 maxFailuresInSnapshot 时还有多少条没带上。 */
  moreFailures: number;
};

export function isRuleBatchJobFinished(snapshot: Pick<RuleBatchJobSnapshot, "state">) {
  return snapshot.state === "completed" || snapshot.state === "stopped";
}

/** 端口冲突（被占用、超出套餐 / 入口端口范围）的报错：复制时据此决定换端口重试或跳过。前后端共用。 */
export function isRuleBatchPortConflictError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  return /(?:端口.*(?:占用|冲突|正在被.*分配)|(?:源|入口|监听|套餐)端口.*(?:必须|仅限|不在|超出).*?(?:范围|区间|允许|内)|(?:source|entry|listener|plan) port.*?(?:range|allowed)|(?:port|entry agent port).*?(?:already (?:used|in use)|being allocated)|EADDRINUSE)/i.test(message);
}
