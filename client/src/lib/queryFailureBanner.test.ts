import assert from "node:assert/strict";
import test from "node:test";

import { NO_QUERY_FAILURES, nextQueryFailures, queryFailureBannerText, queryFailureDetailText, queryKeyPath, sameQueryFailures, shouldShowQueryFailureBanner } from "./queryFailureBanner";

const base = { failureCount: 0, failingSinceMs: 0, dismissedAtCount: 0, now: 100_000 };

test("没有失败就不提示", () => {
  assert.equal(shouldShowQueryFailureBanner(base), false);
  // 有失败数但没有起始时间，是状态没对齐，按不提示处理（宁可漏一次也不要乱弹）。
  assert.equal(shouldShowQueryFailureBanner({ ...base, failureCount: 3 }), false);
});

test("失败刚发生时不提示 —— 轮询抖一下不该闪横幅", () => {
  assert.equal(
    shouldShowQueryFailureBanner({ ...base, failureCount: 2, failingSinceMs: 98_000 }),
    false,
  );
  assert.equal(
    shouldShowQueryFailureBanner({ ...base, failureCount: 2, failingSinceMs: 96_000 }),
    true,
    "持续 4 秒就该说了",
  );
});

test("关掉之后同一批不再弹，新的失败还要说", () => {
  const failing = { ...base, failureCount: 2, failingSinceMs: 90_000, dismissedAtCount: 2 };
  assert.equal(shouldShowQueryFailureBanner(failing), false);
  assert.equal(
    shouldShowQueryFailureBanner({ ...failing, failureCount: 3 }),
    true,
    "又多坏了一项，不能因为关过就永久静音",
  );
});

test("文案把数量说清楚", () => {
  assert.equal(queryFailureBannerText(1), "有 1 项数据没读到，这一页显示的可能不全。");
  assert.match(queryFailureBannerText(5), /有 5 项/);
  // 计数出了偏差也不能写成「有 0 项」。
  assert.match(queryFailureBannerText(0), /有 1 项/);
});

test("第二行写清是哪几项、报的什么错", () => {
  assert.equal(queryKeyPath([["tunnels", "listPage"], { input: {}, type: "query" }]), "tunnels.listPage");
  assert.equal(queryKeyPath(["database-health"]), "database-health");
  assert.equal(queryKeyPath([]), "");
  assert.equal(
    queryFailureDetailText([{ path: "tunnels.listPage", message: "Failed to fetch" }, { path: "hosts.list", message: "" }]),
    "没读到：tunnels.listPage、hosts.list（Failed to fetch）",
  );
  assert.equal(queryFailureDetailText([]), "");
  // 同一路径不同入参只写一次；太长的错误截断
  const long = queryFailureDetailText([{ path: "a.b", message: "x".repeat(200) }, { path: "a.b", message: "y" }]);
  assert.match(long, /^没读到：a\.b（x{120}…）$/);
});

test("失败列表内容没变就沿用旧引用，不然布局每次缓存通知都重渲染（2.3.473 白屏）", () => {
  const a = [{ path: "tunnels.listPage", message: "Failed to fetch" }];
  const same = [{ path: "tunnels.listPage", message: "Failed to fetch" }];
  const different = [{ path: "tunnels.listPage", message: "500" }];
  assert.equal(sameQueryFailures(a, same), true);
  assert.equal(sameQueryFailures(a, different), false);
  assert.equal(sameQueryFailures(a, []), false);
  // 内容相同 → 还是原来的那个数组（React 据此跳过重渲染）；内容变了 → 新数组
  assert.equal(nextQueryFailures(a, same), a);
  assert.equal(nextQueryFailures(a, different), different);
  // 没有失败时永远是同一个空列表：空 → 空 不换引用，有 → 空 换成共享的空列表
  assert.equal(nextQueryFailures(NO_QUERY_FAILURES, []), NO_QUERY_FAILURES);
  assert.equal(nextQueryFailures(a, []), NO_QUERY_FAILURES);
  const empty = nextQueryFailures(NO_QUERY_FAILURES, []);
  assert.equal(nextQueryFailures(empty, []), empty);
});
