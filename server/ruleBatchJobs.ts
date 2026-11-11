import crypto from "node:crypto";
import {
  RULE_BATCH_JOB_LIMITS,
  RULE_BATCH_JOB_OPERATION_LABELS,
  type RuleBatchJobFailure,
  type RuleBatchJobOperation,
  type RuleBatchJobSnapshot,
  type RuleBatchJobState,
} from "../shared/ruleBatchJobs";

/*
  规则批量任务的内存队列（上游 2.3.290 / 2.3.292，格式和限制见 shared/ruleBatchJobs.ts）。

  只管「排队、并发、进度、停止、重试、忘掉」，每一项具体怎么做交给构造时传进来的 executor
  （server/routers/rules.batchJobs.ts 里那个逐条调用单条规则接口的）—— 这样权限检查只有单条接口那一份，
  测试也能换一个假的 executor 单测队列本身。

  不落库：面板重启，任务连同进度一起没了。做到一半的规则不会回滚（单条接口本来也没有回滚），
  用户回来看到的是规则列表的真实状态。
*/

export type RuleBatchJobItem = { label: string; ruleId?: number; input?: Record<string, unknown> };

/** 提交任务的人。executor 每做一项都按它重新认人（账号停用、登录失效就停）。 */
export type RuleBatchJobOwner<Extra = unknown> = { userId: number; extra: Extra };

export type RuleBatchJobExecutor<Extra = unknown> = (
  job: { id: string; operation: RuleBatchJobOperation; conflictStrategy: string; owner: RuleBatchJobOwner<Extra> },
  item: RuleBatchJobItem,
) => Promise<{ skipped?: boolean } | void>;

/** executor 抛它表示「整个任务不能再往下做了」（登录失效、数据库不可用……），剩下的项都记成未执行。 */
export class RuleBatchJobStopError extends Error {}

/** 提交被拒（同时在跑的太多、项数超限）。 */
export class RuleBatchJobLimitError extends Error {}

type ItemStatus = "pending" | "running" | "succeeded" | "skipped" | "failed" | "notRun";

type Job<Extra> = {
  id: string;
  owner: RuleBatchJobOwner<Extra>;
  operation: RuleBatchJobOperation;
  title: string;
  conflictStrategy: string;
  fingerprint: string;
  items: RuleBatchJobItem[];
  statuses: ItemStatus[];
  errors: Map<number, string>;
  state: RuleBatchJobState;
  stopRequested: boolean;
  stopReason: string | null;
  createdAt: number;
  finishedAt: number | null;
  retryOf: string | null;
  done: Promise<void>;
};

export type RuleBatchJobQueueOptions = {
  concurrency?: number;
  maxItems?: number;
  maxRunningPerUser?: number;
  retentionMs?: number;
  maxStoredPerUser?: number;
  now?: () => number;
};

export type StartRuleBatchJobRequest = {
  operation: RuleBatchJobOperation;
  title?: string;
  items: RuleBatchJobItem[];
  conflictStrategy?: string;
  retryOf?: string | null;
};

function fingerprintOf(userId: number, request: StartRuleBatchJobRequest) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify([userId, request.operation, request.conflictStrategy || "error"]));
  for (const item of request.items) hash.update(JSON.stringify(item.ruleId ?? item.input ?? null));
  return hash.digest("hex");
}

export class RuleBatchJobQueue<Extra = unknown> {
  private readonly jobs = new Map<string, Job<Extra>>();
  private readonly options: Required<RuleBatchJobQueueOptions>;

  constructor(private readonly executor: RuleBatchJobExecutor<Extra>, options: RuleBatchJobQueueOptions = {}) {
    this.options = {
      concurrency: options.concurrency ?? 4,
      maxItems: options.maxItems ?? RULE_BATCH_JOB_LIMITS.maxItems,
      maxRunningPerUser: options.maxRunningPerUser ?? RULE_BATCH_JOB_LIMITS.maxRunningPerUser,
      retentionMs: options.retentionMs ?? RULE_BATCH_JOB_LIMITS.retentionMs,
      maxStoredPerUser: options.maxStoredPerUser ?? RULE_BATCH_JOB_LIMITS.maxStoredPerUser,
      now: options.now ?? Date.now,
    };
  }

  /**
   * 提交一个任务，马上返回快照（任务在后台跑）。
   * 同一个人同样内容的任务还没做完时再提交（连点、两个标签页各点一次），返回那个已有的任务，
   * duplicate: true —— 不会把同一批规则做两遍。
   */
  start(owner: RuleBatchJobOwner<Extra>, request: StartRuleBatchJobRequest) {
    this.prune();
    if (request.items.length === 0) throw new RuleBatchJobLimitError("没有要处理的规则");
    if (request.items.length > this.options.maxItems) {
      throw new RuleBatchJobLimitError(`一个批量任务最多 ${this.options.maxItems} 项，这次有 ${request.items.length} 项，请分开提交`);
    }
    const fingerprint = fingerprintOf(owner.userId, request);
    const mine = this.jobsOf(owner.userId);
    const existing = mine.find((job) => job.fingerprint === fingerprint && !this.finished(job));
    if (existing) return { snapshot: this.snapshot(existing), duplicate: true };
    const running = mine.filter((job) => !this.finished(job)).length;
    if (running >= this.options.maxRunningPerUser) {
      throw new RuleBatchJobLimitError(`同时最多跑 ${this.options.maxRunningPerUser} 个批量任务，等前面的做完或停下后再提交`);
    }
    const job: Job<Extra> = {
      id: crypto.randomUUID(),
      owner,
      operation: request.operation,
      title: String(request.title || "").trim() || `${RULE_BATCH_JOB_OPERATION_LABELS[request.operation]} ${request.items.length} 条规则`,
      conflictStrategy: request.conflictStrategy || "error",
      fingerprint,
      items: request.items,
      statuses: request.items.map(() => "pending"),
      errors: new Map(),
      state: "running",
      stopRequested: false,
      stopReason: null,
      createdAt: this.options.now(),
      finishedAt: null,
      retryOf: request.retryOf ?? null,
      done: Promise.resolve(),
    };
    this.jobs.set(job.id, job);
    this.trimStored(owner.userId);
    job.done = this.run(job);
    return { snapshot: this.snapshot(job), duplicate: false };
  }

  /** 只认任务的主人：别人的任务一律当作不存在。 */
  get(userId: number, id: string) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.owner.userId !== userId) return null;
    return this.snapshot(job);
  }

  list(userId: number) {
    this.prune();
    return this.jobsOf(userId).sort((a, b) => b.createdAt - a.createdAt).map((job) => this.snapshot(job));
  }

  /** 停下剩下的：正在做的那几项做完，没开始的记成未执行。 */
  stop(userId: number, id: string, reason = "已手动停止") {
    const job = this.jobs.get(id);
    if (!job || job.owner.userId !== userId) return null;
    if (!this.finished(job) && !job.stopRequested) {
      job.stopRequested = true;
      job.stopReason = reason;
      job.state = "stopping";
    }
    return this.snapshot(job);
  }

  /** 只重试失败的项（未执行的不算：那是用户自己停下的）。原任务得已经结束。 */
  retryFailed(owner: RuleBatchJobOwner<Extra>, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner.userId !== owner.userId) return null;
    if (!this.finished(job)) throw new RuleBatchJobLimitError("任务还没结束，结束后才能重试失败项");
    const items = job.items.filter((_, index) => job.statuses[index] === "failed");
    if (items.length === 0) throw new RuleBatchJobLimitError("这个任务没有失败的项");
    return this.start(owner, {
      operation: job.operation,
      title: `重试：${job.title}`.slice(0, 80),
      items,
      conflictStrategy: job.conflictStrategy,
      retryOf: job.id,
    });
  }

  /** 关掉一个已经结束的任务（小窗上的 ×）。还在跑的不能直接关，得先停。 */
  dismiss(userId: number, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner.userId !== userId) return false;
    if (!this.finished(job)) return false;
    this.jobs.delete(id);
    return true;
  }

  /** 测试用：等一个任务跑完。 */
  async wait(id: string) {
    await this.jobs.get(id)?.done;
  }

  private finished(job: Job<Extra>) {
    return job.state === "completed" || job.state === "stopped";
  }

  private jobsOf(userId: number) {
    return [...this.jobs.values()].filter((job) => job.owner.userId === userId);
  }

  /** 忘掉过期的已结束任务。查询时顺手调，路由那边还有一个分钟级的定时器兜底。 */
  prune() {
    const now = this.options.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt >= this.options.retentionMs) this.jobs.delete(id);
    }
  }

  private trimStored(userId: number) {
    const mine = this.jobsOf(userId);
    if (mine.length <= this.options.maxStoredPerUser) return;
    const finished = mine.filter((job) => this.finished(job)).sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    for (const job of finished.slice(0, mine.length - this.options.maxStoredPerUser)) this.jobs.delete(job.id);
  }

  private async run(job: Job<Extra>) {
    // 让出一拍：start() 先把「已提交」的快照带回给请求，再开始做第一项。
    await Promise.resolve();
    let next = 0;
    const worker = async () => {
      while (true) {
        if (job.stopRequested) return;
        const index = next;
        next += 1;
        if (index >= job.items.length) return;
        job.statuses[index] = "running";
        try {
          const result = await this.executor({ id: job.id, operation: job.operation, conflictStrategy: job.conflictStrategy, owner: job.owner }, job.items[index]);
          job.statuses[index] = result && result.skipped ? "skipped" : "succeeded";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "未知错误");
          if (error instanceof RuleBatchJobStopError) {
            // 这一项本身没做成（认人那一步就失败了），记成未执行；整个任务停下。
            job.statuses[index] = "notRun";
            if (!job.stopRequested) {
              job.stopRequested = true;
              job.stopReason = message;
            }
            return;
          }
          job.statuses[index] = "failed";
          job.errors.set(index, message.slice(0, 300));
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, Math.min(this.options.concurrency, job.items.length)) }, () => worker()));
    } finally {
      for (let index = 0; index < job.statuses.length; index += 1) {
        if (job.statuses[index] === "pending" || job.statuses[index] === "running") job.statuses[index] = "notRun";
      }
      job.state = job.stopRequested ? "stopped" : "completed";
      job.finishedAt = this.options.now();
    }
  }

  private snapshot(job: Job<Extra>): RuleBatchJobSnapshot {
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let notRun = 0;
    const failures: RuleBatchJobFailure[] = [];
    job.statuses.forEach((status, index) => {
      if (status === "succeeded") succeeded += 1;
      else if (status === "skipped") skipped += 1;
      else if (status === "notRun") notRun += 1;
      else if (status === "failed") {
        failed += 1;
        if (failures.length < RULE_BATCH_JOB_LIMITS.maxFailuresInSnapshot) {
          const item = job.items[index];
          failures.push({ index, label: item.label || (item.ruleId ? `规则 #${item.ruleId}` : `第 ${index + 1} 项`), ...(item.ruleId ? { ruleId: item.ruleId } : {}), error: job.errors.get(index) || "失败" });
        }
      }
    });
    const processed = succeeded + skipped + failed;
    const total = job.items.length;
    return {
      id: job.id,
      operation: job.operation,
      title: job.title,
      state: job.state,
      total,
      processed,
      succeeded,
      skipped,
      failed,
      notRun,
      percent: total > 0 ? Math.floor(((processed + (this.finished(job) ? notRun : 0)) / total) * 100) : 100,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      forgetAt: job.finishedAt === null ? null : job.finishedAt + this.options.retentionMs,
      stopReason: job.stopReason,
      retryOf: job.retryOf,
      failures,
      moreFailures: Math.max(0, failed - failures.length),
    };
  }
}
