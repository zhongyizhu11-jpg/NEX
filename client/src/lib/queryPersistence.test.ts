import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { APP_VERSION } from "@shared/versions";
import {
  QUERY_CACHE_MAX_AGE_MS,
  clearPersistedQueryCache,
  containsSensitiveField,
  isPersistablePath,
  queryCacheStorageKey,
  restorePersistedQueryCache,
  resumeQueryCachePersistenceForTests,
  serializeQueryCache,
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
