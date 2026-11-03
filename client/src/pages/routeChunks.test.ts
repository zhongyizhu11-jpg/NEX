import assert from "node:assert/strict";
import test from "node:test";
import { lazyRoute, prefetchRoute, routeChunks, shouldSkipIdlePrefetch } from "./routeChunks";

test("省流量或 3G 及以下不做空闲批量预取，其余照常", () => {
  assert.equal(shouldSkipIdlePrefetch(undefined), false, "不支持 navigator.connection 的浏览器照常预取");
  assert.equal(shouldSkipIdlePrefetch({ effectiveType: "4g" }), false);
  assert.equal(shouldSkipIdlePrefetch({ effectiveType: "4g", saveData: true }), true);
  for (const effectiveType of ["slow-2g", "2g", "3g"]) {
    assert.equal(shouldSkipIdlePrefetch({ effectiveType }), true, effectiveType);
  }
});

/**
 * 预取还在路上时用户就点了：navigateAfterPrefetch 要等的是**那一次**下载。
 * 原来的实现只记「取过了」，第二次调用回一个已经 resolve 的空 promise，
 * 于是立刻换页，Suspense 照样先转一圈。
 */
test("在路上的预取，再调一次拿到的是同一个 promise，不会提前 resolve", async () => {
  let loads = 0;
  let finish: () => void = () => undefined;
  routeChunks["/__test-inflight"] = () => {
    loads += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  };
  try {
    const first = prefetchRoute("/__test-inflight");
    const second = prefetchRoute("/__test-inflight");
    assert.ok(first);
    assert.equal(second, first);
    assert.equal(loads, 1);

    let settled = false;
    void second!.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "包还没到就不能算好了");

    finish();
    await second;
    assert.equal(settled, true);
    assert.equal(prefetchRoute("/__test-inflight"), first, "到了以后再调，还是同一个、已经 resolve 的 promise");
    assert.equal(loads, 1);
  } finally {
    delete routeChunks["/__test-inflight"];
  }
});

test("下载失败的那一次会被忘掉，下次预取重新下", async () => {
  let loads = 0;
  routeChunks["/__test-retry"] = () => {
    loads += 1;
    return loads === 1 ? Promise.reject(new Error("offline")) : Promise.resolve();
  };
  try {
    await prefetchRoute("/__test-retry");
    await prefetchRoute("/__test-retry");
    assert.equal(loads, 2);
  } finally {
    delete routeChunks["/__test-retry"];
  }
});

test("没登记的路径不预取", () => {
  assert.equal(prefetchRoute("/__not-a-route"), undefined);
});

/**
 * 预取到手之后，lazyRoute 同步渲染，不再经过 Suspense：React.lazy 第一次渲染必挂起，
 * 挂起提交的 fallback 又会让内容被节流 300ms，第一次点进转发规则就是这样白等的。
 */
test("lazyRoute：包到了就同步渲染出页面组件，不挂起", async () => {
  const Page = () => null;
  routeChunks["/__test-loaded"] = () => Promise.resolve({ default: Page });
  try {
    const Route = lazyRoute("/__test-loaded");
    await prefetchRoute("/__test-loaded");
    const element = (Route as (props: Record<string, unknown>) => { type: unknown; props: Record<string, unknown> })({ mode: "admin" });
    assert.equal(element.type, Page);
    assert.equal(element.props.mode, "admin");
  } finally {
    delete routeChunks["/__test-loaded"];
  }
});

test("lazyRoute：上一次下载失败，渲染时把错误抛给 ErrorBoundary，再渲染就重新下", async () => {
  let loads = 0;
  routeChunks["/__test-failed"] = () => {
    loads += 1;
    return Promise.reject(new Error("offline"));
  };
  try {
    const Route = lazyRoute("/__test-failed") as (props: Record<string, unknown>) => unknown;
    await prefetchRoute("/__test-failed");
    assert.throws(() => Route({}), /offline/);
    assert.equal(loads, 1);
    // 错误抛过一次就清掉：下一次渲染会重新发起下载（这里只验证它重新下了，挂起本身要在 React 里才能测）
    assert.throws(() => Route({}), (error: unknown) => !(error instanceof Error && error.message === "offline"));
    assert.equal(loads, 2);
  } finally {
    delete routeChunks["/__test-failed"];
  }
});
