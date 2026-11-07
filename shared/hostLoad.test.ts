import assert from "node:assert/strict";
import test from "node:test";

import { hostBandwidthUtilizationPct, hostLoadFromSamples, hostLoadPct, hostNetworkBytesPerSecond, routePathLoadHostIds, routePathLoadPct, type HostLoadSample } from "./hostLoad";

/**
 * 主机负载：CPU 和带宽占用取大。心跳里的 networkIn / networkOut 是累计字节数（计数器），不是速率 ——
 * 直接拿它比带宽会算出几万个百分点；得相邻两次相减、除以间隔。
 */

const sample = (at: number, cpu: number | null, inBytes: number | null, outBytes: number | null): HostLoadSample => ({ at, cpuUsage: cpu, networkIn: inBytes, networkOut: outBytes });

test("带宽速率按计数器相减算：只有一次样本、间隔太短、计数器变小（重启）都算不出", () => {
  const first = sample(0, 10, 1_000_000, 500_000);
  assert.equal(hostNetworkBytesPerSecond(null, first), null, "第一次心跳没有上一份");
  // 10 秒收了 12.5MB：1.25MB/s；发得少，取收的
  const second = sample(10_000, 10, 13_500_000, 600_000);
  assert.equal(hostNetworkBytesPerSecond(first, second), 1_250_000);
  // 发比收多就取发
  assert.equal(hostNetworkBytesPerSecond(first, sample(10_000, 10, 1_000_100, 20_500_000)), 2_000_000);
  assert.equal(hostNetworkBytesPerSecond(first, sample(200, 10, 1_000_100, 500_100)), null, "间隔不到半秒不算");
  assert.equal(hostNetworkBytesPerSecond(first, sample(10_000, 10, 500, 100)), null, "计数器归零（机器重启）这一段算不出");
  assert.equal(hostNetworkBytesPerSecond(first, sample(10_000, 10, null, null)), null, "没报就算不出");
  // 一个方向算不出就只看另一个方向
  assert.equal(hostNetworkBytesPerSecond(first, sample(10_000, 10, null, 600_000)), 10_000);
});

test("带宽占用 = 速率 ÷ 线路带宽；带宽不知道（0）就不算", () => {
  // 1.25MB/s = 10Mbps，100M 的线路就是 10%
  assert.equal(hostBandwidthUtilizationPct(1_250_000, 100), 10);
  assert.equal(hostBandwidthUtilizationPct(12_500_000, 100), 100, "超了按 100");
  assert.equal(hostBandwidthUtilizationPct(1_250_000, 0), null, "没填带宽不算");
  assert.equal(hostBandwidthUtilizationPct(null, 100), null);
  assert.equal(hostBandwidthUtilizationPct(1_250_000, 1000), 1);
});

test("负载取 CPU 和带宽占用里大的；都不知道是 null", () => {
  assert.equal(hostLoadPct(35, 80), 80);
  assert.equal(hostLoadPct(85, 20), 85);
  assert.equal(hostLoadPct(85, null), 85, "带宽不知道只看 CPU");
  assert.equal(hostLoadPct(null, 60), 60);
  assert.equal(hostLoadPct(null, null), null);
  assert.equal(hostLoadPct(140, null), 100, "压到 100");
});

test("相邻两次心跳 → 负载：第一次只有 CPU，第二次起带宽也算；把计数器当速率会算出离谱的数", () => {
  const first = sample(0, 20, 50_000_000_000, 10_000_000_000);
  assert.equal(hostLoadFromSamples(null, first, 100), 20);
  // 10 秒里收了 112.5MB = 90Mbps，100M 线路 → 90%，比 CPU 的 20 高
  const second = sample(10_000, 20, 50_112_500_000, 10_000_000_000);
  assert.equal(hostLoadFromSamples(first, second, 100), 90);
  assert.equal(hostLoadFromSamples(first, second, 0), 20, "没填带宽只看 CPU，累计字节数绝不能直接当百分比");
  assert.equal(hostLoadFromSamples(first, second, 1000), 20, "1G 线路跑 90M 才 9%，CPU 更高");
});

test("一条路径看哪几台：中转 + 落地池成员机；直接写地址的落地不算；取最忙的那台", () => {
  assert.deepEqual(routePathLoadHostIds({ hops: [2, 3] }), [2, 3]);
  assert.deepEqual(routePathLoadHostIds({ hops: [2, 3], destHostId: 7 }), [2, 3, 7]);
  assert.deepEqual(routePathLoadHostIds({ hops: [2], destHostId: 2 }), [2], "落地就是中转那台不重复");
  assert.deepEqual(routePathLoadHostIds({ hops: [] }), []);
  // 「我的节点」：节点是哪台主机上的入站派生的才算（查不到 = 0，不是 NEX 主机上的节点）
  const nodeHost = (nodeId: number) => (nodeId === 31 ? 7 : 0);
  assert.deepEqual(routePathLoadHostIds({ hops: [2], destNodeId: 31 }, nodeHost), [2, 7]);
  assert.deepEqual(routePathLoadHostIds({ hops: [2], destNodeId: 32 }, nodeHost), [2], "不是 NEX 主机上的节点不算");
  assert.deepEqual(routePathLoadHostIds({ hops: [2], destNodeId: 31, destHostId: 9 }, nodeHost), [2, 9], "落地池成员机直接用路径上记的");
  assert.deepEqual(routePathLoadHostIds({ hops: [2], destNodeId: 31 }), [2], "不给查法就不算节点");
  const loads = new Map<number, number | null>([[2, 30], [3, 85], [7, null]]);
  const loadOf = (hostId: number) => loads.get(hostId) ?? null;
  assert.equal(routePathLoadPct({ hops: [2, 3], destHostId: 7 }, loadOf), 85);
  assert.equal(routePathLoadPct({ hops: [2] }, loadOf), 30);
  assert.equal(routePathLoadPct({ hops: [], destHostId: 7 }, loadOf), null, "一台都不知道是 null");
  assert.equal(routePathLoadPct({ hops: [] }, loadOf), null, "直连落地没有主机可看");
  assert.equal(routePathLoadPct({ hops: [2], destNodeId: 31 }, loadOf, () => 3), 85, "「我的节点」在那台忙的主机上");
});
