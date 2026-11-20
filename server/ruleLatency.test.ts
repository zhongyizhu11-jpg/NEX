import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTunnelRuleLatencyProbe,
  canReuseRecentTunnelLatencySample,
  combineTunnelRuleLatencySample,
  freshTunnelSegmentLatency,
  TUNNEL_RULE_LATENCY_FRESH_MS,
  tunnelRuleLatencySampleSucceeded,
  tunnelRuleLatencyTopologyKey,
  tunnelRuleProbeExitHostIds,
  validateTunnelRuleLatencyReport,
} from "./ruleLatency";

const rule = {
  id: 71,
  tunnelId: 8,
  targetIp: "game.example.com",
  targetPort: 443,
  protocol: "tcp",
  isEnabled: true,
  pendingDelete: false,
};
const tunnel = { id: 8, exitHostId: 22, isEnabled: true };

test("tunnel rule latency probes are created only for the canonical exit host", () => {
  assert.equal(buildTunnelRuleLatencyProbe({ hostId: 11, rule, tunnel }), null);
  assert.deepEqual(buildTunnelRuleLatencyProbe({ hostId: 22, rule, tunnel }), {
    ruleId: 71,
    tunnelId: 8,
    targetIp: "game.example.com",
    targetPort: 443,
    method: "tcping",
    probeKey: tunnelRuleLatencyTopologyKey(rule, tunnel),
    topologyKey: tunnelRuleLatencyTopologyKey(rule, tunnel),
  });
});

test("负载均衡链路：每台出口都探目标，各有自己的拓扑键；报上来按报的那台校验（2.3.544）", () => {
  const balanced = { ...tunnel, loadBalanceEnabled: true };
  const exitNodes = [{ hostId: 33, isEnabled: true }, { hostId: 44, isEnabled: false }, { hostId: 22 }];
  assert.deepEqual(tunnelRuleProbeExitHostIds(balanced, exitNodes), [22, 33], "主出口在前，停用的出口不探");
  assert.deepEqual(tunnelRuleProbeExitHostIds(tunnel, exitNodes), [22], "没开负载均衡只有主出口");
  const exitHostIds = tunnelRuleProbeExitHostIds(balanced, exitNodes);
  const onSecond = buildTunnelRuleLatencyProbe({ hostId: 33, rule, tunnel: balanced, exitHostIds });
  assert.equal(onSecond?.topologyKey, tunnelRuleLatencyTopologyKey(rule, balanced, rule.targetIp, 33));
  assert.notEqual(onSecond?.topologyKey, tunnelRuleLatencyTopologyKey(rule, balanced), "和主出口的键不一样，面板分得清是哪台报的");
  assert.equal(buildTunnelRuleLatencyProbe({ hostId: 44, rule, tunnel: balanced, exitHostIds }), null, "停用的出口不探");
  assert.equal(validateTunnelRuleLatencyReport({ hostId: 33, rule, tunnel: balanced, exitHostIds, report: { targetPort: 443, method: "tcping", topologyKey: onSecond!.topologyKey } }), true);
  assert.equal(validateTunnelRuleLatencyReport({ hostId: 33, rule, tunnel: balanced, report: { targetPort: 443, method: "tcping", topologyKey: onSecond!.topologyKey } }), false, "没给出口名单时照旧只认主出口");
  assert.equal(validateTunnelRuleLatencyReport({ hostId: 22, rule, tunnel: balanced, exitHostIds, report: { targetPort: 443, method: "tcping", topologyKey: onSecond!.topologyKey } }), false, "主出口拿着别台的键不算");
});

test("tunnel rule latency reports reject entry hosts and stale topology", () => {
  const topologyKey = tunnelRuleLatencyTopologyKey(rule, tunnel);
  assert.equal(validateTunnelRuleLatencyReport({
    hostId: 11,
    rule,
    tunnel,
    report: { targetPort: 443, method: "tcping", topologyKey },
  }), false);
  assert.equal(validateTunnelRuleLatencyReport({
    hostId: 22,
    rule,
    tunnel,
    report: { targetPort: 443, method: "tcping", topologyKey: `${topologyKey}:old` },
  }), false);
  assert.equal(validateTunnelRuleLatencyReport({
    hostId: 22,
    rule,
    tunnel,
    report: { targetPort: 443, method: "tcping", topologyKey },
  }), true);
});

test("tunnel rule latency is the fresh tunnel path plus exit-to-target latency", () => {
  const nowMs = Date.parse("2026-07-20T10:00:00Z");
  assert.deepEqual(combineTunnelRuleLatencySample({
    targetLatencyMs: 131,
    targetIsTimeout: false,
    tunnelLatencyMs: 6,
    tunnelIsTimeout: false,
    tunnelRecordedAt: new Date(nowMs - 1000),
    nowMs,
  }), { latencyMs: 137, isTimeout: false });
  assert.equal(combineTunnelRuleLatencySample({
    targetLatencyMs: 131,
    targetIsTimeout: false,
    tunnelLatencyMs: 6,
    tunnelIsTimeout: false,
    tunnelRecordedAt: new Date(nowMs - 6 * 60 * 1000),
    nowMs,
  }), null);
  assert.deepEqual(combineTunnelRuleLatencySample({
    targetLatencyMs: 131,
    targetIsTimeout: false,
    tunnelLatencyMs: null,
    tunnelIsTimeout: true,
    tunnelRecordedAt: new Date(nowMs - 1000),
    nowMs,
  }), { latencyMs: null, isTimeout: true });
  assert.deepEqual(combineTunnelRuleLatencySample({
    targetLatencyMs: null,
    targetIsTimeout: true,
    nowMs,
  }), { latencyMs: null, isTimeout: true });
});

test("the tunnel segment keeps its own latency when the target is unreachable", () => {
  const nowMs = Date.parse("2026-07-20T10:00:00Z");
  const fresh = { tunnelLatencyMs: 7, tunnelIsTimeout: false, tunnelRecordedAt: new Date(nowMs - 1000), nowMs };
  assert.deepEqual(combineTunnelRuleLatencySample({ targetLatencyMs: null, targetIsTimeout: true, ...fresh }), { latencyMs: null, isTimeout: true });
  assert.deepEqual(freshTunnelSegmentLatency(fresh), { latencyMs: 7, isTimeout: false });
  assert.equal(freshTunnelSegmentLatency({ ...fresh, tunnelRecordedAt: new Date(nowMs - 6 * 60 * 1000) }), null);
  assert.deepEqual(freshTunnelSegmentLatency({ ...fresh, tunnelLatencyMs: null, tunnelIsTimeout: true }), { latencyMs: null, isTimeout: true });
});

test("a tunnel rule cannot succeed from the target segment alone", () => {
  assert.equal(tunnelRuleLatencySampleSucceeded(true, null), false);
  assert.equal(tunnelRuleLatencySampleSucceeded(true, { latencyMs: null, isTimeout: true }), false);
  assert.equal(tunnelRuleLatencySampleSucceeded(true, { latencyMs: null, isTimeout: false }), false);
  assert.equal(tunnelRuleLatencySampleSucceeded(false, { latencyMs: 47, isTimeout: false }), false);
  assert.equal(tunnelRuleLatencySampleSucceeded(true, { latencyMs: 47, isTimeout: false }), true);
});

test("missing latency values cannot become a synthetic zero-millisecond path", () => {
  const recordedAt = new Date();
  assert.deepEqual(combineTunnelRuleLatencySample({
    targetLatencyMs: null,
    targetIsTimeout: false,
    tunnelLatencyMs: 12,
    tunnelRecordedAt: recordedAt,
  }), { latencyMs: null, isTimeout: true });
  assert.equal(combineTunnelRuleLatencySample({
    targetLatencyMs: 15,
    targetIsTimeout: false,
    tunnelLatencyMs: null,
    tunnelRecordedAt: recordedAt,
  }), null);
});

test("a recent successful tunnel sample can be reused while a refresh is still pending", () => {
  const nowMs = Date.parse("2026-07-20T10:00:00Z");
  const recordedAt = new Date(nowMs - 2_000);
  assert.equal(canReuseRecentTunnelLatencySample({
    sample: { latencyMs: 8, isTimeout: false, recordedAt },
    tunnel: {
      lastTestStatus: "success",
      lastTestAt: recordedAt,
      updatedAt: recordedAt,
    },
    nowMs,
  }), true);
});

test("recent tunnel sample reuse fails closed for stale, failed, or changed tunnels", () => {
  const nowMs = Date.parse("2026-07-20T10:00:00Z");
  const recordedAt = new Date(nowMs - 2_000);
  const base = {
    sample: { latencyMs: 8, isTimeout: false, recordedAt },
    tunnel: { lastTestStatus: "success", lastTestAt: recordedAt, updatedAt: recordedAt },
    nowMs,
  };
  assert.equal(canReuseRecentTunnelLatencySample({
    ...base,
    sample: { ...base.sample, recordedAt: new Date(nowMs - TUNNEL_RULE_LATENCY_FRESH_MS - 1) },
  }), false);
  assert.equal(canReuseRecentTunnelLatencySample({
    ...base,
    tunnel: { ...base.tunnel, lastTestStatus: "failed" },
  }), false);
  assert.equal(canReuseRecentTunnelLatencySample({
    ...base,
    tunnel: { ...base.tunnel, updatedAt: new Date(nowMs) },
  }), false);
});
