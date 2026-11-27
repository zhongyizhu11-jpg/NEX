import assert from "node:assert/strict";
import test from "node:test";
import { warmLazyChunk } from "./lazyWarm";

/*
  预热的三条规矩：同一个 loader 只下一次；省流量模式不下；下失败了下次还能再试。
  Node 里没有 window / navigator，这里按需造一个最小的，用完还原。
*/
type Timer = { delay: number; cb: () => void };

// Node 21 起 globalThis.navigator 是只读 getter，直接赋值会抛；用 defineProperty 换掉，用完再放回原来的描述符。
function setGlobal(name: "window" | "navigator" | "document", value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/*
  最小的浏览器：setTimeout 记下延时、马上跑（测的是「等了多久」，不真等）；readyState 决定页面加载完没有，
  没加载完时 fireLoad() 发 load 事件。
*/
function withBrowser(fake: { idle?: boolean; saveData?: boolean; loaded?: boolean }, run: (env: { fireLoad: () => void; timers: Timer[] }) => Promise<void> | void) {
  const previous = (["window", "navigator", "document"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const idleCalls: Array<{ timeout?: number }> = [];
  const timers: Timer[] = [];
  const loadListeners: Array<() => void> = [];
  const document = { readyState: fake.loaded === false ? "loading" : "complete" };
  setGlobal("window", {
    setTimeout: (cb: () => void, delay = 0) => { timers.push({ delay, cb }); cb(); return timers.length; },
    clearTimeout: () => undefined,
    addEventListener: (type: string, cb: () => void) => { if (type === "load") loadListeners.push(cb); },
    removeEventListener: () => undefined,
    ...(fake.idle === false ? {} : { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => { idleCalls.push({ timeout: opts?.timeout }); cb(); return 1; } }),
  });
  setGlobal("document", document);
  setGlobal("navigator", { connection: { saveData: fake.saveData === true } });
  const fireLoad = () => { document.readyState = "complete"; for (const cb of loadListeners.splice(0)) cb(); };
  const restore = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  try {
    const out = run({ fireLoad, timers });
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(restore).then(() => idleCalls);
    restore();
    return idleCalls;
  } catch (error) {
    restore();
    throw error;
  }
}

test("同一个 loader 反复 warm 只下载一次；页面加载完再等 1.5 秒、浏览器闲下来才下", async () => {
  let loads = 0;
  const loader = () => { loads += 1; return Promise.resolve({}); };
  let delays: number[] = [];
  const idleCalls = await withBrowser({}, ({ timers }) => {
    warmLazyChunk(loader);
    warmLazyChunk(loader);
    warmLazyChunk(loader);
    delays = timers.map((timer) => timer.delay);
  });
  assert.equal(loads, 1);
  assert.deepEqual(delays, [1500]);
  assert.deepEqual(idleCalls, [{ timeout: 1500 }]);
});

test("这一页还没加载完时不下别的（2.3.559：第一次打开时别和这一页的代码、数据抢连接）", async () => {
  let loads = 0;
  const loader = () => { loads += 1; return Promise.resolve({}); };
  await withBrowser({ loaded: false }, ({ fireLoad }) => {
    warmLazyChunk(loader);
    assert.equal(loads, 0, "load 之前一个都不下");
    fireLoad();
    assert.equal(loads, 1);
  });
});

test("省流量模式下不预热", async () => {
  let loads = 0;
  const loader = () => { loads += 1; return Promise.resolve({}); };
  await withBrowser({ saveData: true }, () => { warmLazyChunk(loader); });
  assert.equal(loads, 0);
});

test("没有 requestIdleCallback 的浏览器退回 setTimeout，照样会下", async () => {
  let loads = 0;
  const loader = () => { loads += 1; return Promise.resolve({}); };
  await withBrowser({ idle: false }, async () => {
    warmLazyChunk(loader);
  });
  assert.equal(loads, 1);
});

test("下载失败不算热过：再调一次会重新下", async () => {
  let loads = 0;
  const loader = () => { loads += 1; return loads === 1 ? Promise.reject(new Error("offline")) : Promise.resolve({}); };
  await withBrowser({}, async () => {
    warmLazyChunk(loader);
    await new Promise((resolve) => setImmediate(resolve));
    warmLazyChunk(loader);
  });
  assert.equal(loads, 2);
});
