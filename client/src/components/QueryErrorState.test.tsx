import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import QueryErrorState, { failedQueryState, isQueryFailed } from "./QueryErrorState";

const query = (patch: Partial<{ isError: boolean; error: unknown; data: unknown; isFetching: boolean }>) => {
  const calls = { refetch: 0 };
  return {
    calls,
    isError: false,
    error: null,
    data: undefined,
    isFetching: false,
    refetch: () => {
      calls.refetch += 1;
    },
    ...patch,
  };
};

test("只有失败且手里没有数据才算失败：轮询失败一次、上一轮的数据还在时照常显示数据", () => {
  assert.equal(isQueryFailed(query({ isError: true, error: new Error("x") })), true);
  assert.equal(isQueryFailed(query({ isError: true, error: new Error("x"), data: [] })), false);
  assert.equal(isQueryFailed(query({ isError: false })), false);
  assert.equal(isQueryFailed(null), false);
});

test("一组查询：显示第一条失败的原因，重试时把失败的都重拉", () => {
  const ok = query({ data: 1 });
  const first = query({ isError: true, error: new Error("first") });
  const second = query({ isError: true, error: new Error("second"), isFetching: true });
  assert.equal(failedQueryState(ok, false, null), null);
  const state = failedQueryState(ok, first, false, second)!;
  assert.equal((state.error as Error).message, "first");
  assert.equal(state.retrying, true);
  state.onRetry();
  assert.equal(first.calls.refetch, 1);
  assert.equal(second.calls.refetch, 1);
  assert.equal(ok.calls.refetch, 0);
});

test("出错块说是什么没读到、给重试；一行版本也一样，不是「暂无」", () => {
  const block = renderToStaticMarkup(<QueryErrorState label="插件列表" error={new Error("Failed to fetch")} onRetry={() => {}} />);
  assert.match(block, /插件列表加载失败/);
  assert.match(block, /面板没连上/);
  assert.match(block, /重试/);
  assert.doesNotMatch(block, /暂无/);

  const compact = renderToStaticMarkup(<QueryErrorState compact label="流量走势" error={new Error("boom")} onRetry={() => {}} />);
  assert.match(compact, /role="status"/);
  assert.match(compact, /流量走势加载失败/);
  assert.match(compact, /重试/);
  assert.match(compact, /bg-\[var\(--fx-down-soft\)\]/);
});
