import assert from "node:assert/strict";
import test from "node:test";
import {
  decideExternalHealth,
  entryMemberInclusion,
  externalHealthLabel,
  planEntryGroupRecordSet,
  readinessGrace,
  type PeerObserverView,
} from "./evaluate";
import { ForwardGroupPeerObservationStore, parseStoredExternalHealth, serializeStoredExternalHealth } from "./peerObservations";

const NOW = 1_800_000_000_000;
const FAILOVER = 60_000;

function observer(patch: Partial<PeerObserverView> & { hostId: number }): PeerObserverView {
  return { online: true, reachable: true, since: NOW - 600_000, everReached: true, crossCheckOk: true, ...patch };
}
const failing = (hostId: number, agoMs: number, patch: Partial<PeerObserverView> = {}) =>
  observer({ hostId, reachable: false, since: NOW - agoMs, ...patch });

test("没有观察点：不下结论，和以前一样只看成员自己", () => {
  const decision = decideExternalHealth({ agentOnline: true, observers: [], failoverMs: FAILOVER, now: NOW });
  assert.equal(decision.state, "none");
  assert.equal(decision.down, false);
  assert.equal(externalHealthLabel(decision), "");
});

test("两个观察点持续连不上满 failoverSeconds：判不可用；没满是观察期", () => {
  const grace = decideExternalHealth({ agentOnline: true, observers: [failing(2, 90_000), failing(3, 30_000), observer({ hostId: 4 })], failoverMs: FAILOVER, now: NOW });
  assert.equal(grace.state, "failing");
  assert.equal(grace.down, false);
  // 凑够两票是第二个观察点开始连不上的那一刻
  assert.equal(grace.failingSince, NOW - 30_000);

  const down = decideExternalHealth({ agentOnline: true, observers: [failing(2, 90_000), failing(3, 61_000), observer({ hostId: 4 })], failoverMs: FAILOVER, now: NOW });
  assert.equal(down.state, "down");
  assert.equal(down.down, true);
  assert.equal(externalHealthLabel(down), "外部观察 1/3 可达");
});

test("三个观察点里只有一个连不上：不够两票，不判", () => {
  const decision = decideExternalHealth({ agentOnline: true, observers: [failing(2, 600_000), observer({ hostId: 3 }), observer({ hostId: 4 })], failoverMs: FAILOVER, now: NOW });
  assert.equal(decision.state, "reachable");
  assert.equal(decision.down, false);
});

test("只有一个可用观察点时，它一票就够（可用的不足两个 = 全部）", () => {
  const decision = decideExternalHealth({ agentOnline: true, observers: [failing(2, 61_000), observer({ hostId: 3, online: false })], failoverMs: FAILOVER, now: NOW });
  assert.equal(decision.votesNeeded, 1);
  assert.equal(decision.state, "down");
});

test("坏掉的观察点不作数：连不上别的成员也连不上参照目标", () => {
  const decision = decideExternalHealth({
    agentOnline: true,
    observers: [failing(2, 600_000, { crossCheckOk: false }), failing(3, 600_000, { crossCheckOk: false })],
    failoverMs: FAILOVER,
    now: NOW,
  });
  assert.equal(decision.state, "inconclusive");
  assert.equal(decision.down, false);
});

test("从没连通过这个成员的观察点不作数（只放行特定来源的防火墙）", () => {
  const decision = decideExternalHealth({
    agentOnline: true,
    observers: [failing(2, 600_000, { everReached: false }), failing(3, 600_000, { everReached: false })],
    failoverMs: FAILOVER,
    now: NOW,
  });
  assert.equal(decision.down, false);
  // 一个作数一个不作数：两个可用观察点要两票，只有一票
  const mixed = decideExternalHealth({ agentOnline: true, observers: [failing(2, 600_000), failing(3, 600_000, { everReached: false })], failoverMs: FAILOVER, now: NOW });
  assert.equal(mixed.down, false);
});

test("离线或结果过期的观察点不算可用", () => {
  const decision = decideExternalHealth({
    agentOnline: true,
    observers: [failing(2, 600_000, { online: false }), observer({ hostId: 3, reachable: null, since: null })],
    failoverMs: FAILOVER,
    now: NOW,
  });
  assert.equal(decision.state, "none");
  assert.equal(externalHealthLabel(decision), "外部观察暂无结果");
});

test("成员 Agent 面板连不上但观察点连得上：继续发布", () => {
  const decision = decideExternalHealth({ agentOnline: false, observers: [observer({ hostId: 2 }), failing(3, 600_000)], failoverMs: FAILOVER, now: NOW });
  assert.equal(decision.state, "reachable");
  assert.equal(decision.reachableWhileAgentOffline, true);
  // 没有观察点连得上：不改结论，调用方照旧按离线处理
  const offline = decideExternalHealth({ agentOnline: false, observers: [failing(2, 10_000), failing(3, 10_000)], failoverMs: FAILOVER, now: NOW });
  assert.equal(offline.reachableWhileAgentOffline, false);
});

test("判了不可用之后要观察点重新连上才解除", () => {
  // 票不作数了（观察点自己出了问题），之前的判定保持
  const held = decideExternalHealth({ agentOnline: true, observers: [failing(2, 600_000, { crossCheckOk: false })], failoverMs: FAILOVER, now: NOW, previouslyDown: true });
  assert.equal(held.down, true);
  // 又凑够票但还没满观察时间：也保持
  const again = decideExternalHealth({ agentOnline: true, observers: [failing(2, 5_000)], failoverMs: FAILOVER, now: NOW, previouslyDown: true });
  assert.equal(again.down, true);
  // 观察点重新连上：解除（之后由调用方按 recoverSeconds 观察）
  const back = decideExternalHealth({ agentOnline: true, observers: [observer({ hostId: 2, since: NOW - 1_000 })], failoverMs: FAILOVER, now: NOW, previouslyDown: true });
  assert.equal(back.down, false);
  assert.equal(back.state, "reachable");
  // 观察点全不可用：解除保持，退回只看成员自己
  const none = decideExternalHealth({ agentOnline: true, observers: [observer({ hostId: 2, online: false })], failoverMs: FAILOVER, now: NOW, previouslyDown: true });
  assert.equal(none.down, false);
  assert.equal(none.state, "none");
});

test("就绪宽限：主机在就绪之后来过、或者沉默满阈值之前都算说不准", () => {
  const readyAt = NOW - 30_000;
  const waiting = readinessGrace({
    readyAt,
    now: NOW,
    hosts: [
      { hostId: 1, lastSeenAt: NOW - 600_000, offlineThresholdMs: 90_000 },
      { hostId: 2, lastSeenAt: NOW - 5_000, offlineThresholdMs: 90_000 },
      { hostId: 3, lastSeenAt: null, offlineThresholdMs: 150_000 },
    ],
  });
  assert.equal(waiting.active, true);
  assert.deepEqual(waiting.waitingHostIds, [1, 3]);
  assert.equal(waiting.until, readyAt + 150_000);
  // 都来过了：宽限结束
  assert.equal(readinessGrace({ readyAt, now: NOW, hosts: [{ hostId: 1, lastSeenAt: NOW - 1_000, offlineThresholdMs: 90_000 }] }).active, false);
  // 沉默满了阈值：也结束（之后按离线处理）
  assert.equal(readinessGrace({ readyAt: NOW - 91_000, now: NOW, hosts: [{ hostId: 1, lastSeenAt: NOW - 600_000, offlineThresholdMs: 90_000 }] }).active, false);
});

const inclusionBase = { failoverMs: FAILOVER, recoverMs: 120_000, now: NOW, observedFailureSince: null, previousFailureSince: null, previousHealthySince: null } as const;

test("入口组成员：恢复后要连续健康满 recoverSeconds 才加回来", () => {
  const first = entryMemberInclusion({ ...inclusionBase, health: "healthy", previouslyIncluded: false, neverFailed: false });
  assert.equal(first.include, false);
  assert.equal(first.holdReason, "recovering");
  assert.equal(first.healthySince, NOW);
  assert.equal(first.recheckAt, NOW + 120_000);
  const later = entryMemberInclusion({ ...inclusionBase, health: "healthy", previouslyIncluded: false, neverFailed: false, previousHealthySince: NOW - 121_000 });
  assert.equal(later.include, true);
  // 机器刚从离线回来：从回来那一刻起算，哪怕 healthySince 更早
  const restored = entryMemberInclusion({ ...inclusionBase, health: "healthy", previouslyIncluded: false, neverFailed: false, previousHealthySince: NOW - 600_000, restoredAt: NOW - 10_000 });
  assert.equal(restored.include, false);
  assert.equal(restored.recheckAt, NOW + 110_000);
});

test("入口组成员：新成员不用等；已在解析里的健康成员一直留着", () => {
  assert.equal(entryMemberInclusion({ ...inclusionBase, health: "healthy", previouslyIncluded: false, neverFailed: true }).include, true);
  assert.equal(entryMemberInclusion({ ...inclusionBase, health: "healthy", previouslyIncluded: true, neverFailed: false }).include, true);
});

test("入口组成员：抖动抑制只压加回来", () => {
  const held = entryMemberInclusion({ ...inclusionBase, health: "healthy", previouslyIncluded: false, neverFailed: false, previousHealthySince: NOW - 600_000, flapHoldUntil: NOW + 200_000 });
  assert.equal(held.include, false);
  assert.equal(held.holdReason, "flap");
  assert.equal(held.recheckAt, NOW + 200_000);
  // 已经在解析里的不受影响
  assert.equal(entryMemberInclusion({ ...inclusionBase, health: "healthy", previouslyIncluded: true, neverFailed: false, flapHoldUntil: NOW + 200_000 }).include, true);
});

test("入口组成员：异常满 failoverSeconds 立刻拿掉，没满留着", () => {
  const grace = entryMemberInclusion({ ...inclusionBase, health: "unhealthy", previouslyIncluded: true, neverFailed: false, observedFailureSince: NOW - 30_000 });
  assert.equal(grace.include, true);
  assert.equal(grace.failedLongEnough, false);
  const removed = entryMemberInclusion({ ...inclusionBase, health: "unhealthy", previouslyIncluded: true, neverFailed: false, observedFailureSince: NOW - 61_000 });
  assert.equal(removed.include, false);
  // 外部观察已经判定：不再等
  const final = entryMemberInclusion({ ...inclusionBase, health: "unhealthy", previouslyIncluded: true, neverFailed: false, observedFailureSince: NOW - 1_000, failureFinal: true });
  assert.equal(final.include, false);
});

test("入口组全挂：保留上一轮发布的整组，不缩成一条", () => {
  assert.deepEqual(planEntryGroupRecordSet({ healthyValues: [], previousValues: ["1.1.1.1", "2.2.2.2", "3.3.3.3"] }), { values: ["1.1.1.1", "2.2.2.2", "3.3.3.3"], mode: "hold-all" });
  // 流量到阈值的主机不保留
  assert.deepEqual(
    planEntryGroupRecordSet({ healthyValues: [], previousValues: ["1.1.1.1", "2.2.2.2"], administrativelyExcludedValues: ["2.2.2.2"] }),
    { values: ["1.1.1.1"], mode: "hold-all" },
  );
  // 全被管理动作排除：清记录
  assert.deepEqual(planEntryGroupRecordSet({ healthyValues: [], previousValues: ["1.1.1.1"], allAdministrativelyExcluded: true }), { values: [], mode: "empty" });
  assert.deepEqual(planEntryGroupRecordSet({ healthyValues: ["1.1.1.1", "1.1.1.1"], previousValues: [] }), { values: ["1.1.1.1"], mode: "healthy" });
  assert.equal(planEntryGroupRecordSet({ healthyValues: [], previousValues: [] }).mode, "none");
});

test("观察结果表：任一端口连得上就算连得上，结论变了才算变化", () => {
  const store = new ForwardGroupPeerObservationStore(150_000);
  const ports = new Set(["tcp:443", "tcp:8443"]);
  assert.equal(store.record({ observerHostId: 2, groupId: 10, memberId: 101, portKey: "tcp:443", ok: false, expectedPorts: ports, now: NOW }), true);
  assert.equal(store.view(2, 10, 101, NOW, ports).reachable, false);
  assert.equal(store.view(2, 10, 101, NOW, ports).everReached, false);
  assert.equal(store.record({ observerHostId: 2, groupId: 10, memberId: 101, portKey: "tcp:8443", ok: true, latencyMs: 12, expectedPorts: ports, now: NOW + 1_000 }), true);
  const view = store.view(2, 10, 101, NOW + 1_000, ports);
  assert.equal(view.reachable, true);
  assert.equal(view.since, NOW + 1_000);
  assert.equal(view.everReached, true);
  assert.equal(view.latencyMs, 12);
  // 同样的结论再报一次不算变化
  assert.equal(store.record({ observerHostId: 2, groupId: 10, memberId: 101, portKey: "tcp:8443", ok: true, expectedPorts: ports, now: NOW + 2_000 }), false);
  // 过期：没有新鲜结果
  assert.equal(store.view(2, 10, 101, NOW + 400_000, ports).reachable, null);
  // 连通过它这件事不过期
  assert.equal(store.view(2, 10, 101, NOW + 400_000, ports).everReached, true);
  // 拓扑里不再有的端口被丢掉
  const only443 = new Set(["tcp:443"]);
  store.record({ observerHostId: 2, groupId: 10, memberId: 101, portKey: "tcp:443", ok: false, expectedPorts: only443, now: NOW + 3_000 });
  assert.equal(store.view(2, 10, 101, NOW + 3_000, only443).reachable, false);
  store.prune(() => false);
  assert.equal(store.size(), 0);
});

test("成员行里的外部观察状态：读写对称，脏数据当空", () => {
  assert.equal(serializeStoredExternalHealth({ down: false, reachedBy: [] }), null);
  const text = serializeStoredExternalHealth({ down: true, reachedBy: [3, 2, 3] });
  assert.deepEqual(parseStoredExternalHealth(text), { down: true, reachedBy: [2, 3] });
  assert.deepEqual(parseStoredExternalHealth("{oops"), { down: false, reachedBy: [] });
  const store = new ForwardGroupPeerObservationStore();
  store.seedEverReached(10, 101, [2], NOW);
  assert.equal(store.view(2, 10, 101, NOW).everReached, true);
  assert.equal(store.view(2, 10, 101, NOW).reachable, null);
});
