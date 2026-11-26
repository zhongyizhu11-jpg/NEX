import assert from "node:assert/strict";
import test from "node:test";

import { resetBalanceLiveForTest, setBalanceLiveReportForTest, type LiveExit } from "./balanceLive";
import { resetExitTargetStates, ruleHasReachableExit, setExitTargetStateForTest, withRuleExitTargets, type ExitTargetState } from "./exitTargetHealth";
import { recordRuleTargetLeg, recordTunnelExitLeg, resetRuleLatencyViewForTest } from "./ruleLatencyView";
import { preferLastKnownForwardRuleVisualStatus, resolveForwardRuleNotRunningReason, resolveForwardRuleVisualStatus, type ForwardRuleVisualStatus } from "../client/src/lib/forwardRuleStatus";
import { isRuleProbeUnreachable } from "../shared/linkProbePolicy";

/*
  规则卡红 / 橙 / 绿的场景矩阵（docs/dev/rule-card-status.md）：从服务端拼卡片数据（withRuleExitTargets）一直走到
  前端定颜色（resolveForwardRuleVisualStatus），再加上「上次状态」和订阅「自动隐藏不通的节点」。每个场景是用户面板上
  真实出现过的情况（2026-11-26：高防目标一直拦着 jinx(39.9y)、Jinx(29.9y)，hep ix 通）。

  出口：7 = jinx(39.9y)（主出口）、12 = hep ix、2 = Jinx(29.9y)。
*/
const RULE = 33;
const TUNNEL = 1;
const now = Date.now();
const NAMES: Record<number, string> = { 7: "jinx(39.9y)", 12: "hep ix", 2: "Jinx(29.9y)" };

type Scenario = {
  /** 入口实时上报里每台出口的状态；null = 没有实时上报（入口刚重启 / 老 Agent） */
  live: Partial<Record<number, LiveExit["state"]>> | null;
  /** 出口机几秒一次的快速探测：true = 连不上目标；不写 = 没有快速探测数据 */
  fastDown?: Partial<Record<number, boolean>>;
  /** 面板测到的两段：入口 → 出口、出口 → 目标（毫秒） */
  legs?: Partial<Record<number, [number, number]>>;
  /** 规则自己的定时端到端探测（数据库最新一条，从主出口测） */
  probe: { ms: number | null; timeout: boolean };
};

function liveExit(hostId: number, state: LiveExit["state"]): LiveExit {
  return {
    hostId, hostName: NAMES[hostId], host: `198.51.100.${hostId}`, port: 40000 + hostId, state,
    reason: state === "down" ? "target" : null, share: state === "active" ? 1 : null, picks: 0,
    medianMs: null, exitMs: null, targetMs: null, targetLatencyUnknown: false, jitterMs: null, lossPct: null, samples: 10,
    udpState: null, peerOutdated: false,
  };
}

function exitState(hostId: number, down: boolean): ExitTargetState {
  return {
    ruleId: RULE, tunnelId: TUNNEL, hostId, hostName: NAMES[hostId], down, latencyMs: down ? null : 3, medianMs: down ? null : 3,
    jitterMs: 0, lossPct: down ? 100 : 0, samples: 10, at: now, changedAt: now, unstable: false, gost: true, probedAt: now,
  };
}

/** 服务端拼好的卡片数据 → 前端定的颜色（和 client/src/features/rules/useRuleVisualStatuses.ts 一样喂字段）。 */
function card(scenario: Scenario) {
  resetBalanceLiveForTest();
  resetExitTargetStates();
  resetRuleLatencyViewForTest();
  for (const [hostId, down] of Object.entries(scenario.fastDown || {})) setExitTargetStateForTest(exitState(Number(hostId), !!down));
  if (scenario.live) {
    setBalanceLiveReportForTest({
      ruleId: RULE, tunnelId: TUNNEL, entryHostId: 9, entryHostName: "Po0(200M)", strategy: "fallback", targetAware: true, source: "agent",
      exits: [7, 12, 2].filter((hostId) => scenario.live![hostId]).map((hostId) => liveExit(hostId, scenario.live![hostId]!)),
      events: [], at: now,
    }, 9);
  }
  for (const [hostId, [exitMs, targetMs]] of Object.entries(scenario.legs || {}) as Array<[string, [number, number]]>) {
    recordTunnelExitLeg(TUNNEL, Number(hostId), exitMs, now);
    recordRuleTargetLeg({ ruleId: RULE, tunnelId: TUNNEL, exitHostId: Number(hostId), primaryHostId: 7, ms: targetMs, at: now });
  }
  const [row] = withRuleExitTargets([{
    ruleId: RULE,
    latestLatencyMs: scenario.probe.ms,
    latestLatencyIsTimeout: scenario.probe.timeout,
    latestLatencyAt: new Date(now - 5_000),
  }], now);
  const status = resolveForwardRuleVisualStatus({
    ruleEnabled: true, ruleRunning: true, groupEnabled: true, groupConfigStatus: "available",
    latestLatencyMs: row.latestLatencyMs as number | null,
    latestLatencyIsTimeout: row.latestLatencyIsTimeout as boolean,
    latestLatencyAt: row.latestLatencyAt as Date,
    latestProbeFailure: (row as { latestProbeFailure?: string | null }).latestProbeFailure ?? null,
    exitTargetOk: row.exitTargetOk,
    exitTargetNote: row.exitTargetNote,
  }, now);
  return { row, status, reachable: ruleHasReachableExit(RULE, now) };
}

const COLOR: Record<ForwardRuleVisualStatus["state"], string> = { running: "绿", pending: "橙", error: "红", disabled: "灰" };

test("场景 1：主出口在用、通 —— 绿，延迟是它的整链", () => {
  const { row, status } = card({ live: { 7: "active", 12: "standby", 2: "standby" }, fastDown: { 7: false, 12: false, 2: false }, legs: { 7: [7, 3] }, probe: { ms: 10, timeout: false } });
  assert.equal(COLOR[status.state], "绿");
  assert.equal(row.latestLatencyMs, 10);
  assert.deepEqual(row.exitTargetVia, ["jinx(39.9y)"]);
});

test("场景 2：主出口被高防拦、已经切到 hep ix、两段测到了 —— 橙（写明哪台连不上），延迟是 hep ix 的整链", () => {
  const { row, status, reachable } = card({ live: { 7: "down", 12: "active", 2: "down" }, fastDown: { 7: true, 12: false, 2: true }, legs: { 12: [5, 3] }, probe: { ms: null, timeout: true } });
  assert.equal(COLOR[status.state], "橙");
  assert.equal(status.confirmed, true, "确定的结论，不拿上一次的颜色顶");
  assert.equal(resolveForwardRuleNotRunningReason(status, []), null, "规则在跑：不写「等待 Agent 应用」");
  assert.match(status.title, /jinx\(39\.9y\) 连不上目标，已切走/);
  assert.equal(row.latestLatencyMs, 8);
  assert.deepEqual(row.exitTargetVia, ["hep ix"]);
  assert.equal(reachable, true, "订阅不藏");
});

test("场景 3：同上，但 hep ix 的两段面板还没测到 —— 橙，不写主出口那条的超时", () => {
  const { row, status, reachable } = card({ live: { 7: "down", 12: "active", 2: "down" }, fastDown: { 7: true, 12: false, 2: true }, probe: { ms: null, timeout: true } });
  assert.equal(COLOR[status.state], "橙");
  assert.equal(row.latestLatencyIsTimeout, false);
  assert.equal(row.latestLatencySource, "live", "前端缓存以这一次为准（ruleProbeCache）");
  assert.equal(reachable, true);
});

test("场景 4：入口还报着 jinx(39.9y) 在用，快速探测已经说它连不上，hep ix 通 —— 橙，不拿它一分钟前的成功数写绿", () => {
  const { row, status, reachable } = card({ live: { 7: "active", 12: "standby", 2: "down" }, fastDown: { 7: true, 12: false, 2: true }, legs: { 7: [7, 7] }, probe: { ms: 14, timeout: false } });
  assert.equal(COLOR[status.state], "橙");
  assert.equal(row.latestLatencyIsTimeout, true);
  assert.equal(row.exitTargetOk, 1, "扣掉快速探测说连不上的那台");
  assert.equal(reachable, false, "此刻入口还在往连不上的那台送：算不通（几秒后入口切走就恢复）");
});

test("场景 5：三台都连不上目标 —— 红", () => {
  const { status, reachable } = card({ live: { 7: "down", 12: "down", 2: "down" }, fastDown: { 7: true, 12: true, 2: true }, probe: { ms: null, timeout: true } });
  assert.equal(COLOR[status.state], "红");
  assert.equal(reachable, false);
});

test("场景 6：没有入口实时上报（入口刚重启），快速探测里 hep ix 通、主出口的定时探测超时 —— 橙，不红", () => {
  const { status, reachable } = card({ live: null, fastDown: { 7: true, 12: false, 2: true }, probe: { ms: null, timeout: true } });
  assert.equal(COLOR[status.state], "橙");
  assert.equal(reachable, true);
});

test("场景 7：不是负载均衡的规则 —— 只看自己的定时探测", () => {
  const ok = card({ live: null, probe: { ms: 9, timeout: false } });
  assert.equal(COLOR[ok.status.state], "绿");
  const bad = card({ live: null, probe: { ms: null, timeout: true } });
  assert.equal(COLOR[bad.status.state], "红");
  assert.equal(bad.reachable, null, "订阅照旧按探测判断");
});

test("上次状态：只在「还在等上报」时顶一下；有数据的橙色照实显示", () => {
  const waiting: ForwardRuleVisualStatus = { state: "pending", title: "等待 Agent 确认托管监听（0 / 1）" };
  assert.equal(preferLastKnownForwardRuleVisualStatus(waiting, { state: "running", title: "最近一次端到端探测可达（9ms）" }).state, "running");
  const { status } = card({ live: { 7: "down", 12: "active", 2: "down" }, fastDown: { 7: true, 12: false, 2: true }, legs: { 12: [5, 3] }, probe: { ms: null, timeout: true } });
  assert.deepEqual(preferLastKnownForwardRuleVisualStatus(status, { state: "error", title: "最近一次端到端探测超时" }), status);
});

test("订阅自动隐藏：直连规则连着 3 次超时才藏；负载均衡还有一台通就不藏", () => {
  const timeouts = [0, 60_000, 120_000].map((ago) => ({ isTimeout: true, recordedAt: new Date(now - 5_000 - ago) }));
  assert.equal(isRuleProbeUnreachable(timeouts, now), true, "探测层面：连着 3 次超时");
  assert.equal(isRuleProbeUnreachable([{ isTimeout: false, recordedAt: new Date(now) }, ...timeouts.slice(0, 2)], now), false);
  // 负载均衡：探测层面判了不通，但 hep ix 通 —— proxySubscriptionRepository 用 ruleHasReachableExit 把它捞回来
  assert.equal(card({ live: { 7: "down", 12: "active", 2: "down" }, fastDown: { 7: true, 12: false, 2: true }, probe: { ms: null, timeout: true } }).reachable, true);
});
