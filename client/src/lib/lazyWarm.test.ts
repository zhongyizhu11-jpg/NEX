import assert from "node:assert/strict";
import test from "node:test";
import { warmLazyChunk } from "./lazyWarm";

/*
  预热的三条规矩：同一个 loader 只下一次；省流量模式不下；下失败了下次还能再试。
  Node 里没有 window / navigator，这里按需造一个最小的，用完还原。
*/
type FakeWindow = { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; setTimeout: typeof setTimeout };

// Node 21 起 globalThis.navigator 是只读 getter，直接赋值会抛；用 defineProperty 换掉，用完再放回原来的描述符。
function setGlobal(name: "window" | "navigator", value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function withBrowser(fake: { idle?: boolean; saveData?: boolean }, run: () => Promise<void> | void) {
  const prevWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const idleCalls: Array<{ timeout?: number }> = [];
  setGlobal("window", {
    setTimeout,
    ...(fake.idle === false ? {} : { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => { idleCalls.push({ timeout: opts?.timeout }); cb(); return 1; } }),
  } satisfies FakeWindow);
  setGlobal("navigator", { connection: { saveData: fake.saveData === true } });
  const restoreOne = (name: "window" | "navigator", descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  };
  const restore = () => { restoreOne("window", prevWindow); restoreOne("navigator", prevNavigator); };
  try {
    const out = run();
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(restore).then(() => idleCalls);
    restore();
    return idleCalls;
  } catch (error) {
    restore();
    throw error;
  }
}

test("同一个 loader 反复 warm 只下载一次，而且等的是 1.5 秒上限的空闲回调", async () => {
  let loads = 0;
  const loader = () => { loads += 1; return Promise.resolve({}); };
  const idleCalls = await withBrowser({}, () => {
    warmLazyChunk(loader);
    warmLazyChunk(loader);
    warmLazyChunk(loader);
  });
  assert.equal(loads, 1);
  assert.deepEqual(idleCalls, [{ timeout: 1500 }]);
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
    await new Promise((resolve) => setTimeout(resolve, 300));
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
