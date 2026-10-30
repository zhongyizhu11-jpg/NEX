import assert from "node:assert/strict";
import test from "node:test";

import { getRuleLiveRate, recordRuleTrafficSample, resetRuleLiveRatesForTest, withRuleLiveRates } from "./ruleLiveRates";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);

test("第一次上报只记时刻，第二次起按增量 ÷ 间隔算速率，并折半平均", () => {
  resetRuleLiveRatesForTest();
  recordRuleTrafficSample({ ruleId: 7, hostId: 1, bytesIn: 5_000, bytesOut: 1_000, connections: 3, nowMs: T0 });
  assert.equal(getRuleLiveRate(7, T0), null, "没有间隔就算不出速率");
  recordRuleTrafficSample({ ruleId: 7, hostId: 1, bytesIn: 10_000, bytesOut: 2_000, connections: 4, nowMs: T0 + 10_000 });
  const first = getRuleLiveRate(7, T0 + 10_000)!;
  // 10 秒跑了 10000 字节 = 1000 B/s，和上一次的 0 折半 = 500。
  assert.equal(first.inBps, 500);
  assert.equal(first.outBps, 100);
  assert.equal(first.connections, 4);
  recordRuleTrafficSample({ ruleId: 7, hostId: 1, bytesIn: 10_000, bytesOut: 2_000, nowMs: T0 + 20_000 });
  assert.equal(getRuleLiveRate(7, T0 + 20_000)!.inBps, 750);
});

test("过了 90 秒没新上报就当没有；再报回来重新起算", () => {
  resetRuleLiveRatesForTest();
  recordRuleTrafficSample({ ruleId: 7, hostId: 1, bytesIn: 0, bytesOut: 0, nowMs: T0 });
  recordRuleTrafficSample({ ruleId: 7, hostId: 1, bytesIn: 8_000, bytesOut: 0, nowMs: T0 + 8_000 });
  assert.ok(getRuleLiveRate(7, T0 + 60_000));
  assert.equal(getRuleLiveRate(7, T0 + 8_000 + 91_000), null);
  // 掉线两分钟后又报：这一包的字节是两分钟里攒的还是刚刚的，说不清，不拿它算速率。
  recordRuleTrafficSample({ ruleId: 7, hostId: 1, bytesIn: 999_999, bytesOut: 0, nowMs: T0 + 200_000 });
  assert.equal(getRuleLiveRate(7, T0 + 200_000), null);
});

test("两台机器报同一条规则（隧道两端）取大的那份，不相加", () => {
  resetRuleLiveRatesForTest();
  for (const hostId of [1, 2]) {
    recordRuleTrafficSample({ ruleId: 9, hostId, bytesIn: 0, bytesOut: 0, nowMs: T0 });
  }
  recordRuleTrafficSample({ ruleId: 9, hostId: 1, bytesIn: 20_000, bytesOut: 0, nowMs: T0 + 10_000 });
  recordRuleTrafficSample({ ruleId: 9, hostId: 2, bytesIn: 4_000, bytesOut: 0, nowMs: T0 + 10_000 });
  assert.equal(getRuleLiveRate(9, T0 + 10_000)!.inBps, 1_000);
});

test("半秒内重复上报的字节攒到下一次，不算成天文数字", () => {
  resetRuleLiveRatesForTest();
  recordRuleTrafficSample({ ruleId: 3, hostId: 1, bytesIn: 0, bytesOut: 0, nowMs: T0 });
  recordRuleTrafficSample({ ruleId: 3, hostId: 1, bytesIn: 5_000, bytesOut: 0, nowMs: T0 + 100 });
  assert.equal(getRuleLiveRate(3, T0 + 100), null);
  recordRuleTrafficSample({ ruleId: 3, hostId: 1, bytesIn: 5_000, bytesOut: 0, nowMs: T0 + 10_000 });
  assert.equal(getRuleLiveRate(3, T0 + 10_000)!.inBps, 500);
});

test("withRuleLiveRates：给汇总行补 liveRate，没报过的规则是 null，ruleId 是字符串也认", () => {
  resetRuleLiveRatesForTest();
  recordRuleTrafficSample({ ruleId: 9, hostId: 1, bytesIn: 0, bytesOut: 0, nowMs: T0 });
  recordRuleTrafficSample({ ruleId: 9, hostId: 1, bytesIn: 20_000, bytesOut: 2_000, connections: 2, nowMs: T0 + 10_000 });
  const rows = withRuleLiveRates([{ ruleId: "9", bytesIn: 1 }, { ruleId: 10, bytesIn: 2 }], T0 + 12_000);
  assert.equal(rows[0].liveRate?.inBps, 1000);
  assert.equal(rows[0].bytesIn, 1, "原来的字段原样带着");
  assert.equal(rows[1].liveRate, null);
});
