import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PROXY_SUB_SOURCE_SYNC_QUEUED_TEXT,
  PROXY_SUB_SOURCE_SYNC_RUNNING_TEXT,
  proxySubSourceCreateToast,
  proxySubSourceSyncToast,
} from "./proxySubSourceSyncToast";

const done = { ok: true, added: 2, updated: 1, removed: 0, unchanged: false, nodeCount: 12 };

test("跑完了：照旧念计数 / 没变化 / 失败", () => {
  assert.deepEqual(proxySubSourceSyncToast(done), { tone: "success", text: "同步完成：+2 更新 1 移除 0" });
  assert.deepEqual(proxySubSourceSyncToast({ ...done, status: "done" }), { tone: "success", text: "同步完成：+2 更新 1 移除 0" });
  assert.deepEqual(proxySubSourceSyncToast({ ...done, unchanged: true }), { tone: "success", text: "上游没变化" });
  assert.deepEqual(proxySubSourceSyncToast({ ...done, ok: false, error: "上游返回 502" }), { tone: "error", text: "拉取失败：上游返回 502" });
  assert.deepEqual(proxySubSourceCreateToast(done), { tone: "success", text: "已添加，同步到 12 个节点" });
  assert.deepEqual(proxySubSourceCreateToast({ ...done, ok: false, error: "上游返回 502" }), { tone: "warning", text: "已添加，但第一次拉取失败：上游返回 502" });
});

test("正在跑 / 排队了：不念零计数，说清楚这次没拉", () => {
  // 服务端这两种都回 ok: true 和零计数，照老逻辑会念「同步完成：+0 更新 0 移除 0」
  const zero = { ok: true, added: 0, updated: 0, removed: 0, unchanged: false, nodeCount: 12 };
  assert.deepEqual(proxySubSourceSyncToast({ ...zero, status: "running" }), { tone: "info", text: PROXY_SUB_SOURCE_SYNC_RUNNING_TEXT });
  assert.deepEqual(proxySubSourceSyncToast({ ...zero, status: "queued" }), { tone: "info", text: PROXY_SUB_SOURCE_SYNC_QUEUED_TEXT });
  assert.equal(PROXY_SUB_SOURCE_SYNC_RUNNING_TEXT, "这个源正在同步，稍后刷新看结果");
  assert.equal(PROXY_SUB_SOURCE_SYNC_QUEUED_TEXT, "已排队，同步会在后台完成");
  assert.equal(proxySubSourceCreateToast({ ...zero, status: "running" }).text, `已添加，${PROXY_SUB_SOURCE_SYNC_RUNNING_TEXT}`);
  assert.equal(proxySubSourceCreateToast({ ...zero, status: "queued" }).text, `已添加，${PROXY_SUB_SOURCE_SYNC_QUEUED_TEXT}`);
});

test("外部订阅那一块的两个 mutation 都走这份提示，不再各自拼字符串", () => {
  const source = fs.readFileSync(new URL("./ProxySubSourcesSection.tsx", import.meta.url), "utf8");
  assert.match(source, /proxySubSourceCreateToast\(result\.sync\)/);
  assert.match(source, /proxySubSourceSyncToast\(result\)/);
  assert.doesNotMatch(source, /同步完成：\+\$\{/, "计数那句只在 helper 里写一份");
});
