import assert from "node:assert/strict";
import test from "node:test";

import { routeSwitchEntries } from "./RouteSwitchTimeline";
import type { RouteEvent } from "@/features/rules/RouteGroupSheet";

/*
  主机详情「线路」页签的切换记录（效果图 ③）：只看文字怎么写，状态给 null（名字用事件自带的）。
*/

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

function event(patch: Partial<RouteEvent>): RouteEvent {
  return {
    id: 1,
    kind: "switch",
    fromKey: null,
    toKey: null,
    fromLabel: "备用线路",
    toLabel: "主线路",
    reason: "score",
    reasonText: "",
    score: 96,
    latencyMs: 2,
    at: NOW - 60_000,
    ...patch,
  };
}

test("整链最优：新 Agent 带着两条整条链的延迟和领先多久 —— 「比 备 1 快 9 ms，持续 2 分钟」", () => {
  const [entry] = routeSwitchEntries([event({ fromChainMs: 40, toChainMs: 31, heldSeconds: 120 })], null, NOW);
  assert.equal(entry.detail, "比 备用线路 快 9 ms，持续 2 分钟");
  assert.equal(entry.tone, "ok");
  assert.equal(entry.manual, false);
});

test("整链最优：老 Agent 没有这两个数，照旧说更优、换过去多少毫秒", () => {
  const [entry] = routeSwitchEntries([event({})], null, NOW);
  assert.equal(entry.detail, "比 备用线路 更优，换过去 2 ms");
});

test("只留切换和人工那几种、近 7 天；新的在前", () => {
  const entries = routeSwitchEntries([
    event({ id: 1, at: NOW - 3_600_000 }),
    event({ id: 2, kind: "unhealthy", at: NOW - 60_000 }),
    event({ id: 3, at: NOW - 8 * 86_400_000 }),
    event({ id: 4, kind: "pinned", reason: "panel: 暂停这条线路", toLabel: "备 2", at: NOW - 120_000 }),
  ], null, NOW);
  assert.deepEqual(entries.map((entry) => entry.key), ["4", "1"]);
  assert.equal(entries[0].manual, true);
});
