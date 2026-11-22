import assert from "node:assert/strict";
import test from "node:test";

import { smoothHostLoad, clearHostLoadForTest, ensureLandingNodeHosts, hostLoadPctOf, landingNodeHostId, nextHostLoadHint, recordHostLoadSample, routePathLoadHint } from "./hostLoad";

/**
 * 心跳记进来的主机负载：第一次只有 CPU，第二次起带宽占用也算；太久没心跳就不算知道；
 * 下发给 Agent 的 loadPct 是路径沿途最忙那台、取整，一台都不知道是 0（不带）。
 */

test("两次心跳算出带宽占用；太久没心跳就不再当成知道", () => {
  clearHostLoadForTest();
  const t0 = 1_700_000_000_000;
  recordHostLoadSample(5, { at: t0, cpuUsage: 12, networkIn: 1_000_000_000, networkOut: 0 }, 100, t0);
  assert.equal(hostLoadPctOf(5, t0), 12, "第一次只有 CPU");
  // 10 秒收 112.5MB = 90Mbps → 100M 线路 90%
  recordHostLoadSample(5, { at: t0 + 10_000, cpuUsage: 12, networkIn: 1_112_500_000, networkOut: 0 }, 100, t0 + 10_000);
  assert.equal(hostLoadPctOf(5, t0 + 10_000), 90);
  assert.equal(hostLoadPctOf(5, t0 + 10_000 + 6 * 60_000), null, "五分钟没心跳就不知道了");
  assert.equal(hostLoadPctOf(6, t0), null, "没见过的主机不知道");
  // 隔了很久再来一次心跳：不和旧样本相减（那段流量平均到几分钟上没意义），只看 CPU
  recordHostLoadSample(5, { at: t0 + 20 * 60_000, cpuUsage: 40, networkIn: 9_000_000_000, networkOut: 0 }, 100, t0 + 20 * 60_000);
  assert.equal(hostLoadPctOf(5, t0 + 20 * 60_000), 40);
});

test("路径的 loadPct：沿途中转和落地成员机里最忙的那台，取整；不知道是 0", () => {
  clearHostLoadForTest();
  const t0 = 1_700_000_000_000;
  recordHostLoadSample(2, { at: t0, cpuUsage: 33.4, networkIn: null, networkOut: null }, 0, t0);
  recordHostLoadSample(3, { at: t0, cpuUsage: 84.6, networkIn: null, networkOut: null }, 0, t0);
  assert.equal(routePathLoadHint({ hops: [2, 3] }, t0), 85);
  assert.equal(routePathLoadHint({ hops: [2] }, t0), 33);
  assert.equal(routePathLoadHint({ hops: [2], destHostId: 3 }, t0), 85, "落地池成员机也算");
  assert.equal(routePathLoadHint({ hops: [] }, t0), 0, "直连落地没有主机");
  assert.equal(routePathLoadHint({ hops: [9] }, t0), 0, "没心跳过的中转不知道");
});

test("落地是「我的节点」：节点在哪台 NEX 主机上一次查齐、缓存一分钟；不是 NEX 主机上的节点不算；查失败先用上一次的", async () => {
  clearHostLoadForTest();
  const t0 = 1_700_000_000_000;
  recordHostLoadSample(4, { at: t0, cpuUsage: 91, networkIn: null, networkOut: null }, 0, t0);
  const asked: number[][] = [];
  const loader = async (ids: number[]) => {
    asked.push(ids);
    return new Map(ids.filter((id) => id === 31).map((id) => [id, 4] as [number, number]));
  };
  await ensureLandingNodeHosts([31, 32, 31, 0], loader, t0);
  assert.deepEqual(asked, [[31, 32]], "去重、只查有效的 id");
  assert.equal(landingNodeHostId(31), 4);
  assert.equal(routePathLoadHint({ hops: [], destNodeId: 31 }, t0), 91, "落地那台的负载算进来");
  assert.equal(routePathLoadHint({ hops: [], destNodeId: 32 }, t0), 0, "不是 NEX 主机上的节点不算");
  assert.equal(routePathLoadHint({ hops: [], destNodeId: 31, destHostId: 5 }, t0), 0, "落地池成员机用路径上记的那台（5 没心跳过）");
  await ensureLandingNodeHosts([31, 32], loader, t0 + 30_000);
  assert.equal(asked.length, 1, "一分钟内不再查，查不到的也缓存");
  await ensureLandingNodeHosts([31], async () => { throw new Error("db down"); }, t0 + 61_000);
  assert.equal(landingNodeHostId(31), 4, "刷新查失败先用上一次的");
  await ensureLandingNodeHosts([31], loader, t0 + 62_000);
  assert.deepEqual(asked.at(-1), [31], "查失败没缓存，下一次心跳接着查");
});

test("下发的负载先按一分钟平滑再过回差：单次尖峰不下发，持续高才算高；差不到 10 个点、5 分钟内不换", () => {
  clearHostLoadForTest();
  const t0 = 1_700_000_000_000;
  const beat = (hostId: number, offsetMs: number, cpuUsage: number | null) => recordHostLoadSample(hostId, { at: t0 + offsetMs, cpuUsage, networkIn: null, networkOut: null }, 0, t0 + offsetMs);
  const hint = (hostId: number, offsetMs: number) => routePathLoadHint({ hops: [hostId] }, t0 + offsetMs);
  beat(8, 0, 40.4);
  assert.equal(hint(8, 0), 40);
  beat(8, 10_000, 47);
  assert.equal(hostLoadPctOf(8, t0 + 10_000), 47, "实际负载照实记");
  assert.equal(hint(8, 10_000), 40, "平滑后 41：差不到 10 个点，还给上次那个数");
  /*
    用户面板 2026-11-22：Jinx(29.9y) 一核、平均负载 0.01，一次心跳 CPU 读出 89 → 线路组上「负载 84%」挂了很久。
    一次尖峰平滑后只抬几个点，不下发；下一次回到 2 又落回去。
  */
  beat(8, 20_000, 89);
  assert.equal(hostLoadPctOf(8, t0 + 20_000), 89);
  assert.equal(hint(8, 20_000), 40, "单次尖峰：平滑后 49，差不到 10 个点，不下发");
  beat(8, 30_000, 2);
  assert.equal(hint(8, 30_000), 40);
  // 真的一直高：每 30 秒一次 90，三分钟后平滑值过 80，下发的跟上
  for (let i = 0; i <= 6; i += 1) beat(9, i * 30_000, 90);
  assert.ok(hint(9, 180_000) >= 80, `持续高才算高：${hint(9, 180_000)}`);
  // 离线了一阵再回来：不拿旧的平滑值，按这一次的重新算；隔了 5 分钟回差也放行
  beat(8, 30_000 + 6 * 60_000, 2);
  assert.equal(hint(8, 30_000 + 6 * 60_000), 2);
  beat(8, 30_000 + 6 * 60_000 + 10_000, null);
  assert.equal(hint(8, 30_000 + 6 * 60_000 + 10_000), 0, "什么都没报：不知道，不带");

  // 纯函数：一样的数原样返回（不刷新时间），越界的夹到 0–100
  const previous = { pct: 60, at: t0 };
  assert.equal(nextHostLoadHint(previous, 60.3, t0 + 10 * 60_000), previous);
  assert.deepEqual(nextHostLoadHint(null, 130, t0), { pct: 100, at: t0 });
  assert.equal(nextHostLoadHint(previous, null, t0), null);
  // 平滑本身：30 秒的间隔吃掉 39%；这一次没报就是不知道
  assert.equal(smoothHostLoad({ pct: 10, at: t0 }, 90, t0 + 30_000), 41.5);
  assert.equal(smoothHostLoad({ pct: 10, at: t0 }, null, t0 + 30_000), null);
  assert.equal(smoothHostLoad(null, 90, t0), 90);
});
