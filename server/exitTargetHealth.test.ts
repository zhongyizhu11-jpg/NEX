import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BALANCE_DETECT } from "../shared/loadBalance";
import {
  EXIT_TARGET_STALE_MS,
  exitTargetExcludedHostIds,
  exitTargetProbeSpec,
  exitTargetSummaryForTunnel,
  exitTargetUnstable,
  ruleActiveExit,
  setExitTargetTunnelMetaForTest,
  exitTargetBaseline,
  setExitTargetBaselineForTest,
  peekExitTargetBaselineForTest,
  updateExitTargetBaseline,
  resetExitTargetStates,
  setExitTargetStateForTest,
  tunnelBalancesExits,
  withRuleExitTargets,
  type ExitTargetState,
} from "./exitTargetHealth";

const exitTargetBaselineRaw = (ruleId: number, hostId: number) => {
  return peekExitTargetBaselineForTest(ruleId, hostId)?.normalMs;
};

function state(partial: Partial<ExitTargetState> & { hostId: number }): ExitTargetState {
  const now = Date.now();
  return {
    ruleId: 7,
    tunnelId: 3,
    hostName: `出口${partial.hostId}`,
    down: false,
    latencyMs: 40,
    medianMs: 40,
    jitterMs: 3,
    lossPct: 0,
    samples: 30,
    at: now,
    changedAt: now,
    unstable: false,
    gost: false,
    ...partial,
  };
}

test("负载均衡链路才算：开了就算（库里老的「只用第一个」是主备，也在几台出口之间换）", () => {
  assert.equal(tunnelBalancesExits({ id: 1, loadBalanceEnabled: true, loadBalanceStrategy: "auto" }), true);
  assert.equal(tunnelBalancesExits({ id: 1, loadBalanceEnabled: true, loadBalanceStrategy: "none" }), true);
  assert.equal(tunnelBalancesExits({ id: 1, loadBalanceEnabled: false, loadBalanceStrategy: "auto" }), false);
});

test("探测规格跟着链路的「检测与切换」：默认 2 秒一次、2 次不通算坏、3 次通算好，有真实连接先看真实连接", () => {
  assert.deepEqual(exitTargetProbeSpec(DEFAULT_BALANCE_DETECT), { intervalMs: 2000, timeoutMs: 2000, failThreshold: 2, recoverOks: 3, passive: true });
});

test("不稳：抖动或丢包超过门槛（样本太少不判）", () => {
  assert.equal(exitTargetUnstable({ jitterMs: 63, lossPct: 0, samples: 30 }, DEFAULT_BALANCE_DETECT), true);
  assert.equal(exitTargetUnstable({ jitterMs: 4, lossPct: 8.06, samples: 30 }, DEFAULT_BALANCE_DETECT), false);
  assert.equal(exitTargetUnstable({ jitterMs: 4, lossPct: 12, samples: 30 }, DEFAULT_BALANCE_DETECT), true);
  assert.equal(exitTargetUnstable({ jitterMs: 200, lossPct: 0, samples: 3 }, DEFAULT_BALANCE_DETECT), false);
  assert.equal(exitTargetUnstable({ jitterMs: 200, lossPct: 50, samples: 30 }, { ...DEFAULT_BALANCE_DETECT, jitterAction: "ignore" }), false);
});

test("GOST 摘出口：只摘连不上的；全都连不上、或剩下的没一台确认能通时一台都不摘", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  setExitTargetStateForTest(state({ hostId: 2 }));
  assert.deepEqual([...exitTargetExcludedHostIds(7, [1, 2, 3])], [1]);
  setExitTargetStateForTest(state({ hostId: 2, down: true }));
  setExitTargetStateForTest(state({ hostId: 3, down: true }));
  assert.equal(exitTargetExcludedHostIds(7, [1, 2, 3]).size, 0, "三台都连不上：目标的问题，摘光等于断服");
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  assert.equal(exitTargetExcludedHostIds(7, [1, 2]).size, 0, "另一台没报过（不知道能不能通）时不摘");
});

test("过期（90 秒没报）的状态当不知道", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, down: true, at: Date.now() - EXIT_TARGET_STALE_MS - 1000 }));
  setExitTargetStateForTest(state({ hostId: 2 }));
  assert.equal(exitTargetExcludedHostIds(7, [1, 2]).size, 0);
});

test("规则卡那一句：写清楚哪台连不上 / 抖 / 丢包；全都不行时说是目标的问题", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, hostName: "jinx(39.9y)", jitterMs: 63, unstable: true }));
  setExitTargetStateForTest(state({ hostId: 2, hostName: "Legend SG", down: true }));
  setExitTargetStateForTest(state({ hostId: 3, hostName: "jinx(29.9y)" }));
  const [row] = withRuleExitTargets([{ ruleId: 7 }]);
  assert.equal(row.exitTargetTotal, 3);
  assert.equal(row.exitTargetOk, 2);
  assert.equal(row.exitTargetNote, "3 台出口里 jinx(39.9y) 到目标抖动 63ms，已少分；Legend SG 连不上目标，已切走");
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  setExitTargetStateForTest(state({ hostId: 2, down: true }));
  assert.match(String(withRuleExitTargets([{ ruleId: 7 }])[0].exitTargetNote), /多半是目标本身的问题/);
  const [plain] = withRuleExitTargets([{ ruleId: 99 }]);
  assert.equal(plain.exitTargetTotal, null);
});

test("GOST 隧道上的抖动只写出来，不说「已少分」", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, hostName: "A", lossPct: 12, unstable: true, gost: true }));
  setExitTargetStateForTest(state({ hostId: 2, hostName: "B", gost: true }));
  assert.equal(withRuleExitTargets([{ ruleId: 7 }])[0].exitTargetNote, "2 台出口里 A 到目标丢包 12%");
});

test("链路弹窗：延迟取各条规则的中位数，每台都连不上的规则算目标的问题", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "least_load" };
  // 规则 7：两台都正常；规则 8：目标在国外，两台都慢；规则 9：两台都连不上（目标挂了）
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 7, medianMs: 10 }));
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 7, medianMs: 12 }));
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 8, medianMs: 210 }));
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 8, medianMs: 220 }));
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 9, down: true }));
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 9, down: true }));
  const summary = exitTargetSummaryForTunnel(tunnel, [1, 2]);
  assert.deepEqual(summary.exits.map((item) => [item.hostId, item.rules, item.down, item.medianMs]), [
    [1, 3, 0, 110],
    [2, 3, 0, 116],
  ]);
  assert.deepEqual(summary.targetIssues, [{ ruleId: 9, kind: "down" }]);
});

test("链路弹窗：只有一台连不上才记在那台头上", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "fallback" };
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  setExitTargetStateForTest(state({ hostId: 2 }));
  const summary = exitTargetSummaryForTunnel(tunnel, [1, 2], { hostNames: new Map([[1, "A"], [2, "B"]]) });
  assert.deepEqual(summary.exits.map((item) => [item.hostId, item.down, item.activeRules]), [[1, 1, 0], [2, 0, 1]]);
  assert.deepEqual(summary.targetIssues, []);
  assert.equal(summary.how, "主备：走 B，1 台备用");
});

test("链路弹窗「怎么走」：NEX 延迟优先，差不到门槛的一起分，慢的备用", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "latency" };
  setExitTargetStateForTest(state({ hostId: 1, medianMs: 10, jitterMs: 2 }));
  setExitTargetStateForTest(state({ hostId: 2, medianMs: 9, jitterMs: 26 }));
  setExitTargetStateForTest(state({ hostId: 3, medianMs: 180, jitterMs: 5 }));
  const summary = exitTargetSummaryForTunnel(tunnel, [1, 2, 3], { hostNames: new Map([[1, "A"], [2, "B"], [3, "C"]]) });
  assert.deepEqual(summary.exits.map((item) => item.activeRules), [1, 1, 0]);
  assert.equal(summary.how, "延迟优先：A、B（差不到 50ms，按负载分），1 台备用");
});

test("平时延迟 = 最低延迟：更低的马上跟下来，更高的只慢慢往上跟", () => {
  resetExitTargetStates();
  const base = Date.now();
  const step = 5 * 60_000;
  for (let i = 0; i < 6; i += 1) {
    updateExitTargetBaseline(state({ ruleId: 30, hostId: 1, medianMs: 14, minMs: 10 + (i % 3), jitterMs: 2 }), base + i * step);
  }
  const ready = exitTargetBaseline(30, 1);
  assert.ok(ready, "攒够半小时（6 次）才有平时值");
  assert.equal(ready!.normalMs, 10, "取的是最低延迟，不是中位数");
  // 5 分钟内的不算
  updateExitTargetBaseline(state({ ruleId: 30, hostId: 1, medianMs: 8, minMs: 8 }), base + 5 * step + 1000);
  assert.equal(exitTargetBaseline(30, 1)!.normalMs, 10);
  // 量到更低的：马上跟下来
  updateExitTargetBaseline(state({ ruleId: 30, hostId: 1, medianMs: 9, minMs: 8 }), base + 6 * step);
  assert.equal(exitTargetBaseline(30, 1)!.normalMs, 8);
  // 头一小时更高的不往上跟
  updateExitTargetBaseline(state({ ruleId: 30, hostId: 1, medianMs: 320, minMs: 300 }), base + 7 * step);
  assert.equal(exitTargetBaseline(30, 1)!.normalMs, 8);
  // 过了头一小时，一阵子拥堵（最低值也到了 300）：平时值只往上挪一点点
  for (let i = 8; i < 14; i += 1) updateExitTargetBaseline(state({ ruleId: 30, hostId: 1, medianMs: 320, minMs: 300 }), base + i * step);
  const drifted = exitTargetBaseline(30, 1)!.normalMs;
  assert.ok(drifted > 8 && drifted < 10, `只慢慢往上跟：${drifted}`);
  // 老 Agent 没报最低延迟：拿中位数
  updateExitTargetBaseline(state({ ruleId: 31, hostId: 1, medianMs: 40, minMs: null }), base);
  assert.equal(exitTargetBaselineRaw(31, 1), 40);
  // 连不上的不算
  updateExitTargetBaseline(state({ ruleId: 30, hostId: 1, down: true }), base + 20 * step);
  assert.equal(exitTargetBaseline(30, 1)!.samples, 14);
});

test("不稳：抖动要同时超过门槛和平时的 2 倍 + 5ms", () => {
  const detect = { ...DEFAULT_BALANCE_DETECT, jitterMs: 30 };
  const sample = { jitterMs: 40, lossPct: 0, samples: 30 };
  assert.equal(exitTargetUnstable(sample, detect), true, "没有平时值：只看门槛");
  assert.equal(exitTargetUnstable(sample, detect, { jitterMs: 20 }), false, "平时就晃 20ms，40ms 不算不稳");
  assert.equal(exitTargetUnstable(sample, detect, { jitterMs: 2 }), true, "平时 2ms 晃到 40ms 才是真抖");
  assert.equal(exitTargetUnstable({ jitterMs: 1, lossPct: 12, samples: 30 }, detect, { jitterMs: 2 }), true, "丢包照旧算");
});

test("链路弹窗：写平时值、比平时慢多少、数据从哪来", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "auto" };
  const now = Date.now();
  setExitTargetStateForTest(state({ hostId: 1, medianMs: 9, source: "traffic", conns: 4 }));
  setExitTargetStateForTest(state({ hostId: 2, medianMs: 120, source: "probe" }));
  setExitTargetBaselineForTest(7, 1, { normalMs: 8, jitterMs: 2, samples: 20, updatedAt: now });
  setExitTargetBaselineForTest(7, 2, { normalMs: 10, jitterMs: 2, samples: 20, updatedAt: now });
  const summary = exitTargetSummaryForTunnel(tunnel, [1, 2]);
  assert.deepEqual(summary.exits.map((item) => [item.hostId, item.baselineMs, item.slowerMs, item.source]), [
    [1, 8, null, "traffic"],
    [2, 10, 110, "probe"],
  ]);
});

test("主出口连不上目标、已切走：规则卡和诊断改用在用的那台", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "latency" };
  setExitTargetTunnelMetaForTest(tunnel, [1, 2, 3]);
  setExitTargetStateForTest(state({ hostId: 1, hostName: "jinx", down: true }));
  setExitTargetStateForTest(state({ hostId: 2, hostName: "hep ix", medianMs: 7, jitterMs: 1 }));
  setExitTargetStateForTest(state({ hostId: 3, hostName: "Jinx", medianMs: 3, jitterMs: 1 }));
  const active = ruleActiveExit(7, 3);
  assert.deepEqual(active && [active.primaryHostId, active.hostIds, active.names, active.latencyMs], [1, [2, 3], ["hep ix", "Jinx"], 3]);
  const [row] = withRuleExitTargets([{ ruleId: 7, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
  assert.equal(row.latestLatencyIsTimeout, false, "主出口那条探测超时，但流量在走：延迟换成在用那台的");
  assert.equal(row.latestLatencyMs, 3);
  assert.deepEqual(row.exitTargetVia, ["hep ix", "Jinx"]);
});

test("2.3.539：主出口老 Agent 没报快速探测、只有普通探测超时，也算切走了", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "fallback" };
  setExitTargetTunnelMetaForTest(tunnel, [1, 2]);
  setExitTargetStateForTest(state({ hostId: 2, hostName: "hep ix", medianMs: 7 }));
  assert.equal(ruleActiveExit(7, 3), null, "没有超时的证据：照旧按主出口");
  const [row] = withRuleExitTargets([{ ruleId: 7, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
  assert.deepEqual(row.exitTargetVia, ["hep ix"], "只有一台出口报了数据也给在用的出口");
  assert.equal(row.latestLatencyIsTimeout, false);
  assert.equal(row.latestLatencyMs, 7);
  assert.equal(row.exitTargetTotal, null);
});

test("2.3.539：手动指定了别的出口、延迟优先挑了别的出口，「经」也写在用的那台", () => {
  resetExitTargetStates();
  setExitTargetTunnelMetaForTest({ id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "auto", balancePinHostId: 2 }, [1, 2]);
  setExitTargetStateForTest(state({ hostId: 1, hostName: "jinx", medianMs: 5 }));
  setExitTargetStateForTest(state({ hostId: 2, hostName: "hep ix", medianMs: 9 }));
  assert.deepEqual(ruleActiveExit(7, 3)?.names, ["hep ix"]);
  setExitTargetTunnelMetaForTest({ id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "latency" }, [1, 2]);
  setExitTargetStateForTest(state({ hostId: 1, hostName: "jinx", medianMs: 180 }));
  setExitTargetStateForTest(state({ hostId: 2, hostName: "hep ix", medianMs: 9 }));
  assert.deepEqual(ruleActiveExit(7, 3)?.names, ["hep ix"], "主出口慢得多，入口挑的是 hep ix");
  setExitTargetStateForTest(state({ hostId: 1, hostName: "jinx", medianMs: 10 }));
  assert.equal(ruleActiveExit(7, 3), null, "差不多快时主出口也在用：照旧");
});

test("主出口正常、或者每台都连不上：照旧按主出口", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "fallback" };
  setExitTargetTunnelMetaForTest(tunnel, [1, 2]);
  setExitTargetStateForTest(state({ hostId: 1 }));
  setExitTargetStateForTest(state({ hostId: 2 }));
  assert.equal(ruleActiveExit(7, 3), null);
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  setExitTargetStateForTest(state({ hostId: 2, down: true }));
  assert.equal(ruleActiveExit(7, 3), null, "都连不上是目标的问题，不换");
  const [row] = withRuleExitTargets([{ ruleId: 7, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
  assert.equal(row.latestLatencyIsTimeout, true);
  assert.equal(row.exitTargetVia, null);
});

/*
  C3：「持续多久才处理」（jitterHoldSeconds，默认 30 秒）以前没人看 —— 一次抖动大的样本就算不稳，延迟优先
  马上把这台排到后面。现在抖动要连续超过门槛满这段时间才算；丢包照旧立刻算（它本来就是一段样本的比例）。
*/
test("不稳：抖动要持续「持续多久才处理」才算，单次抖动大的样本不算；丢包不等", () => {
  const detect = { ...DEFAULT_BALANCE_DETECT };
  const at = Date.now();
  const jittery = { jitterMs: 63, lossPct: 0, samples: 30, at };
  assert.equal(exitTargetUnstable({ ...jittery, jitterSince: at }, detect), false, "刚开始抖：不算");
  assert.equal(exitTargetUnstable({ ...jittery, jitterSince: at - (detect.jitterHoldSeconds - 1) * 1000 }, detect), false);
  assert.equal(exitTargetUnstable({ ...jittery, jitterSince: at - detect.jitterHoldSeconds * 1000 }, detect), true, "抖满了「持续多久才处理」才算");
  assert.equal(exitTargetUnstable({ jitterMs: 4, lossPct: 12, samples: 30, at, jitterSince: null }, detect), true, "丢包不等");
});

