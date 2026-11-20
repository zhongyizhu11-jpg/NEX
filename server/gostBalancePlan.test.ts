import assert from "node:assert/strict";
import test from "node:test";
import { BALANCE_SENSITIVITY_PRESETS, BALANCE_STRATEGIES, DEFAULT_BALANCE_DETECT, GOST_BALANCE_MAX_EXITS, UNIFIED_BALANCE_AGENT_VERSION, agentSupportsUnifiedBalance, normalizeExitGroupStrategy } from "../shared/loadBalance";
import { buildGostBalanceProxySpec, gostBalanceProbeTiming, gostBalanceTargetWeights, gostBalanceUnknownExtraLatency, planGostBalanceRules } from "./gostBalancePlan";
import { tunnelBalanceAgentIssues, tunnelRelayRuntimeIssues } from "./tunnelBalanceAgent";

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

test("八种分配方式原样交给调度器（和 NEX 隧道同一段算法），没有哪种被悄悄换成别的", () => {
  for (const strategy of BALANCE_STRATEGIES) assert.equal(normalizeExitGroupStrategy(strategy), strategy);
  // 老值「只用第一个」当主备
  assert.equal(normalizeExitGroupStrategy("none"), "fallback");
  assert.equal(normalizeExitGroupStrategy("least_conn"), "least_load");
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

test("规格：延迟优先原样下发、带「一样快」的门槛；多跳的出口带 viaRelay；出口最多 20 台", () => {
  const latency = buildGostBalanceProxySpec({ ...base, strategy: "latency" });
  assert.equal(latency.strategy, "latency");
  assert.equal(latency.latencyMarginMs, DEFAULT_BALANCE_DETECT.latencyMarginMs);
  assert.equal("preferFastest" in latency, false, "不再借主备 + 择优来做延迟优先");
  assert.equal(buildGostBalanceProxySpec({ ...base, strategy: "latency", detect: { ...DEFAULT_BALANCE_DETECT, latencyMarginMs: 20 } }).latencyMarginMs, 20);
  const relayed = buildGostBalanceProxySpec({ ...base, exits: exits.map((exit) => ({ ...exit, viaRelay: true })) });
  assert.ok(relayed.targets.every((target) => target.viaRelay === true));
  // tcp / mtcp 隧道：直接探出口机时等 gost 回话；在中转后面的探不到，不带
  const plain = buildGostBalanceProxySpec({ ...base, exits: exits.map((exit) => ({ ...exit, probeRelay: true })) });
  assert.ok(plain.targets.every((target) => target.probeRelay === true));
  const plainRelayed = buildGostBalanceProxySpec({ ...base, exits: exits.map((exit) => ({ ...exit, probeRelay: true, viaRelay: true })) });
  assert.ok(plainRelayed.targets.every((target) => !("probeRelay" in target)));
  assert.ok(buildGostBalanceProxySpec(base).targets.every((target) => !("probeRelay" in target)));
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

test("需要升级运行时：GOST 并联中转的入口机运行时低于 nex6 才提示（只走第一台中转）", () => {
  const hosts = new Map<number, { id: number; name: string; runtimeVersion: string | null }>([
    [1, { id: 1, name: "入口甲", runtimeVersion: "3.2.6-nex5" }],
    [2, { id: 2, name: "入口乙", runtimeVersion: "3.2.6-nex6" }],
    [3, { id: 3, name: "入口丙", runtimeVersion: null }],
  ]);
  const hops = [{ hostId: 1 }, { hostId: 6 }, { hostId: 7 }, { hostId: 8 }];
  const tunnel = { mode: "tls", relayMode: "failover" };
  const issues = tunnelRelayRuntimeIssues(tunnel, hops, [1], hosts);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /入口甲 的 GOST 运行时（3\.2\.6-nex5）低于 nex6/);
  assert.match(issues[0].message, /需要升级运行时$/);
  assert.deepEqual(tunnelRelayRuntimeIssues(tunnel, hops, [2], hosts), []);
  assert.match(tunnelRelayRuntimeIssues(tunnel, hops, [3], hosts)[0].message, /（未知）/, "报不上来的按旧的算");
  assert.deepEqual(tunnelRelayRuntimeIssues({ ...tunnel, relayMode: "chain" }, hops, [1], hosts), [], "顺序中转没有选择器");
  assert.deepEqual(tunnelRelayRuntimeIssues(tunnel, hops.slice(0, 3), [1], hosts), [], "只有一台中转");
  assert.deepEqual(tunnelRelayRuntimeIssues({ ...tunnel, mode: "forwardx" }, hops, [1], hosts), [], "NEX 隧道由 FXP 选中转");
});

/*
  planGostBalanceRules（以前是心跳处理函数里的一大段）：手动指定的出口离线时不理它、照常自动分 —— 和 NEX 隧道
  同一条规矩（评审 F11：以前 GOST 原样把离线的那台交给代理，链路管理里却说「离线时不理它」）。
*/
function planningDeps(pinOnline: boolean) {
  const tunnel = { id: 9, isEnabled: 1, mode: "tls", loadBalanceStrategy: "round_robin", balancePinHostId: 3 };
  return {
    tunnel,
    deps: {
      exitCounts: new Map([[501, 2]]),
      tunnelOf: () => tunnel,
      hopsOf: () => [],
      isCurrentHostExitForRule: () => false,
      chainConnectorFor: () => null,
      balanceExitPorts: () => [47100, 47101],
      hopDialAddress: async () => "",
      primaryExitHost: async () => "198.51.100.2",
      extraExitDialAddress: async () => "198.51.100.3",
      exitEndpoints: () => [
        { primary: true, listenPort: 40001, exitHostId: 2 },
        { primary: false, listenPort: 40002, exitHostId: 3, exitSeq: 1, node: {} },
      ],
      transportOf: () => "tls",
      buildNode: (name: string, addr: string) => ({ name, addr }),
      endpointAddr: (host: string, port: number) => `${host}:${port}`,
      exitTargetStates: () => [],
      exitTargetExcludedHostIds: () => new Set<number>(),
      weightsFor: async () => null,
      failoverPort: () => 41501,
      proxyVersion: () => 1 as const,
      detectFor: () => DEFAULT_BALANCE_DETECT,
      // 心跳里的 pinnedExitHostId：指定的那台离线时给 0
      pinnedExitHostId: async (t: typeof tunnel) => (pinOnline ? Number(t.balancePinHostId) : 0),
      proxyHeaderForward: () => false,
      exitTargetAddr: async () => "203.0.113.10:443",
    },
  };
}

test("GOST 本机代理的计划：每台出口一个本机端口；手动指定的出口离线时不理它", async () => {
  const rule = { id: 501, tunnelId: 9, protocol: "both", isEnabled: 1, pendingDelete: 0 };
  const online = await planGostBalanceRules([rule], planningDeps(true).deps);
  const plan = online.get(501)!;
  assert.deepEqual(plan.exits.map((exit) => [exit.hostId, exit.localPort, exit.node.addr]), [[2, 47100, "198.51.100.2:40001"], [3, 47101, "198.51.100.3:40002"]]);
  assert.equal(plan.targetAddr, "203.0.113.10:443");
  assert.equal(plan.spec.pinnedIndex, 1, "在线的指定出口照常交给代理");
  const offline = await planGostBalanceRules([rule], planningDeps(false).deps);
  assert.equal(offline.get(501)!.spec.pinnedIndex, null, "指定的那台离线：不理它，照常自动分");
  // 端口不够 / 只剩一台出口：不走本机代理
  assert.equal((await planGostBalanceRules([rule], { ...planningDeps(true).deps, balanceExitPorts: () => [47100] })).size, 0);
  assert.equal((await planGostBalanceRules([{ ...rule, isEnabled: 0 }], planningDeps(true).deps)).size, 0);
});

/*
  出口到目标的延迟只有几台知道（问题 A）：不知道的那台以前下发 0，整链只剩入口到出口那一段，延迟优先 / 自动反而
  偏向我们知道得最少的那台。现在带 extraLatencyUnknown（运行时提示，不重建代理），Agent 按已知最大的算。
  一台都不知道时什么都不带（都是 0，和以前一样）。
*/
test("出口到目标的延迟：别的出口知道、这台不知道时带 extraLatencyUnknown；一台都不知道时不带", async () => {
  assert.deepEqual([...gostBalanceUnknownExtraLatency([21, 22, 23], new Map([[21, 12]]))], [22, 23]);
  // 同一台机房里不到 1 毫秒：按 1 下发（Agent 那边 0 = 没有）
  assert.equal(buildGostBalanceProxySpec({ ...base, extraLatencyMs: new Map([[21, 0.3]]) }).targets[0].extraLatencyMs, 1);
  assert.deepEqual([...gostBalanceUnknownExtraLatency([21, 22], new Map())], []);
  assert.deepEqual([...gostBalanceUnknownExtraLatency([21, 22], new Map([[21, 12], [22, 30]]))], []);
  const spec = buildGostBalanceProxySpec({ ...base, extraLatencyMs: new Map([[21, 12]]), extraLatencyUnknown: new Set([22, 23]) });
  assert.deepEqual(spec.targets.map((target) => [target.extraLatencyMs, target.extraLatencyUnknown]), [[12, undefined], [undefined, true], [undefined, true]]);

  const rule = { id: 501, tunnelId: 9, protocol: "both", isEnabled: 1, pendingDelete: 0 };
  const states = (list: Array<{ hostId: number; down?: boolean; medianMs?: number | null }>) => ({ ...planningDeps(true).deps, exitTargetStates: () => list });
  // 主出口报了 9 ms，额外出口没报（或报的不通）：额外出口不知道
  for (const list of [[{ hostId: 2, medianMs: 9 }], [{ hostId: 2, medianMs: 9 }, { hostId: 3, down: true, medianMs: 4 }]]) {
    const plan = (await planGostBalanceRules([rule], states(list))).get(501)!;
    assert.deepEqual(plan.spec.targets.map((target) => [target.extraLatencyMs, target.extraLatencyUnknown]), [[9, undefined], [undefined, true]]);
  }
  const none = (await planGostBalanceRules([rule], states([]))).get(501)!;
  assert.deepEqual(none.spec.targets.map((target) => [target.extraLatencyMs, target.extraLatencyUnknown]), [[undefined, undefined], [undefined, undefined]]);
});

test("规格：延迟优先开了「只走最快的一台」带 fastestOnly，分配方式仍是 latency；别的分配方式、没开时都不带", () => {
  const fastest = buildGostBalanceProxySpec({ ...base, strategy: "latency", detect: { ...DEFAULT_BALANCE_DETECT, fastestOnly: true, latencyMarginMs: 30 } });
  assert.equal(fastest.strategy, "latency", "用户看到的还是延迟优先，不是主备");
  assert.equal(fastest.fastestOnly, true);
  assert.equal(fastest.latencyMarginMs, 30);
  assert.equal("preferFastest" in fastest, false, "不借主备 + 择优");
  assert.equal("fastestOnly" in buildGostBalanceProxySpec({ ...base, strategy: "latency" }), false);
  assert.equal("fastestOnly" in buildGostBalanceProxySpec({ ...base, strategy: "auto", detect: { ...DEFAULT_BALANCE_DETECT, fastestOnly: true } }), false);
});
