import assert from "node:assert/strict";
import test from "node:test";
import { ForwardGroupPeerObservationStore, PEER_OBSERVATION_TTL_MS } from "./peerObservations";

/*
  外部观察的结果表（peerObservations.ts）。评审 F8：观察点报「连不上」之后断了一阵（结果过期），回来再报
  「连不上」时，这段「连不上」要从回来那一刻算 —— 以前沿用断之前的 since，回来第一份报告就像已经连不上了
  很久，入口当场被判不可用。
*/
test("观察点过期后回来、结论和过期前一样：since 从回来那一刻算", () => {
  const store = new ForwardGroupPeerObservationStore();
  const t0 = 1_000_000;
  store.record({ observerHostId: 9, groupId: 1, memberId: 2, portKey: "tcp:443", ok: false, now: t0 });
  assert.equal(store.view(9, 1, 2, t0 + 10_000).since, t0);
  // 观察点离线了很久（结果过期）
  const back = t0 + PEER_OBSERVATION_TTL_MS + 600_000;
  assert.equal(store.view(9, 1, 2, back - 1).reachable, null);
  const changed = store.record({ observerHostId: 9, groupId: 1, memberId: 2, portKey: "tcp:443", ok: false, now: back });
  assert.equal(changed, true, "从「没有结论」变成「连不上」是一次变化，要重新评估");
  const view = store.view(9, 1, 2, back + 1_000);
  assert.equal(view.reachable, false);
  assert.equal(view.since, back, "沿用了过期之前的 since：回来第一份报告就像已经连不上很久");
});

test("没过期的连续报告：since 不动；结论翻转时更新", () => {
  const store = new ForwardGroupPeerObservationStore();
  const t0 = 2_000_000;
  store.record({ observerHostId: 9, groupId: 1, memberId: 2, portKey: "tcp:443", ok: false, now: t0 });
  assert.equal(store.record({ observerHostId: 9, groupId: 1, memberId: 2, portKey: "tcp:443", ok: false, now: t0 + 60_000 }), false);
  assert.equal(store.view(9, 1, 2, t0 + 61_000).since, t0);
  assert.equal(store.record({ observerHostId: 9, groupId: 1, memberId: 2, portKey: "tcp:443", ok: true, now: t0 + 120_000 }), true);
  assert.equal(store.view(9, 1, 2, t0 + 121_000).since, t0 + 120_000);
});
