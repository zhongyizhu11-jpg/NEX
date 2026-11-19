import assert from "node:assert/strict";
import test from "node:test";
import { BALANCE_SENSITIVITY_PRESETS, BALANCE_STRATEGIES, DEFAULT_BALANCE_DETECT, GOST_BALANCE_MAX_EXITS, UNIFIED_BALANCE_AGENT_VERSION, agentSupportsUnifiedBalance } from "../shared/loadBalance";
import { buildGostBalanceProxySpec, gostBalanceProbeTiming, gostBalanceProxyStrategy, gostBalanceTargetWeights } from "./gostBalancePlan";
import { tunnelBalanceAgentIssues } from "./tunnelBalanceAgent";

/*
  交给入口机本机代理的规格（server/gostBalancePlan.ts）。整条心跳走下来生成的东西在 gostBalanceHeartbeat.test.ts，
  真实 gost 上的行为在 gost-runtime/test/balance-proxy/run.sh。
*/

const exits = [
  { hostId: 21, localPort: 47004, dialHost: "198.51.100.21", listenPort: 23001 },
  { hostId: 22, localPort: 47005, dialHost: "198.51.100.22", listenPort: 23002 },
  { hostId: 23, localPort: 47006, dialHost: "198.51.100.23", listenPort: 23003 },
];
const base = {
  listenPort: 41001,
  protocol: "both",
  strategy: "round_robin",
  detect: DEFAULT_BALANCE_DETECT,
  tunnelId: 7,
  exits,
  weights: null,
  pinHostId: 0,
  downHostIds: new Set<number>(),
  extraLatencyMs: new Map<number, number>(),
  proxyHeaderForward: false,
  proxyProtocolVersion: 1 as const,
};

test("门槛只有一处：2.2.264 起能执行统一调度，更老的、没报版本的都不能", () => {
  assert.equal(UNIFIED_BALANCE_AGENT_VERSION, "2.2.264");
  assert.equal(agentSupportsUnifiedBalance("2.2.264"), true);
  assert.equal(agentSupportsUnifiedBalance("2.3.0"), true);
  assert.equal(agentSupportsUnifiedBalance("2.2.263"), false);
  assert.equal(agentSupportsUnifiedBalance(""), false);
  assert.equal(agentSupportsUnifiedBalance(null), false);
});

test("八种分配方式每一种都对得上调度器的一种策略，没有哪种被悄悄换成别的", () => {
  const mapped = Object.fromEntries(BALANCE_STRATEGIES.map((strategy) => [strategy, gostBalanceProxyStrategy(strategy)]));
  assert.deepEqual(mapped, {
    auto: { strategy: "auto", preferFastest: false },
    fallback: { strategy: "fallback", preferFastest: false },
    ip_hash: { strategy: "ip_hash", preferFastest: false },
    // 延迟优先 = 一次只走整链最好的那台：主备的骨架 + 自动择优
    latency: { strategy: "fallback", preferFastest: true },
    least_load: { strategy: "least_load", preferFastest: false },
    weighted: { strategy: "weighted", preferFastest: false },
    round_robin: { strategy: "round_robin", preferFastest: false },
    random: { strategy: "random", preferFastest: false },
  });
  // 老值「只用第一个」当主备
  assert.deepEqual(gostBalanceProxyStrategy("none"), { strategy: "fallback", preferFastest: false });
});

test("探测节奏照「检测与切换」来：默认 2 秒一轮、1 秒超时、第 2 轮失败就判坏、连着通 3 轮恢复", () => {
  assert.deepEqual(gostBalanceProbeTiming(DEFAULT_BALANCE_DETECT), {
    probeIntervalSeconds: 2, probeTimeoutMs: 1000, failureThreshold: 2, failoverSeconds: 2, recoverSeconds: 4,
  });
  assert.deepEqual(gostBalanceProbeTiming(BALANCE_SENSITIVITY_PRESETS.sensitive.detect), {
    probeIntervalSeconds: 1, probeTimeoutMs: 1000, failureThreshold: 2, failoverSeconds: 1, recoverSeconds: 2,
  });
  assert.deepEqual(gostBalanceProbeTiming(BALANCE_SENSITIVITY_PRESETS.stable.detect), {
    probeIntervalSeconds: 5, probeTimeoutMs: 2000, failureThreshold: 3, failoverSeconds: 10, recoverSeconds: 20,
  });
});

test("规格：每台出口一条目标（本机端口 + 直接探出口机），主机号一一对应，总是先读 PROXY 头", () => {
  const spec = buildGostBalanceProxySpec(base);
  assert.equal(spec.strategy, "round_robin");
  assert.equal(spec.protocol, "both");
  assert.deepEqual(spec.targets, [
    { targetIp: "127.0.0.1", targetPort: 47004, probeIp: "198.51.100.21", probePort: 23001 },
    { targetIp: "127.0.0.1", targetPort: 47005, probeIp: "198.51.100.22", probePort: 23002 },
    { targetIp: "127.0.0.1", targetPort: 47006, probeIp: "198.51.100.23", probePort: 23003 },
  ]);
  assert.deepEqual(spec.balanceReport, { tunnelId: 7, hostIds: [21, 22, 23] });
  assert.equal(spec.proxyProtocolReceive, true);
  assert.equal(spec.proxyProtocolStrip, true, "规则不往目标发头：这个头只给调度器看，读完扔掉");
  assert.equal(spec.proxyProtocolSend, false);
  assert.equal(spec.pinnedIndex, null);
  assert.equal(spec.probeIntervalSeconds, 2);
  assert.equal(spec.minHoldSeconds, 60);
  assert.equal("noSlowStart" in spec, false);
});

test("规格：入口发送 PROXY 头的规则头原样转给出口；关了慢启动带 noSlowStart", () => {
  const spec = buildGostBalanceProxySpec({ ...base, proxyHeaderForward: true, proxyProtocolVersion: 2, detect: { ...DEFAULT_BALANCE_DETECT, slowStart: false } });
  assert.equal(spec.proxyProtocolReceive, true);
  assert.equal("proxyProtocolStrip" in spec, false);
  assert.equal(spec.proxyProtocolSend, true);
  assert.equal(spec.proxyProtocolVersion, 2);
  assert.equal(spec.noSlowStart, true);
});

test("规格：份数原样带（超过 100 的按比例压）、面板提示、手动指定不看在线状态", () => {
  const spec = buildGostBalanceProxySpec({
    ...base,
    strategy: "weighted",
    weights: [5, 3, 2],
    pinHostId: 22,
    downHostIds: new Set([23]),
    extraLatencyMs: new Map([[21, 12.4], [22, 80]]),
  });
  assert.deepEqual(spec.targets.map((target) => target.weight), [5, 3, 2]);
  assert.equal(spec.pinnedIndex, 1);
  assert.deepEqual(spec.targets.map((target) => target.extraLatencyMs), [12, 80, undefined]);
  assert.equal(spec.targets[2].down, true);
  assert.equal(spec.targets[2].downReason, "出口连不上目标");
  assert.deepEqual(gostBalanceTargetWeights([500, 250, 50], 3), [100, 50, 10]);
  assert.equal(gostBalanceTargetWeights([5, 3], 3), null, "数量对不上就不带");
  assert.equal(gostBalanceTargetWeights(null, 3), null);
  // 指定的出口不在这条规则的出口里：当没指定
  assert.equal(buildGostBalanceProxySpec({ ...base, pinHostId: 99 }).pinnedIndex, null);
});

test("规格：延迟优先带择优和「持续多久才换」；多跳的出口带 viaRelay；出口最多 20 台", () => {
  const latency = buildGostBalanceProxySpec({ ...base, strategy: "latency" });
  assert.equal(latency.strategy, "fallback");
  assert.equal(latency.preferFastest, true);
  assert.equal(latency.autoFailback, true);
  assert.equal(latency.scoreHoldSeconds, DEFAULT_BALANCE_DETECT.jitterHoldSeconds);
  const relayed = buildGostBalanceProxySpec({ ...base, exits: exits.map((exit) => ({ ...exit, viaRelay: true })) });
  assert.ok(relayed.targets.every((target) => target.viaRelay === true));
  const many = Array.from({ length: 25 }, (_, index) => ({ hostId: 100 + index, localPort: 48000 + index, dialHost: `198.51.100.${index + 1}`, listenPort: 23000 + index }));
  const capped = buildGostBalanceProxySpec({ ...base, exits: many });
  assert.equal(capped.targets.length, GOST_BALANCE_MAX_EXITS);
  assert.equal(capped.balanceReport.hostIds.length, GOST_BALANCE_MAX_EXITS);
});

test("需要升级 Agent：GOST 链路开了负载均衡、有额外出口、入口机的 Agent 太老才提示", () => {
  const hosts = new Map<number, { id: number; name: string; agentVersion: string }>([
    [1, { id: 1, name: "入口甲", agentVersion: "2.2.263" }],
    [2, { id: 2, name: "入口乙", agentVersion: "2.2.264" }],
  ]);
  const tunnel = { mode: "tls", loadBalanceEnabled: 1, loadBalanceStrategy: "auto" };
  const issues = tunnelBalanceAgentIssues(tunnel, [1, 2], 2, hosts);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].hostId, 1);
  assert.match(issues[0].message, /入口甲/);
  assert.match(issues[0].message, /2\.2\.263/);
  assert.match(issues[0].message, /只走主出口，需要升级 Agent$/);
  assert.deepEqual(tunnelBalanceAgentIssues(tunnel, [2], 2, hosts), []);
  assert.deepEqual(tunnelBalanceAgentIssues(tunnel, [1], 0, hosts), [], "没有额外出口：本来就只有一台");
  assert.deepEqual(tunnelBalanceAgentIssues({ ...tunnel, loadBalanceEnabled: 0 }, [1], 2, hosts), []);
  assert.deepEqual(tunnelBalanceAgentIssues({ ...tunnel, mode: "forwardx" }, [1], 2, hosts), [], "NEX 隧道由 FXP 挑，不看这个");
  assert.deepEqual(tunnelBalanceAgentIssues({ ...tunnel, mode: "nginx_stream" }, [1], 2, hosts), [], "nginx 隧道用它自己的 upstream");
});
