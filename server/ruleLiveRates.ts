import { setBoundedMapValue } from "./boundedCache";

/*
  规则此刻的速率：↓ 15.1 kB/s ↑ 1.2 kB/s。

  面板只存字节数的历史（traffic_stats，按分钟桶），「现在跑多快」从来没算过：线路板上每一跳
  要写速率，总不能让界面拿两个分钟桶相减。Agent 每隔几秒报一次这段时间的增量字节
  （/api/agent/traffic），这里按「增量 ÷ 距上次上报的秒数」算一次速率，折半平均一下
  （(上次 + 这次) / 2，honk 的 URLTest 也这么算延迟）免得数字一跳一跳的。

  只留内存：速率过 90 秒没新上报就当没有（Agent 掉线、规则停了）。一条规则可能两台机器都
  报（隧道的入口和出口各报一份），按机器分开记，读的时候取最大的那份 —— 两边报的是同一股
  流量，不能加起来。
*/

export type RuleLiveRate = {
  /** 字节/秒 */
  inBps: number;
  outBps: number;
  connections: number;
  /** Unix 毫秒，最近一次上报 */
  at: number;
};

/** measured：已经有两次上报、算出过速率。只有一次上报的那份不算数，读的时候跳过。 */
type HostSample = RuleLiveRate & { hostId: number; measured: boolean };

const STALE_MS = 90_000;
/** 两次上报间隔短于这个数不算速率（时钟抖动、重发），只把字节记到下一次。 */
const MIN_INTERVAL_MS = 500;
const MAX_RULES = 20_000;

const samplesByRule = new Map<number, Map<number, HostSample & { pendingIn: number; pendingOut: number }>>();

export function recordRuleTrafficSample(input: {
  ruleId: number;
  hostId: number;
  bytesIn: number;
  bytesOut: number;
  connections?: number;
  nowMs?: number;
}) {
  const ruleId = Math.floor(Number(input.ruleId));
  const hostId = Math.floor(Number(input.hostId));
  if (!(ruleId > 0) || !(hostId > 0)) return;
  const nowMs = input.nowMs ?? Date.now();
  const bytesIn = Math.max(0, Number(input.bytesIn) || 0);
  const bytesOut = Math.max(0, Number(input.bytesOut) || 0);
  const connections = Math.max(0, Math.floor(Number(input.connections) || 0));
  let hosts = samplesByRule.get(ruleId);
  if (!hosts) {
    hosts = new Map();
    setBoundedMapValue(samplesByRule, ruleId, hosts, MAX_RULES);
  }
  const previous = hosts.get(hostId);
  if (!previous || nowMs - previous.at > STALE_MS) {
    // 第一次（或断了很久）：不知道这些字节是多长时间里跑的，先记下来，下一次才算得出速率。
    hosts.set(hostId, { hostId, measured: false, inBps: 0, outBps: 0, connections, at: nowMs, pendingIn: 0, pendingOut: 0 });
    return;
  }
  const elapsedMs = nowMs - previous.at;
  if (elapsedMs < MIN_INTERVAL_MS) {
    previous.pendingIn += bytesIn;
    previous.pendingOut += bytesOut;
    previous.connections = connections;
    return;
  }
  const seconds = elapsedMs / 1000;
  const inBps = (previous.pendingIn + bytesIn) / seconds;
  const outBps = (previous.pendingOut + bytesOut) / seconds;
  hosts.set(hostId, {
    hostId,
    measured: true,
    inBps: (previous.inBps + inBps) / 2,
    outBps: (previous.outBps + outBps) / 2,
    connections,
    at: nowMs,
    pendingIn: 0,
    pendingOut: 0,
  });
}

export function getRuleLiveRate(ruleId: number, nowMs = Date.now()): RuleLiveRate | null {
  const hosts = samplesByRule.get(Math.floor(Number(ruleId)));
  if (!hosts) return null;
  let best: RuleLiveRate | null = null;
  for (const sample of hosts.values()) {
    if (!sample.measured || nowMs - sample.at > STALE_MS) continue;
    if (!best || sample.inBps + sample.outBps > best.inBps + best.outBps) {
      best = { inBps: sample.inBps, outBps: sample.outBps, connections: sample.connections, at: sample.at };
    }
  }
  return best;
}

export function getRuleLiveRates(ruleIds: readonly number[], nowMs = Date.now()): Map<number, RuleLiveRate> {
  const result = new Map<number, RuleLiveRate>();
  for (const ruleId of ruleIds) {
    const rate = getRuleLiveRate(ruleId, nowMs);
    if (rate) result.set(Number(ruleId), rate);
  }
  return result;
}

export function resetRuleLiveRatesForTest() {
  samplesByRule.clear();
}
