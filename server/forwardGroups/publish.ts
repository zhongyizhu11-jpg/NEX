import crypto from "node:crypto";

/*
  解析发布队列：评估（DECIDE）只读库、算出这一轮该发什么，发现要写服务商时不在评估队列里写，而是把这个组
  交到这里（PUBLISH）。以前评估是一条串行队列、服务商请求内联在里面（一次请求最长等 15 秒，一个组可能好几次），
  一家服务商慢了，所有组的切换判断都排在它后面（P7）。

    · 按「服务商账号」分队列：一个账号同时最多跑 concurrency 个组，互不影响别的账号。
    · 同一个组只排一份：排队期间又来几次，只跑一次；真正跑的时候重新读库、重新评估，发的是那一刻的结论
      （最新的期望状态生效，中间的不补发）。正在跑的时候又来一次，跑完再跑一遍。
    · 失败按退避重试（1 秒起翻倍，最长 30 秒），成功清零。

  这里只管排队和重试；「发什么、怎么只动面板自己的记录」还是 ddnsPublish.ts / ddnsEntryGroup.ts / ddns.ts 那一套。
*/

type TimerHandle = ReturnType<typeof setTimeout>;

export type ForwardGroupPublishQueueOptions = {
  concurrency?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onError?: (error: unknown, context: { account: string; groupId: number; retryDelayMs: number; failures: number }) => void;
};

type GroupState = {
  account: string;
  /** queued = 排着；running = 正在发；idle = 等重试定时器。 */
  phase: "queued" | "running" | "idle";
  /** 正在跑的时候又来了一次：跑完再来一遍。 */
  rerun: boolean;
  failures: number;
  retryTimer: TimerHandle | null;
};

type AccountState = { running: number; queue: number[] };

export class ForwardGroupPublishQueue {
  private readonly concurrency: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly onError: NonNullable<ForwardGroupPublishQueueOptions["onError"]>;
  private readonly groups = new Map<number, GroupState>();
  private readonly accounts = new Map<string, AccountState>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly publish: (groupId: number) => Promise<void>,
    options: ForwardGroupPublishQueueOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(Number(options.concurrency ?? 2)));
    this.retryBaseMs = Math.max(1, Number(options.retryBaseMs ?? 1_000));
    this.retryMaxMs = Math.max(this.retryBaseMs, Number(options.retryMaxMs ?? 30_000));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError ?? (() => {});
  }

  /** 把一个组交给它所在账号的队列。已经排着的不重复排；正在跑的记一个「跑完再来」。 */
  enqueue(accountValue: string, groupIdValue: unknown) {
    const groupId = Number(groupIdValue);
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    const account = String(accountValue || "default");
    const existing = this.groups.get(groupId);
    if (existing) {
      if (existing.phase === "running") {
        existing.rerun = true;
        existing.account = account;
        return true;
      }
      if (existing.phase === "queued") {
        if (existing.account === account) return true;
        // 换了服务商账号：从旧账号的队列里拿出来，排到新的那边。
        this.removeFromQueue(existing.account, groupId);
      }
      // 等重试的：有新的评估结论了，不等定时器，马上排。失败次数留着（服务商还没好的话退避不清零）。
      if (existing.retryTimer) this.clearTimer(existing.retryTimer);
      existing.retryTimer = null;
      existing.account = account;
      existing.phase = "queued";
    } else {
      this.groups.set(groupId, { account, phase: "queued", rerun: false, failures: 0, retryTimer: null });
    }
    this.accountState(account).queue.push(groupId);
    this.pump(account);
    return true;
  }

  /** 排着、跑着、等重试的组数。 */
  pending() {
    return this.groups.size;
  }

  isPending(groupIdValue: unknown) {
    return this.groups.has(Number(groupIdValue));
  }

  /** 等到没有任何排着 / 跑着 / 等重试的组（测试用）。 */
  whenIdle() {
    if (this.groups.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve); });
  }

  private accountState(account: string) {
    let state = this.accounts.get(account);
    if (!state) {
      state = { running: 0, queue: [] };
      this.accounts.set(account, state);
    }
    return state;
  }

  private removeFromQueue(account: string, groupId: number) {
    const state = this.accounts.get(account);
    if (!state) return;
    const index = state.queue.indexOf(groupId);
    if (index >= 0) state.queue.splice(index, 1);
  }

  private settleIdle() {
    if (this.groups.size > 0 || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private pump(account: string) {
    const state = this.accountState(account);
    while (state.running < this.concurrency && state.queue.length > 0) {
      const groupId = state.queue.shift()!;
      const group = this.groups.get(groupId);
      if (!group || group.phase !== "queued" || group.account !== account) continue;
      group.phase = "running";
      group.rerun = false;
      state.running += 1;
      void this.run(account, groupId, group);
    }
    if (state.running === 0 && state.queue.length === 0) this.accounts.delete(account);
  }

  private async run(account: string, groupId: number, group: GroupState) {
    let failed: unknown = null;
    let ok = false;
    try {
      await this.publish(groupId);
      ok = true;
    } catch (error) {
      failed = error;
    }
    const state = this.accountState(account);
    state.running -= 1;
    if (ok) {
      group.failures = 0;
      if (group.rerun) {
        group.rerun = false;
        group.phase = "queued";
        this.accountState(group.account).queue.push(groupId);
        if (group.account !== account) this.pump(group.account);
      } else {
        this.groups.delete(groupId);
      }
    } else {
      group.failures += 1;
      const exponent = Math.min(group.failures - 1, 30);
      const retryDelayMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
      group.phase = "idle";
      group.rerun = false;
      const timer = this.setTimer(() => {
        if (this.groups.get(groupId) !== group || group.retryTimer !== timer) return;
        group.retryTimer = null;
        group.phase = "queued";
        this.accountState(group.account).queue.push(groupId);
        this.pump(group.account);
      }, retryDelayMs);
      timer.unref?.();
      group.retryTimer = timer;
      try {
        this.onError(failed, { account, groupId, retryDelayMs, failures: group.failures });
      } catch {
        // 队列往下走不能依赖日志写成功。
      }
    }
    this.pump(account);
    this.settleIdle();
  }
}

/**
 * 「服务商账号」的键：同一个账号的请求共用一个队列（限流、连接都是按账号算的）。
 * 只取能区分账号的那几样，密钥本身不进键（哈希一下，不出现在日志里）。
 */
export function ddnsProviderAccountKey(settings: {
  provider?: unknown;
  cloudflareApiToken?: unknown;
  cloudflareZoneId?: unknown;
  webhookUrl?: unknown;
  huaweicloudAccessKeyId?: unknown;
  aliyunAccessKeyId?: unknown;
  tencentcloudSecretId?: unknown;
} | null | undefined) {
  const provider = String(settings?.provider || "disabled");
  const identity = provider === "cloudflare"
    ? `${String(settings?.cloudflareZoneId || "")}|${String(settings?.cloudflareApiToken || "")}`
    : provider === "webhook"
      ? String(settings?.webhookUrl || "")
      : provider === "huaweicloud"
        ? String(settings?.huaweicloudAccessKeyId || "")
        : provider === "aliyun"
          ? String(settings?.aliyunAccessKeyId || "")
          : provider === "tencentcloud"
            ? String(settings?.tencentcloudSecretId || "")
            : "";
  return `${provider}:${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}
