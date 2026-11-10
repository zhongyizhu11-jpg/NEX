import assert from "node:assert/strict";
import test from "node:test";
import { createImpersonationWindow } from "./userImpersonation";
import { IMPERSONATION_ENDED_MESSAGE } from "@shared/userImpersonation";

const TOKEN = `nxu_${"A".repeat(43)}`;

function fakeWindow(hash = "", options: { name?: string; storage?: Record<string, string>; brokenStorage?: boolean } = {}) {
  const storage = new Map(Object.entries(options.storage || {}));
  const replaced: string[] = [];
  const win = {
    location: { hash, pathname: "/rules", search: "?tab=1", href: `https://panel.example.com/rules?tab=1${hash}`, origin: "https://panel.example.com" },
    history: { state: null, replaceState: (_state: unknown, _title: string, next: string) => { replaced.push(next); } },
    name: options.name || "",
    sessionStorage: {
      getItem: (key: string) => { if (options.brokenStorage) throw new Error("denied"); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (options.brokenStorage) throw new Error("denied"); storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  };
  return { win, storage, replaced };
}

function recordingFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url), init });
    return new Response("{}");
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("普通标签页：什么都不变，请求照常带 cookie", async () => {
  const { win } = fakeWindow();
  const entry = createImpersonationWindow(win);
  entry.initialize();
  assert.equal(entry.getState().mode, "normal");
  const { calls, fetchImpl } = recordingFetch();
  await entry.wrapFetch(fetchImpl)("/api/trpc/auth.me", { credentials: "include" });
  assert.equal(calls[0].init?.credentials, "include");
  assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), null);
});

test("代入标签页：令牌立刻从地址栏拿掉，只存在这个标签页里；本站接口带令牌、不带 cookie", async () => {
  const exp = Date.now() + 3_600_000;
  const { win, storage, replaced } = fakeWindow(`#user-session=${TOKEN}&exp=${exp}`);
  const entry = createImpersonationWindow(win);
  entry.initialize();
  assert.deepEqual(entry.getState(), { mode: "active", expiresAt: exp });
  assert.deepEqual(replaced, ["/rules?tab=1"]);
  assert.equal(win.name, "nex-user-impersonation");
  assert.match(String(storage.get("nex.userImpersonation")), new RegExp(TOKEN));

  const { calls, fetchImpl } = recordingFetch();
  const wrapped = entry.wrapFetch(fetchImpl);
  await wrapped("/api/trpc/rules.list", { credentials: "include", headers: { "x-forwardx-mobile": "0" } });
  assert.equal(calls[0].init?.credentials, "omit");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("x-forwardx-mobile"), "0");
  // 别的站点、静态资源不带令牌
  await wrapped("https://cdn.example.com/api/x");
  await wrapped("/assets/app.js");
  assert.equal(new Headers(calls[1].init?.headers).get("Authorization"), null);
  assert.equal(new Headers(calls[2].init?.headers).get("Authorization"), null);

  // 刷新：从 sessionStorage 读回来
  const reload = createImpersonationWindow({ ...win, location: { ...win.location, hash: "" } });
  reload.initialize();
  assert.equal(reload.getState().mode, "active");
});

test("结束后（退出、到期、令牌坏了、存储丢了）所有接口请求直接拒，刷新也不会落回管理员 cookie", async () => {
  const exp = Date.now() + 3_600_000;
  const { win, storage } = fakeWindow(`#user-session=${TOKEN}&exp=${exp}`);
  const entry = createImpersonationWindow(win);
  entry.initialize();
  entry.finish();
  assert.equal(entry.getState().mode, "ended");
  assert.equal(storage.size, 0);
  const { calls, fetchImpl } = recordingFetch();
  await assert.rejects(entry.wrapFetch(fetchImpl)("/api/trpc/auth.me"), { message: IMPERSONATION_ENDED_MESSAGE });
  assert.equal(calls.length, 0);

  // 刷新：窗口名还在、令牌没了 → 仍是「已结束」
  const reload = createImpersonationWindow({ ...win, location: { ...win.location, hash: "" } });
  reload.initialize();
  assert.equal(reload.getState().mode, "ended");
  await assert.rejects(reload.wrapFetch(fetchImpl)("/api/trpc/auth.me"));

  // 过期的、格式不对的
  for (const hash of [`#user-session=${TOKEN}&exp=${Date.now() - 1}`, "#user-session=nxu_short&exp=99999999999999", `#user-session=${TOKEN}`]) {
    const bad = createImpersonationWindow(fakeWindow(hash).win);
    bad.initialize();
    assert.equal(bad.getState().mode, "ended", hash);
  }

  // 存储不可用：本次能用，状态也不会是 normal
  const noStorage = createImpersonationWindow(fakeWindow(`#user-session=${TOKEN}&exp=${exp}`, { brokenStorage: true }).win);
  noStorage.initialize();
  assert.equal(noStorage.getState().mode, "active");

  // 到点自己结束
  let now = Date.now();
  const timed = createImpersonationWindow(fakeWindow(`#user-session=${TOKEN}&exp=${now + 1000}`).win, () => now);
  timed.initialize();
  now += 2000;
  await assert.rejects(timed.wrapFetch(fetchImpl)("/api/trpc/auth.me"));
  assert.equal(timed.getState().mode, "ended");
});
