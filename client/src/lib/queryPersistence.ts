import { dehydrate, hydrate, type Query, type QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { APP_VERSION } from "@shared/versions";

/*
  打开面板 / App 时先画上一次的数据，再在后台刷新。

  以前每次打开都是空的查询缓存：先等 setup.status、auth.me 回来才挂页面（这期间整屏空白），
  页面挂上后再等列表接口，手机上隔着海外线路要一两秒。现在把列表、概览这类数据留一份在
  本机，下次打开同步读出来先画，接口回来再换成新的 —— 和 iOS 原生 App 打开即见的感觉一样。

  只留「看列表要用的」：路由白名单 + 字段名兜底，带令牌、密钥、密码字段的结果一律不落盘。
  版本号进了键名，面板升级后旧缓存直接作废，不会拿旧结构的数据去画新页面。
  退出登录、登录失效、在登录页重新登录都会清掉。
*/

const STORAGE_PREFIX = "forwardx.queryCache.v1";
export const QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUERY_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2_500_000;
// 第一次有新结果后稍等一下就存（刚登录、刚打开时尽快留一份）；之后最多 30 秒存一次。
// 切到后台、关页面时不等，立刻存。以前每 1.5 秒存一次，主机页概览 3 秒一刷，主线程一直在序列化。
const SAVE_DELAY_MS = 1_500;
export const SAVE_MIN_INTERVAL_MS = 30_000;

const PERSISTED_ROUTERS = new Set([
  "setup",
  "dashboard",
  "hosts",
  "rules",
  "tunnels",
  "forwardGroups",
  "users",
  "plans",
  "announcements",
  "trafficBilling",
]);
const PERSISTED_PATHS = new Set(["auth.me", "system.publicInfo"]);
/*
  白名单路由里那些几秒一轮询的「实时」接口不存：概览、实时速率、延迟曲线、测试进度、日志。
  它们每轮都有新结果，存了也是下一秒就过时，只会让序列化一直跑；打开页面时它们本来就要马上重新拉。
  以 refetchInterval 用到的为准（hosts.summary、hosts.pageLive、rules.trafficSummary……）。
*/
const LIVE_PATHS = new Set([
  "hosts.summary",
  "hosts.pageLive",
  "hosts.liveVitals",
  "hosts.metrics",
  "hosts.latestMetricsSummary",
  "hosts.lineHealth",
  "hosts.exitQuality",
  "hosts.unlockStatus",
  "hosts.speedTestStatus",
  "hosts.mimicInstallStatus",
  "hosts.probeServiceSeries",
  "rules.trafficSummary",
  "rules.trafficSeriesBatch",
  "rules.latestTest",
  "rules.connectionsStatus",
  "rules.routeStatus",
  "rules.routeEvents",
  "rules.routeQualityHistory",
  "rules.tcpingSeries",
  "rules.probeStatistics",
  "tunnels.latencySeries",
  "tunnels.latencySparkBatch",
  "tunnels.latencyHistoryBatch",
  "tunnels.probeStatistics",
  "forwardGroups.latestTest",
  "forwardGroups.latencySeries",
  "forwardGroups.probeStatistics",
  "forwardGroups.bandwidthAggregation",
  "setup.migrationStatus",
]);
// 日志类：不管挂在哪个路由下都不存。
const LOG_PATH = /(^|\.)(logs?|\w+Logs?)(\.|$)/;
const SENSITIVE_FIELD = /token|secret|password|passwd|private.?key|api.?key|credential/i;

export function queryPathOf(queryKey: readonly unknown[]) {
  const head = queryKey?.[0];
  return Array.isArray(head) ? head.map(String).join(".") : "";
}

export function isLivePollingPath(path: string) {
  return LIVE_PATHS.has(path) || LOG_PATH.test(path);
}

export function isPersistablePath(path: string) {
  if (!path) return false;
  if (PERSISTED_PATHS.has(path)) return true;
  if (isLivePollingPath(path)) return false;
  return PERSISTED_ROUTERS.has(path.split(".")[0]);
}

/** 结果里有没有带值的敏感字段（字段名像令牌、密钥、密码，值是字符串或对象）。只看字段名，深度和数量都有上限，大列表不至于卡。 */
export function containsSensitiveField(value: unknown) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    if (!current || typeof current !== "object" || depth > 6) continue;
    if (++visited > 20_000) return true;
    if (Array.isArray(current)) {
      for (const item of current) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (current instanceof Date) continue;
    for (const [key, field] of Object.entries(current as Record<string, unknown>)) {
      // 数字、布尔（如 maxProxySubTokens 这种配额）不算；有内容的字符串或对象才算。
      if (SENSITIVE_FIELD.test(key) && ((typeof field === "string" && field !== "") || (field && typeof field === "object" && !(field instanceof Date)))) return true;
      if (field && typeof field === "object") stack.push({ value: field, depth: depth + 1 });
    }
  }
  return false;
}

function shouldPersistQuery(query: Query) {
  return query.state.status === "success"
    && query.state.data !== undefined
    && isPersistablePath(queryPathOf(query.queryKey))
    && !containsSensitiveField(query.state.data);
}

type PersistedCache = { version: string; savedAt: number; state: ReturnType<typeof dehydrate> };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "length" | "key">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function queryCacheStorageKey(scope = "") {
  return `${STORAGE_PREFIX}:${APP_VERSION}:${scope || "web"}`;
}

// 清掉之后到页面重新加载前不再写：退出登录时页面关掉的那一下（pagehide）不能把上一个人的数据又存回去。
let persistenceSuspended = false;

export function clearPersistedQueryCache(
  storage: StorageLike | null = defaultStorage(),
  options: { suspend?: boolean } = {},
) {
  if (options.suspend !== false) persistenceSuspended = true;
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // 存储不可用时没什么可清的。
  }
}

function removeOtherVersionCaches(storage: StorageLike) {
  try {
    const current = `${STORAGE_PREFIX}:${APP_VERSION}:`;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX) && !key.startsWith(current)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // ignore
  }
}

/** 同步读出上一次的数据放进查询缓存。返回放进去了几条。 */
export function restorePersistedQueryCache(
  queryClient: QueryClient,
  options: { scope?: string; storage?: StorageLike | null; now?: number } = {},
) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return 0;
  const key = queryCacheStorageKey(options.scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      // 版本换了：上一版留下的缓存用不上了，顺手清掉（同版本别的面板的留着）。
      removeOtherVersionCaches(storage);
      return 0;
    }
    const parsed = superjson.parse<PersistedCache>(raw);
    const now = options.now ?? Date.now();
    if (!parsed || parsed.version !== APP_VERSION || !(now - Number(parsed.savedAt) < QUERY_CACHE_MAX_AGE_MS)) {
      storage.removeItem(key);
      return 0;
    }
    const queries = (parsed.state?.queries || []).filter((query) => isPersistablePath(queryPathOf(query.queryKey as unknown[])));
    hydrate(queryClient, { mutations: [], queries });
    // 读出来的都当作过期：页面一挂上就去刷新，不会有哪条一直停在旧数据上。
    void queryClient.invalidateQueries({ refetchType: "none" });
    return queries.length;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // ignore
    }
    return 0;
  }
}

/** 只给测试用：把「清掉后暂停写入」复位。 */
export function resumeQueryCachePersistenceForTests() {
  persistenceSuspended = false;
}

type SuperJsonMeta = { values?: unknown; referentialEqualities?: unknown; v?: number };

function prefixedPaths(prefix: string, record: Record<string, unknown>, mapValue: (value: unknown) => unknown = (value) => value) {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(record)) out[`${prefix}${path}`] = mapValue(value);
  return out;
}

/*
  每条查询只序列化一次：量大小用的就是这条的字符串，最后的整包直接把这些字符串拼起来，
  不再把整个缓存重新走一遍。拼出来的就是 superjson 自己的格式（json + meta），
  读的时候照旧 superjson.parse。各条的 meta 路径加上「state.queries.<序号>.」前缀合进去。
*/
export function serializeQueryCache(queryClient: QueryClient, now = Date.now()) {
  const state = dehydrate(queryClient, { shouldDehydrateQuery: shouldPersistQuery, shouldDehydrateMutation: () => false });
  let total = 0;
  const jsonParts: string[] = [];
  const values: Record<string, unknown> = {};
  const referentialEqualities: Record<string, unknown> = {};
  // 新的优先：超出总量时丢最久没更新的。
  for (const query of [...state.queries].sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt)) {
    const serialized = superjson.serialize(query) as { json: unknown; meta?: SuperJsonMeta };
    const meta = serialized.meta;
    // 根上带注解（数组形式）的情况查询对象不会出现；万一出现就不存这一条，不去猜格式。
    if (meta && (Array.isArray(meta.values) || Array.isArray(meta.referentialEqualities))) continue;
    const json = JSON.stringify(serialized.json);
    const size = json.length;
    if (size > MAX_QUERY_BYTES || total + size > MAX_TOTAL_BYTES) continue;
    total += size;
    const prefix = `state.queries.${jsonParts.length}.`;
    jsonParts.push(json);
    if (meta?.values) Object.assign(values, prefixedPaths(prefix, meta.values as Record<string, unknown>));
    if (meta?.referentialEqualities) {
      Object.assign(referentialEqualities, prefixedPaths(prefix, meta.referentialEqualities as Record<string, unknown>, (paths) =>
        Array.isArray(paths) ? paths.map((path) => `${prefix}${path}`) : paths));
    }
  }
  const head = JSON.stringify({ version: APP_VERSION, savedAt: now });
  const body = `${head.slice(0, -1)},"state":{"mutations":[],"queries":[${jsonParts.join(",")}]}}`;
  const metaOut: SuperJsonMeta = {};
  if (Object.keys(values).length > 0) metaOut.values = values;
  if (Object.keys(referentialEqualities).length > 0) metaOut.referentialEqualities = referentialEqualities;
  if (!metaOut.values && !metaOut.referentialEqualities) return `{"json":${body}}`;
  metaOut.v = 1;
  return `{"json":${body},"meta":${JSON.stringify(metaOut)}}`;
}

/**
 * 查询有新结果就记下「有变化」：第一次稍等一下就存，之后最多 30 秒存一次；
 * 切到后台、关页面（pagehide / beforeunload）时有没存的就立刻存。
 */
export function startQueryCachePersistence(
  queryClient: QueryClient,
  options: { scope?: string | (() => string); storage?: StorageLike | null; now?: () => number } = {},
) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return () => {};
  const scopeOf = () => (typeof options.scope === "function" ? options.scope() : options.scope) || "";
  const clock = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let lastSavedAt = 0;
  let stopped = false;

  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || persistenceSuspended || !dirty) return;
    dirty = false;
    lastSavedAt = clock();
    try {
      storage.setItem(queryCacheStorageKey(scopeOf()), serializeQueryCache(queryClient, lastSavedAt));
    } catch {
      // 空间满了或被禁用：下次打开就是没有缓存的老样子，不影响使用。
      try {
        storage.removeItem(queryCacheStorageKey(scopeOf()));
      } catch {
        // ignore
      }
    }
  };
  const schedule = () => {
    dirty = true;
    if (stopped || timer) return;
    const wait = lastSavedAt > 0 ? Math.max(SAVE_DELAY_MS, lastSavedAt + SAVE_MIN_INTERVAL_MS - clock()) : SAVE_DELAY_MS;
    timer = setTimeout(save, wait);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "success" && isPersistablePath(queryPathOf(event.query.queryKey))) {
      schedule();
    }
  });
  const onHidden = () => {
    if (document.visibilityState === "hidden") save();
  };
  const onPageHide = () => save();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onHidden);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onHidden);
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
    }
  };
}
