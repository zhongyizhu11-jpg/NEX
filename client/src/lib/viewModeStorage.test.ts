import assert from "node:assert/strict";
import test from "node:test";

import { readStoredViewMode, viewModeStorageKey, writeStoredViewMode } from "./viewModeStorage";

function fakeWindow(mobile: boolean) {
  const store = new Map<string, string>();
  (globalThis as any).window = {
    matchMedia: (query: string) => ({ matches: mobile && query.includes("767") }),
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  };
  return store;
}

test("手机和电脑各记各的视图偏好：手机的 key 带 .mobile，老 key 留给电脑", () => {
  assert.equal(viewModeStorageKey("forwardx.rules.viewMode", false), "forwardx.rules.viewMode");
  assert.equal(viewModeStorageKey("forwardx.rules.viewMode", true), "forwardx.rules.viewMode.mobile");

  const desktop = fakeWindow(false);
  desktop.set("forwardx.rules.viewMode", "table");
  assert.equal(readStoredViewMode("forwardx.rules.viewMode", ["table", "card"], "card"), "table", "升级前存的偏好电脑上照旧");
  writeStoredViewMode("forwardx.rules.viewMode", "card");
  assert.equal(desktop.get("forwardx.rules.viewMode"), "card");
  assert.equal(desktop.has("forwardx.rules.viewMode.mobile"), false);

  const phone = fakeWindow(true);
  phone.set("forwardx.rules.viewMode", "table");
  assert.equal(readStoredViewMode("forwardx.rules.viewMode", ["table", "card"], "card"), "card", "手机不借电脑那份");
  writeStoredViewMode("forwardx.rules.viewMode", "table");
  assert.equal(phone.get("forwardx.rules.viewMode.mobile"), "table");
  assert.equal(phone.get("forwardx.rules.viewMode"), "table", "手机上改不动电脑那份");
  delete (globalThis as any).window;
});
