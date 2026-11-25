/*
  面板接口的全局限流（批次 1 · 第 2 项）。

  原来只有登录、订阅、工单、AI 这几处各自限流，普通的 tRPC 接口和 /mcp 来多少接多少：一枚泄露的
  API 令牌、一个写错了循环的脚本，都能把面板（和数据库）拖死。这里给每个调用方一份额度：

    · 带 API 令牌的请求按令牌算（同一个人的网页和他的几枚令牌各算各的）；
    · 登录了的网页按用户算；
    · 没登录的按来源 IP 算（IPv6 按 /64 归并，见 ipRateLimitScope）。

  查询和修改分两份额度：页面轮询全是查询，量大但便宜；修改少而贵。

  算法：滑动窗口计数（当前一分钟的计数 + 上一分钟按剩余比例折算），每个键只存几个数，
  O(1)；键数有上限（setBoundedMapValue），被刷爆也只会挤掉最久没用的键。
  默认额度按忙碌页面实测的 5 倍以上定（见 DEFAULT_API_RATE_LIMIT 的注释），正常用面板碰不到。

  多实例（server/sharedState.ts 判断为 db 模式）时计数在库里共享：每次放行的请求往 api_rate_limit_windows 的
  (key, 当前分钟) 那一行原子加一（一条 upsert，PostgreSQL 顺带带回上一分钟的数），回来的总数覆盖本进程
  缓存里的数 —— 判断仍然是同步的、看缓存，所以每个实例对同一个键最多比额度多放一次（在途那一次）。
  缓存里已经超额的键不再碰库（「明显超额的客户端不该每个请求都打一次库」），估算值随上一分钟折算
  下降到额度以下时才再去库里加一、拿回真实的数。写库失败按本进程计数继续，不影响接口。
  SQLite 部署永远是内存模式，和以前一样。

  配置由 apiRateLimitConfig.ts 读好传进来，测试直接给数。
*/
import { setBoundedMapValue } from "./boundedCache";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { noteSharedStateError, registerSharedStateCleanup, sharedStateKey, sharedStateMode } from "./sharedState";
import { SqlWindowCounterStore, type WindowHit } from "./sharedStateStore";

export type ApiRateLimitConfig = {
  enabled: boolean;
  /** 每分钟次数；0 = 这一项不限。 */
  userQueryPerMinute: number;
  userMutationPerMinute: number;
  tokenQueryPerMinute: number;
  tokenMutationPerMinute: number;
  anonymousQueryPerMinute: number;
  anonymousMutationPerMinute: number;
};

/*
  实测（2.3.518 开发面板，管理员，桌面，含首屏加载在内的第一分钟；tRPC 一次 HTTP 批量里有几个过程算几次）：
  /hosts 93 次、总览 53 次、/rules 43 次、/tunnels 26 次，修改 0 次。四个页面同时开着也就 215 次左右。
  查询 1200 / 分 ≈ 最忙页面的 13 倍、四个标签页的 5.5 倍；修改 240 / 分（批量操作是一次调用，
  不会因为选了 500 条变成 500 次；过程里嵌套的调用不计数，见 trpc.ts）。
  令牌给得少一些（600 / 120）：脚本该做的是精确的几次调用，不是轮询。
  没登录的只有登录页、公开状态页和订阅落地页那几个查询，120 / 分足够。
*/
export const DEFAULT_API_RATE_LIMIT: ApiRateLimitConfig = {
  enabled: true,
  userQueryPerMinute: 1200,
  userMutationPerMinute: 240,
  tokenQueryPerMinute: 600,
  tokenMutationPerMinute: 120,
  anonymousQueryPerMinute: 120,
  anonymousMutationPerMinute: 60,
};

/** 设置里能填的上下限：再低就会误伤正常使用，再高就等于没限。 */
const API_RATE_LIMIT_MIN = 10;
export const API_RATE_LIMIT_MAX = 100_000;

const WINDOW_MS = 60_000;
const MAX_KEYS = 50_000;

function clampLimit(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  return Math.min(API_RATE_LIMIT_MAX, Math.max(API_RATE_LIMIT_MIN, Math.floor(n)));
}

/** 设置里存的 JSON → 完整配置；缺的项用默认值，乱填的夹到范围里。 */
export function normalizeApiRateLimitConfig(value: unknown): ApiRateLimitConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const d = DEFAULT_API_RATE_LIMIT;
  return {
    enabled: raw.enabled === undefined ? d.enabled : raw.enabled !== false,
    userQueryPerMinute: clampLimit(raw.userQueryPerMinute, d.userQueryPerMinute),
    userMutationPerMinute: clampLimit(raw.userMutationPerMinute, d.userMutationPerMinute),
    tokenQueryPerMinute: clampLimit(raw.tokenQueryPerMinute, d.tokenQueryPerMinute),
    tokenMutationPerMinute: clampLimit(raw.tokenMutationPerMinute, d.tokenMutationPerMinute),
    anonymousQueryPerMinute: clampLimit(raw.anonymousQueryPerMinute, d.anonymousQueryPerMinute),
    anonymousMutationPerMinute: clampLimit(raw.anonymousMutationPerMinute, d.anonymousMutationPerMinute),
  };
}

type WindowEntry = {
  windowStart: number;
  /** 这个窗口的数：内存模式是本进程数的；db 模式是库里最近回来的总数（写库失败那几次本地加上）。 */
  current: number;
  previous: number;
  /** db 模式：发出去还没回来的加一（先算进估算，免得一瞬间的并发全放过去）。 */
  inflight: number;
  /** db 模式：previous 是不是已经从库里拿到过（没拿到过的在下一次加一时顺带要）。 */
  previousKnown: boolean;
};

const buckets = new Map<string, WindowEntry>();

let windowStore: SqlWindowCounterStore | null = null;
const pendingHits = new Set<Promise<unknown>>();

function sharedWindowStore() {
  if (!windowStore) windowStore = new SqlWindowCounterStore();
  return windowStore;
}

/** 测试用：换掉写库的那一层（传 null 恢复）。 */
export function setApiRateLimitSharedStoreForTests(store: SqlWindowCounterStore | null) {
  windowStore = store;
}

/** 测试用：等在途的写库都回来。 */
export async function waitForApiRateLimitSharedWrites() {
  while (pendingHits.size > 0) await Promise.allSettled([...pendingHits]);
}

/** 库回来的总数覆盖缓存：键的窗口没变就更新当前窗口；已经翻到下一个窗口就只能补上一个窗口的数。 */
function applySharedHit(key: string, windowStart: number, hit: WindowHit) {
  const entry = buckets.get(key);
  if (!entry) return;
  if (entry.windowStart === windowStart) {
    entry.inflight = Math.max(0, entry.inflight - 1);
    entry.current = Math.max(entry.current, hit.current);
    if (hit.previous !== null && !entry.previousKnown) {
      entry.previous = Math.max(entry.previous, hit.previous);
      entry.previousKnown = true;
    }
  } else if (entry.windowStart - windowStart === WINDOW_MS) {
    entry.previous = Math.max(entry.previous, hit.current);
    entry.previousKnown = true;
  }
}

function sharedHit(key: string, windowStart: number, wantPrevious: boolean) {
  const task = sharedWindowStore().hit(sharedStateKey(key), windowStart, WINDOW_MS, wantPrevious)
    .then((hit) => applySharedHit(key, windowStart, hit))
    .catch((error) => {
      // 写不进库：这一次按本进程的计数算（别让库的故障放过超额的客户端，也别挡住正常请求）。
      const entry = buckets.get(key);
      if (entry && entry.windowStart === windowStart) {
        entry.inflight = Math.max(0, entry.inflight - 1);
        entry.current += 1;
      }
      noteSharedStateError("api rate limit", error);
    });
  pendingHits.add(task);
  void task.finally(() => { pendingHits.delete(task); });
}

registerSharedStateCleanup("api_rate_limit_windows", () => sharedWindowStore().prune(WINDOW_MS));

export type ApiRateLimitCaller = {
  apiTokenId?: number | null;
  userId?: number | null;
  ip?: string | null;
};

export type ApiRateLimitKind = "query" | "mutation";

export type ApiRateLimitDecision = {
  limited: boolean;
  retryAfterSeconds: number;
  /** 这次算在谁头上 */
  subject: "token" | "user" | "anonymous";
  key: string;
  limit: number;
};

/** 这次请求算谁的、用哪一档额度。 */
export function apiRateLimitSubject(caller: ApiRateLimitCaller, kind: ApiRateLimitKind, config: ApiRateLimitConfig) {
  const tokenId = Number(caller.apiTokenId || 0);
  if (tokenId > 0) {
    return { subject: "token" as const, key: `t:${tokenId}:${kind}`, limit: kind === "query" ? config.tokenQueryPerMinute : config.tokenMutationPerMinute };
  }
  const userId = Number(caller.userId || 0);
  if (userId > 0) {
    return { subject: "user" as const, key: `u:${userId}:${kind}`, limit: kind === "query" ? config.userQueryPerMinute : config.userMutationPerMinute };
  }
  const ip = ipRateLimitScope(String(caller.ip || "")) || "unknown";
  return { subject: "anonymous" as const, key: `ip:${ip}:${kind}`, limit: kind === "query" ? config.anonymousQueryPerMinute : config.anonymousMutationPerMinute };
}

/**
 * 记一次调用，返回要不要挡。被挡的那一次不计数（客户端一直重试也不会把窗口越推越远）。
 * kind 不是 query 的（mutation、subscription）都算修改那一档。
 */
export function checkApiRateLimit(
  caller: ApiRateLimitCaller,
  type: string,
  config: ApiRateLimitConfig,
  now = Date.now(),
): ApiRateLimitDecision {
  const kind: ApiRateLimitKind = type === "query" ? "query" : "mutation";
  const { subject, key, limit } = apiRateLimitSubject(caller, kind, config);
  if (!config.enabled || limit <= 0) return { limited: false, retryAfterSeconds: 0, subject, key, limit };

  const shared = sharedStateMode() === "db";
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  let entry = buckets.get(key);
  if (!entry) {
    entry = { windowStart, current: 0, previous: 0, inflight: 0, previousKnown: !shared };
  } else if (entry.windowStart !== windowStart) {
    // 跨过一个窗口：当前变成上一个（在途的也算，回来时按上一个窗口补）；跨过两个以上：上一个也清零。
    entry = {
      windowStart,
      current: 0,
      previous: windowStart - entry.windowStart === WINDOW_MS ? entry.current + entry.inflight : 0,
      inflight: 0,
      previousKnown: !shared,
    };
  }
  const elapsedRatio = (now - windowStart) / WINDOW_MS;
  const counted = entry.current + entry.inflight;
  const estimate = entry.previous * (1 - elapsedRatio) + counted;
  if (estimate + 1 > limit) {
    setBoundedMapValue(buckets, key, entry, MAX_KEYS);
    // 估算值每过一段时间下降 previous/WINDOW_MS；算出要等多久才降回 limit 以下，至少 1 秒。
    let waitMs: number;
    if (counted + 1 > limit) {
      waitMs = windowStart + WINDOW_MS - now;
    } else {
      const excess = estimate + 1 - limit;
      waitMs = entry.previous > 0 ? (excess / entry.previous) * WINDOW_MS : windowStart + WINDOW_MS - now;
    }
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)), subject, key, limit };
  }
  if (shared) {
    entry.inflight += 1;
    setBoundedMapValue(buckets, key, entry, MAX_KEYS);
    sharedHit(key, windowStart, !entry.previousKnown);
  } else {
    entry.current += 1;
    setBoundedMapValue(buckets, key, entry, MAX_KEYS);
  }
  return { limited: false, retryAfterSeconds: 0, subject, key, limit };
}

/** 给人看的拒绝说明。 */
export function apiRateLimitMessage(decision: Pick<ApiRateLimitDecision, "subject" | "limit" | "retryAfterSeconds">, kind: string) {
  const who = decision.subject === "token" ? "这个 API 令牌" : decision.subject === "user" ? "你的账号" : "这个 IP ";
  const what = kind === "query" ? "查询" : "修改";
  return `请求太频繁：${who}每分钟最多 ${decision.limit} 次${what}，请 ${decision.retryAfterSeconds} 秒后再试`;
}

/** 测试用：清空计数。 */
export function resetApiRateLimitForTests() {
  buckets.clear();
}
