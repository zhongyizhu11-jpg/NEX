import { useEffect, useRef } from "react";

/*
  按需加载的弹窗，第一次点开才去下它的那块 JS：100 ms 往返的网络上多等 300–600 ms，
  200–300 ms 往返上就是 1–2 秒，而且 Suspense 的占位是空的，看起来像点了没反应。

  这里把那块 JS 在页面画完、浏览器闲下来之后先拉回来放进缓存：动态 import() 同一个模块
  用的是同一份缓存，等用户真点开时 React.lazy 再 import 一次就是同步命中。

  和 pages/routeChunks.ts 的页面预取是同一个思路，只是对象换成了页面里的弹窗。
*/

export type LazyLoader = () => Promise<unknown>;

/** 每个 loader 只热一次：热过（或正在热）就不再排队。按函数引用去重，所以 loader 要写成模块级常量，别在渲染里现建。 */
const warmedLoaders = new WeakSet<LazyLoader>();

type IdleWindow = {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

/** 省流量模式下不预取：用户明说了别多下东西。 */
function saveDataRequested(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/** 等浏览器闲下来再跑；最多等 1.5 秒（一直忙也得下，否则用户点开照样等）。没有 requestIdleCallback 的浏览器退回 setTimeout。 */
function runWhenIdle(callback: () => void) {
  if (typeof window === "undefined") return;
  const idle = (window as unknown as IdleWindow).requestIdleCallback;
  if (typeof idle === "function") idle(callback, { timeout: 1500 });
  else window.setTimeout(callback, 200);
}

/**
 * 把一块懒加载的 JS 先拉下来。重复调用同一个 loader 不会再下；下载失败就当没热过（下次还能再试，
 * 真点开时 React.lazy 也会自己再下一次）。
 */
export function warmLazyChunk(loader: LazyLoader): void {
  if (warmedLoaders.has(loader)) return;
  if (saveDataRequested()) return;
  warmedLoaders.add(loader);
  runWhenIdle(() => {
    loader().catch(() => {
      // 网络抖一下没取到：忘掉这一次，下一个页面再调 warm 时重新下
      warmedLoaders.delete(loader);
    });
  });
}

/**
 * 页面挂上、画完第一帧之后，把它拥有的几个弹窗的 JS 先热起来。
 * loaders 列表可以随权限变（比如管理员才多热一个弹窗）：每次渲染只补新出现的那几个，热过的不重复。
 */
export function useWarmLazyChunks(loaders: readonly LazyLoader[]): void {
  const seenRef = useRef(new WeakSet<LazyLoader>());
  useEffect(() => {
    for (const loader of loaders) {
      if (seenRef.current.has(loader)) continue;
      seenRef.current.add(loader);
      warmLazyChunk(loader);
    }
  });
}
