import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";
import { noteSharedStateError, sharedStateKey, sharedStateMode, type SharedStateMode } from "./sharedState";
import { attemptCounterKey, SqlAttemptCounterStore, type AttemptCounterAnchor, type AttemptCounterRow } from "./sharedStateStore";

/*
  「一段时间里数了几次」的计数器，接口是同步的，内存模式就是以前那张 Map；db 模式（sharedState.ts）
  在内存那份之外再把每次加一写进 auth_attempt_counters，写回来的总数（全体实例的）覆盖内存里的，
  读的时候顺手异步刷一次。登录失败锁定、验证码要求、2FA 挑战签发、找回密码额度都用它。

  anchor 决定窗口怎么算（和各调用方原来的语义一致）：
    last   从最近一次算：lastAt 之后 windowMs 内再来一次就累加，隔了 windowMs 没动静就从头数（失败锁定）；
    first  从第一次算：firstAt 起 windowMs 内最多 N 次，到点整体清零（签发 / 找回密码这类额度）。
  内存模式下 first 这一种以前是按时间戳列表滑动的；db 模式改成按第一次算的固定窗口（一行就能原子更新），
  只有「到点一起清零」和「一个一个滑出去」的差别，额度本身不变。

  db 模式下内存里存的时刻都是本机时钟：库回来的 firstAt / lastAt 连同库的 now 一起回来，按
  「本机现在 − 库现在」换算过再存，各实例时钟差多少都不影响「还要锁几秒」。

  清掉（登录成功）之后，之前发出去还没回来的加一不能把计数再写回来：每个键记一个代数，清一次加一，
  旧代数的结果丢掉。另一个实例清掉之后本实例的缓存要跟着没：刷新发现库里没这一行、本实例也没有
  在途的加一，就删掉缓存 —— 用户在 A 实例登录成功后，B 实例上最多再被拒一次。
*/

export type SharedCounterEntry = {
  count: number;
  firstAt: number;
  lastAt: number;
};

export type SharedCounterOptions = {
  /** 库里的 scope 列：同一张表里区分用途。 */
  scope: string;
  windowMs: number;
  anchor: AttemptCounterAnchor;
  maxKeys: number;
  mode?: () => SharedStateMode;
  store?: SqlAttemptCounterStore;
};

/** 同一个键的刷新至少隔这么久：被狂刷的登录接口不至于每次请求都查一次库（加一的结果本来就会刷新缓存）。 */
const REFRESH_MIN_INTERVAL_MS = 1_000;

let defaultStore: SqlAttemptCounterStore | null = null;

/** 测试用：换掉所有计数器共用的库存取（传 null 恢复）。 */
export function setSharedCounterStoreForTests(store: SqlAttemptCounterStore | null) {
  defaultStore = store;
}

function sharedCounterStore() {
  if (!defaultStore) defaultStore = new SqlAttemptCounterStore();
  return defaultStore;
}

export class SharedCounter {
  private readonly entries = new Map<string, SharedCounterEntry>();
  private readonly generations = new Map<string, number>();
  private readonly inflightBumps = new Map<string, number>();
  private readonly refreshedAt = new Map<string, number>();
  private readonly pending = new Set<Promise<unknown>>();
  readonly scope: string;
  private readonly windowMs: number;
  private readonly anchor: AttemptCounterAnchor;
  private readonly maxKeys: number;
  private readonly mode: () => SharedStateMode;
  private readonly store: SqlAttemptCounterStore | null;

  constructor(options: SharedCounterOptions) {
    this.scope = options.scope;
    this.windowMs = Math.max(1, options.windowMs);
    this.anchor = options.anchor;
    this.maxKeys = Math.max(1, options.maxKeys);
    this.mode = options.mode ?? sharedStateMode;
    this.store = options.store ?? null;
  }

  get size() {
    return this.entries.size;
  }

  private expired(entry: SharedCounterEntry, now: number, windowMs: number) {
    return now - (this.anchor === "first" ? entry.firstAt : entry.lastAt) >= windowMs;
  }

  private active(key: string, now: number, windowMs: number) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!this.expired(entry, now, windowMs)) return entry;
    this.entries.delete(key);
    return null;
  }

  /** 现在这个键数到几了（没有 / 过期 = null）。db 模式顺手异步刷新。windowMs 可按调用覆盖（找回密码各键窗口不同）。 */
  state(key: string, now = Date.now(), windowMs = this.windowMs): SharedCounterEntry | null {
    const entry = this.active(key, now, windowMs);
    if (this.mode() === "db") this.refresh(key, now, windowMs);
    return entry ? { ...entry } : null;
  }

  /** 加一，返回加完的（内存里的）计数。db 模式同时写库，写回来的总数覆盖内存。 */
  bump(key: string, now = Date.now(), windowMs = this.windowMs): SharedCounterEntry {
    const entry = this.active(key, now, windowMs);
    const next: SharedCounterEntry = entry
      ? { count: entry.count + 1, firstAt: entry.firstAt, lastAt: now }
      : { count: 1, firstAt: now, lastAt: now };
    setBoundedMapValue(this.entries, key, next, this.maxKeys);
    if (this.mode() === "db") this.mirrorBump(key, windowMs);
    return { ...next };
  }

  clear(key: string) {
    this.entries.delete(key);
    if (this.mode() !== "db") return;
    this.generations.set(key, (this.generations.get(key) || 0) + 1);
    this.track((this.store ?? sharedCounterStore()).clear(this.scope, sharedStateKey(key)).catch((error) => noteSharedStateError(`counter ${this.scope} clear`, error)));
  }

  prune(now = Date.now()) {
    pruneMapEntries(this.entries, (entry) => this.expired(entry, now, this.windowMs));
    pruneMapEntries(this.refreshedAt, (at) => now - at >= this.windowMs);
    pruneMapEntries(this.generations, (_generation, key) => !this.entries.has(key) && !this.inflightBumps.has(key));
  }

  clearAll() {
    this.entries.clear();
    this.generations.clear();
    this.inflightBumps.clear();
    this.refreshedAt.clear();
  }

  /** 测试用：等在途的写库 / 刷新都回来。 */
  async flush() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track<T>(promise: Promise<T>) {
    this.pending.add(promise);
    void promise.finally(() => { this.pending.delete(promise); });
  }

  private mirrorBump(key: string, windowMs: number) {
    const generation = this.generations.get(key) || 0;
    this.inflightBumps.set(key, (this.inflightBumps.get(key) || 0) + 1);
    const task = (this.store ?? sharedCounterStore()).bump(this.scope, sharedStateKey(key), windowMs, this.anchor)
      .then((row) => this.merge(key, row, generation, Date.now(), windowMs))
      .catch((error) => noteSharedStateError(`counter ${this.scope} bump`, error))
      .finally(() => {
        const left = (this.inflightBumps.get(key) || 1) - 1;
        if (left > 0) this.inflightBumps.set(key, left);
        else this.inflightBumps.delete(key);
      });
    this.track(task);
  }

  private refresh(key: string, now: number, windowMs: number) {
    const last = this.refreshedAt.get(key) || 0;
    if (now - last < REFRESH_MIN_INTERVAL_MS) return;
    setBoundedMapValue(this.refreshedAt, key, now, this.maxKeys);
    const generation = this.generations.get(key) || 0;
    const task = (this.store ?? sharedCounterStore()).read([{ scope: this.scope, key: sharedStateKey(key) }])
      .then((rows) => {
        const row = rows.get(attemptCounterKey(this.scope, sharedStateKey(key)));
        if (row) {
          this.merge(key, row, generation, Date.now(), windowMs);
        } else if ((this.generations.get(key) || 0) === generation && !this.inflightBumps.has(key)) {
          // 库里没有了（别的实例清掉的）、本实例也没有在途的加一：缓存跟着清。
          this.entries.delete(key);
        }
      })
      .catch((error) => noteSharedStateError(`counter ${this.scope} read`, error));
    this.track(task);
  }

  /** 库回来的行换算成本机时钟后覆盖缓存：库的数是全体实例的，只会比本地的多（少的话是库那边已经换了一轮，本地的留着更保守）。 */
  private merge(key: string, row: AttemptCounterRow, generation: number, receivedAt: number, windowMs: number) {
    if ((this.generations.get(key) || 0) !== generation) return;
    const offset = row.now ? receivedAt - row.now : 0;
    const next: SharedCounterEntry = { count: row.hits, firstAt: row.firstAt + offset, lastAt: row.lastAt + offset };
    if (this.expired(next, receivedAt, windowMs)) return;
    const current = this.active(key, receivedAt, windowMs);
    if (current && current.count > next.count) return;
    setBoundedMapValue(this.entries, key, next, this.maxKeys);
  }
}
