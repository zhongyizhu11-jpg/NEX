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
const SAVE_DELAY_MS = 1_500;

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
const SENSITIVE_FIELD = /token|secret|password|passwd|private.?key|api.?key|credential/i;

export function queryPathOf(queryKey: readonly unknown[]) {
  const head = queryKey?.[0];
  return Array.isArray(head) ? head.map(String).join(".") : "";
}

export function isPersistablePath(path: string) {
  if (!path) return false;
  if (PERSISTED_PATHS.has(path)) return true;
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

export function serializeQueryCache(queryClient: QueryClient, now = Date.now()) {
  const state = dehydrate(queryClient, { shouldDehydrateQuery: shouldPersistQuery, shouldDehydrateMutation: () => false });
  let total = 0;
  const queries = [];
  // 新的优先：超出总量时丢最久没更新的。
  for (const query of [...state.queries].sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt)) {
    const size = superjson.stringify(query.state.data).length;
    if (size > MAX_QUERY_BYTES || total + size > MAX_TOTAL_BYTES) continue;
    total += size;
    queries.push(query);
  }
  return superjson.stringify({ version: APP_VERSION, savedAt: now, state: { mutations: [], queries } } satisfies PersistedCache);
}

/** 查询有新结果就过一会儿存一次；切到后台、关页面时立刻存。 */
export function startQueryCachePersistence(
  queryClient: QueryClient,
  options: { scope?: string | (() => string); storage?: StorageLike | null } = {},
) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return () => {};
  const scopeOf = () => (typeof options.scope === "function" ? options.scope() : options.scope) || "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || persistenceSuspended) return;
    try {
      storage.setItem(queryCacheStorageKey(scopeOf()), serializeQueryCache(queryClient));
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
    if (!stopped && !timer) timer = setTimeout(save, SAVE_DELAY_MS);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "success" && isPersistablePath(queryPathOf(event.query.queryKey))) {
      schedule();
    }
  });
  const onHidden = () => {
    if (document.visibilityState === "hidden" && timer) save();
  };
  const onPageHide = () => {
    if (timer) save();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onHidden);
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onHidden);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
  };
}
