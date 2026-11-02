import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { APP_VERSION } from "@shared/versions";
import {
  QUERY_CACHE_MAX_AGE_MS,
  clearPersistedQueryCache,
  containsSensitiveField,
  isLivePollingPath,
  isPersistablePath,
  queryCacheStorageKey,
  restorePersistedQueryCache,
  resumeQueryCachePersistenceForTests,
  serializeQueryCache,
  startQueryCachePersistence,
} from "./queryPersistence";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const trpcKey = (path: string) => [path.split("."), { type: "query" }];

test("only list and overview data is written, and never a result carrying secrets", () => {
  const client = new QueryClient();
  client.setQueryData(trpcKey("rules.list"), [{ id: 1, name: "广港us", updatedAt: new Date("2026-10-10T00:00:00Z") }]);
  client.setQueryData(trpcKey("auth.me"), { id: 1, role: "admin" });
  client.setQueryData(trpcKey("hosts.list"), [{ id: 3, name: "Jinx", agentToken: "abc" }]);
  client.setQueryData(trpcKey("telegram.settings"), { enabled: true });
  client.setQueryData(trpcKey("system.publicInfo"), { siteTitle: "NEX" });
  client.setQueryData(trpcKey("system.getSettings"), { aiApiKey: "sk-x" });

  const saved = superjson.parse<any>(serializeQueryCache(client));
  const paths = saved.state.queries.map((query: any) => query.queryKey[0].join(".")).sort();
  assert.deepEqual(paths, ["auth.me", "rules.list", "system.publicInfo"]);
  assert.equal(saved.version, APP_VERSION);
});

test("a saved cache paints immediately, keeps dates, and is refreshed on mount", () => {
  const storage = memoryStorage();
  const source = new QueryClient();
  source.setQueryData(trpcKey("rules.list"), [{ id: 1, updatedAt: new Date("2026-10-10T00:00:00Z") }]);
  storage.setItem(queryCacheStorageKey(), serializeQueryCache(source));

  const client = new QueryClient();
  assert.equal(restorePersistedQueryCache(client, { storage }), 1);
  const rules = client.getQueryData<any[]>(trpcKey("rules.list"));
  assert.ok(rules?.[0].updatedAt instanceof Date);
  assert.equal(client.getQueryState(trpcKey("rules.list"))?.isInvalidated, true);
});

test("an expired cache, another panel version or a broken entry is dropped", () => {
  const storage = memoryStorage();
  const source = new QueryClient();
  source.setQueryData(trpcKey("rules.list"), [{ id: 1 }]);
  const now = Date.now();
  storage.setItem(queryCacheStorageKey(), serializeQueryCache(source, now - QUERY_CACHE_MAX_AGE_MS - 1));
  assert.equal(restorePersistedQueryCache(new QueryClient(), { storage, now }), 0);
  assert.equal(storage.getItem(queryCacheStorageKey()), null);

  storage.setItem("forwardx.queryCache.v1:2.0.0:web", serializeQueryCache(source));
  assert.equal(restorePersistedQueryCache(new QueryClient(), { storage }), 0);
  assert.equal(storage.length, 0);

  storage.setItem(queryCacheStorageKey(), "{not json");
  assert.equal(restorePersistedQueryCache(new QueryClient(), { storage }), 0);
  assert.equal(storage.length, 0);
});

test("each panel in the app keeps its own cache, and logging out clears all of them", () => {
  const storage = memoryStorage();
  const source = new QueryClient();
  source.setQueryData(trpcKey("hosts.list"), [{ id: 1 }]);
  storage.setItem(queryCacheStorageKey("https://a.example"), serializeQueryCache(source));
  assert.equal(restorePersistedQueryCache(new QueryClient(), { storage, scope: "https://b.example" }), 0);
  assert.equal(restorePersistedQueryCache(new QueryClient(), { storage, scope: "https://a.example" }), 1);

  storage.setItem("unrelated", "keep");
  clearPersistedQueryCache(storage);
  resumeQueryCachePersistenceForTests();
  assert.deepEqual(Array.from(storage.map.keys()), ["unrelated"]);
});

test("path allowlist and secret detection", () => {
  assert.equal(isPersistablePath("dashboard.health"), true);
  assert.equal(isPersistablePath("auth.me"), true);
  assert.equal(isPersistablePath("auth.sessions"), false);
  assert.equal(isPersistablePath("proxySubscriptions.list"), false);
  assert.equal(containsSensitiveField([{ nested: { apiKey: "x" } }]), true);
  assert.equal(containsSensitiveField([{ token: null, password: "" }]), false);
  assert.equal(containsSensitiveField({ maxProxySubTokens: 0, hasPassword: true }), false);
  assert.equal(containsSensitiveField({ credentials: { user: "a" } }), true);
  assert.equal(containsSensitiveField({ name: "rule", at: new Date() }), false);
});

test("live polling endpoints and logs are not persisted", () => {
  assert.equal(isPersistablePath("hosts.list"), true);
  assert.equal(isPersistablePath("hosts.summary"), false);
  assert.equal(isPersistablePath("hosts.pageLive"), false);
  assert.equal(isPersistablePath("rules.trafficSummary"), false);
  assert.equal(isPersistablePath("tunnels.latencySparkBatch"), false);
  assert.equal(isPersistablePath("hosts.hostLogs"), false);
  assert.equal(isLivePollingPath("ops.hostLogs.poll"), true);
  assert.equal(isLivePollingPath("system.panelLogs"), true);
  assert.equal(isLivePollingPath("rules.catalog"), false);

  const client = new QueryClient();
  client.setQueryData(trpcKey("hosts.list"), [{ id: 1 }]);
  client.setQueryData(trpcKey("hosts.summary"), { online: 3 });
  client.setQueryData(trpcKey("rules.trafficSummary"), { rate: 1 });
  const saved = superjson.parse<any>(serializeQueryCache(client));
  assert.deepEqual(saved.state.queries.map((query: any) => query.queryKey[0].join(".")), ["hosts.list"]);
});

test("the payload built from per-query strings round-trips like a plain superjson dump", () => {
  const client = new QueryClient();
  const shared = { k: 1 };
  client.setQueryData(trpcKey("rules.list"), [{ id: 1, at: new Date("2026-10-10T00:00:00Z"), tags: new Set(["a"]), a: shared, b: shared }]);
  client.setQueryData(trpcKey("hosts.list"), [{ id: 2, at: new Date("2026-10-11T00:00:00Z"), "x.y": new Map([[1, 2]]), gone: undefined }]);
  client.setQueryData(trpcKey("auth.me"), { id: 1 });
  const raw = serializeQueryCache(client, 123);
  const saved = superjson.parse<any>(raw);
  assert.equal(saved.savedAt, 123);
  assert.equal(saved.version, APP_VERSION);
  const byPath = new Map<string, any>(saved.state.queries.map((query: any) => [query.queryKey[0].join("."), query]));
  const rule = byPath.get("rules.list").state.data[0];
  assert.ok(rule.at instanceof Date);
  assert.ok(rule.tags instanceof Set && rule.tags.has("a"));
  assert.equal(rule.a, rule.b);
  const host = byPath.get("hosts.list").state.data[0];
  assert.ok(host.at instanceof Date);
  assert.ok(host["x.y"] instanceof Map && host["x.y"].get(1) === 2);
  assert.ok("gone" in host && host.gone === undefined);

  // 没有任何注解时也是合法的 superjson
  const plain = new QueryClient();
  plain.setQueryData(trpcKey("auth.me"), { id: 1 });
  assert.equal(superjson.parse<any>(serializeQueryCache(plain)).state.queries.length, 1);
  const empty = superjson.parse<any>(serializeQueryCache(new QueryClient()));
  assert.deepEqual(empty.state, { mutations: [], queries: [] });
});

test("saves are throttled to once per 30 s, and hiding the page saves right away", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000_000;
  const storage = memoryStorage();
  let writes = 0;
  const countingStorage = {
    get length() {
      return storage.length;
    },
    key: storage.key,
    getItem: storage.getItem,
    removeItem: storage.removeItem,
    setItem: (key: string, value: string) => {
      writes += 1;
      storage.setItem(key, value);
    },
  };
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = "visible";
  const previousDocument = (globalThis as any).document;
  (globalThis as any).document = doc;
  resumeQueryCachePersistenceForTests();
  const client = new QueryClient();
  const stop = startQueryCachePersistence(client, { storage: countingStorage, now: () => now });
  const advance = (ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  try {
    client.setQueryData(trpcKey("rules.list"), [{ id: 1 }]);
    assert.equal(writes, 0);
    advance(1_500);
    assert.equal(writes, 1, "first result is saved shortly after");

    // 之后一直有新结果：30 秒内只存一次
    for (let i = 0; i < 10; i += 1) {
      client.setQueryData(trpcKey("rules.list"), [{ id: i }]);
      advance(2_000);
    }
    assert.equal(writes, 1);
    advance(10_000);
    assert.equal(writes, 2);

    // 实时接口的新结果不触发保存
    client.setQueryData(trpcKey("hosts.summary"), { online: 1 });
    advance(60_000);
    assert.equal(writes, 2);

    // 切到后台：有没存的立刻存
    client.setQueryData(trpcKey("rules.list"), [{ id: 99 }]);
    assert.equal(writes, 2);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(writes, 3);
    const saved = superjson.parse<any>(storage.getItem(queryCacheStorageKey())!);
    assert.equal(saved.state.queries[0].state.data[0].id, 99);
    // 没有新变化时再隐藏一次、再等也不写
    doc.dispatchEvent(new Event("visibilitychange"));
    advance(60_000);
    assert.equal(writes, 3);
  } finally {
    stop();
    (globalThis as any).document = previousDocument;
  }
});
