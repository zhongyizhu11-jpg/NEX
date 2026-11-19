import { pushAgentRefresh } from "./agentEvents";

/*
  出口状态变了、要入口重新拿配置的推送：按入口机防抖（C2）。

  以前每一次翻转都直接发一条「紧急」推送（紧急的不合并）。一台出口时通时不通、或者几十条规则同时翻转时，
  入口机一秒钟被推几十次，每次都重算一遍下发、热更新一遍 GOST —— 面板自己也跟着忙。

  规矩：
    · 普通的（恢复、延迟优先换了最快的那台、同一个出口又翻了一次）：攒 1.5 秒发一次，和普通刷新的合并窗口
      一样长（AGENT_REFRESH_COALESCE_MS）。
    · 紧急的（某条规则的出口第一次变成连不上）：马上发，但一台入口机一秒最多一次；一秒内再来的并到
      这一秒结束时那一次里。
    · 可以指定「最早什么时候发」（刚翻过的出口恢复时用：等它稳一会儿再加回去）。
  入口拿配置时面板按当时的状态整份重算，所以一次推送覆盖之前所有还没发的请求：发了就把这台的待发全清掉。
  攒着发的那一次带 urgent —— 普通推送离上一次不到 1.5 秒会被 pushAgentRefresh 直接丢掉，而这一次已经等过了。
*/

export const EXIT_TARGET_PUSH_COALESCE_MS = 1500;
export const EXIT_TARGET_URGENT_MIN_GAP_MS = 1000;
const REASON = "exit-target-flip";

type TimerHandle = ReturnType<typeof setTimeout>;
type PushFn = (hostId: number, reason: string, options: { urgent: boolean }) => unknown;

export type ExitTargetPushRequest = {
  /** 第一次变成连不上：不等合并窗口。 */
  urgent?: boolean;
  /** 最早什么时候发（毫秒时间戳）；不给就是合并窗口之后。 */
  notBefore?: number;
};

export class ExitTargetPushDebouncer {
  private readonly pending = new Map<number, { dueAt: number; timer: TimerHandle }>();
  private readonly lastPushAt = new Map<number, number>();

  constructor(
    private readonly push: PushFn = pushAgentRefresh,
    private readonly now: () => number = Date.now,
    private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle = setTimeout,
    private readonly clearTimer: (timer: TimerHandle) => void = clearTimeout,
  ) {}

  request(hostIdValue: number, request: ExitTargetPushRequest = {}) {
    const hostId = Number(hostIdValue);
    if (!Number.isInteger(hostId) || hostId <= 0) return;
    const now = this.now();
    const earliest = (this.lastPushAt.get(hostId) || 0) + EXIT_TARGET_URGENT_MIN_GAP_MS;
    const wanted = request.urgent ? now : Math.max(now + EXIT_TARGET_PUSH_COALESCE_MS, Number(request.notBefore) || 0);
    const dueAt = Math.max(wanted, earliest);
    if (dueAt <= now) {
      this.fire(hostId);
      return;
    }
    const existing = this.pending.get(hostId);
    if (existing && existing.dueAt <= dueAt) return;
    if (existing) this.clearTimer(existing.timer);
    const timer = this.setTimer(() => {
      if (this.pending.get(hostId)?.timer === timer) this.fire(hostId);
    }, dueAt - now);
    timer.unref?.();
    this.pending.set(hostId, { dueAt, timer });
  }

  private fire(hostId: number) {
    const existing = this.pending.get(hostId);
    if (existing) this.clearTimer(existing.timer);
    this.pending.delete(hostId);
    this.lastPushAt.set(hostId, this.now());
    this.push(hostId, REASON, { urgent: true });
  }

  /** 还没发的有几台（测试、排查用）。 */
  pendingCount() {
    return this.pending.size;
  }

  /** 很久没推过的入口机不用一直记着。 */
  prune(olderThanMs: number) {
    const cutoff = this.now() - olderThanMs;
    for (const [hostId, at] of this.lastPushAt) {
      if (at < cutoff && !this.pending.has(hostId)) this.lastPushAt.delete(hostId);
    }
  }

  clear() {
    for (const entry of this.pending.values()) this.clearTimer(entry.timer);
    this.pending.clear();
    this.lastPushAt.clear();
  }
}
