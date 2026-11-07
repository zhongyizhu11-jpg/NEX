import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_LOCAL_STATE_LIMITS,
  normalizeAgentLocalRuntimeState,
  normalizeAgentStateSignatures,
  normalizeMimicEnvironment,
  normalizeRuntimeStateSignature,
  stableStateSignature,
} from "./agentHeartbeatReport";
import { failoverWithoutRuntimeHints, stableActionSignature, stableActionSignatureHash, stableDesiredStateHash, withDesiredStateConfigHash } from "./agentDesiredStateHash";
import { shouldSendDesiredState } from "./agentHeartbeatDispatch";
import { hashConfig } from "./configAudit";

test("local runtime state is normalized into the panel's shape", () => {
  const state = normalizeAgentLocalRuntimeState({
    rules: [
      { port: "8080", ruleId: "7", tunnelId: 0, forwardType: " gost ", targetIp: " 1.2.3.4 ", targetPort: "80", protocol: "tcp", transportVersion: "V2", ready: false },
      { port: 0, ruleId: 9 },
      { port: 9000, ruleId: 9, transportVersion: "v3" },
    ],
    tunnels: [
      { port: 443, tunnelId: 3, forwardType: "forwardx-tunnel", transportVersion: "v1", wireGuardPlane: "KERNEL" },
      { port: 444, tunnelId: 0 },
    ],
    services: [{ name: " realm ", active: true, hasWork: 1, status: "running" }, { name: "" }],
    wireGuardPlanes: [{ tunnelId: 3, plane: "netstack" }, { tunnelId: 4, plane: "other" }],
  });
  assert.deepEqual(state, {
    rules: [
      { port: 8080, ruleId: 7, tunnelId: undefined, forwardType: "gost", targetIp: "1.2.3.4", targetPort: 80, protocol: "tcp", transportVersion: "v2", ready: false },
      { port: 9000, ruleId: 9, tunnelId: undefined, forwardType: "", targetIp: undefined, targetPort: undefined, protocol: undefined, transportVersion: undefined, ready: true },
    ],
    tunnels: [{ port: 443, tunnelId: 3, forwardType: "forwardx-tunnel", transportVersion: "v1", wireGuardPlane: "kernel", ready: true }],
    services: [{ name: "realm", active: true, hasWork: false, status: "running", message: undefined, hooksReady: undefined, connectionState: undefined }],
    wireGuardPlanes: [{ tunnelId: 3, plane: "netstack" }],
  });
  assert.equal(normalizeAgentLocalRuntimeState(null), null);
  assert.equal(normalizeAgentLocalRuntimeState("x"), null);
  assert.deepEqual(normalizeAgentLocalRuntimeState({}), { rules: [], tunnels: [], services: [], wireGuardPlanes: [] });
});

test("oversized local runtime state reports are capped", () => {
  const rules = Array.from({ length: AGENT_LOCAL_STATE_LIMITS.rules + 50 }, (_, index) => ({ port: index + 1, ruleId: index + 1, forwardType: "x".repeat(10_000) }));
  const services = Array.from({ length: 1000 }, (_, index) => ({ name: `svc-${index}`, active: true }));
  const state = normalizeAgentLocalRuntimeState({ rules, services })!;
  assert.equal(state.rules.length, AGENT_LOCAL_STATE_LIMITS.rules);
  assert.equal(state.rules[0].forwardType.length, AGENT_LOCAL_STATE_LIMITS.text);
  assert.equal(state.services.length, AGENT_LOCAL_STATE_LIMITS.services);
});

test("state signatures and small report fields are validated", () => {
  const hash = "A".repeat(64);
  assert.deepEqual(normalizeAgentStateSignatures({ runningRules: hash, dnsWatch: "short", bogus: hash }), { runningRules: hash.toLowerCase() });
  assert.deepEqual(normalizeAgentStateSignatures(null), {});
  assert.equal(normalizeRuntimeStateSignature(" ABC123 "), "abc123");
  assert.equal(normalizeRuntimeStateSignature("not hex!"), "");
  assert.equal(normalizeMimicEnvironment({ available: "yes" }), null);
  assert.deepEqual(normalizeMimicEnvironment({ available: true }), { available: true, version: null, status: "ready", message: null });
});

test("state section signatures do not depend on array or key order", () => {
  const a = stableStateSignature([{ port: 1, ruleId: 2 }, { port: 3, ruleId: 4 }]);
  const b = stableStateSignature([{ ruleId: 4, port: 3 }, { ruleId: 2, port: 1 }]);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, stableStateSignature([{ port: 1, ruleId: 2 }]));
});

test("desired state hashes ignore delivery fields and match the per-action config hash", () => {
  const action = { op: "apply", ruleId: 7, sourcePort: 8080, commands: ["a"] };
  const pieces = new WeakMap<object, string>();
  const hashed = withDesiredStateConfigHash(action, pieces);
  assert.equal(hashed.configHash, hashConfig(action));
  assert.equal(stableDesiredStateHash([hashed], pieces), stableDesiredStateHash([{ ...action, issuedAt: 5, configHash: "other" }]));
  assert.notEqual(stableDesiredStateHash([action]), stableDesiredStateHash([{ ...action, ruleId: 8 }]));
  // 动作签名只看会影响 Agent 行为的字段
  assert.equal(stableActionSignature([{ ...action, issuedAt: 1 }]), stableActionSignature([{ ...action, issuedAt: 2 }]));
  assert.notEqual(stableActionSignatureHash([action]), stableActionSignatureHash([action], "prefix"));
});

/*
  线路组规格里的运行时提示（中转异常、下游延迟、沿途负载、出口 IP）：只是它们变了不算动作变了 —— 不重发整份期望状态、
  configHash 和整批摘要都不变（Agent 报上来的已执行摘要一直对得上）；提示照样留在动作里（Agent 执行动作时也会换上）。
  行为参数（地址、权重、探测方式）变了照样算变。没带提示的动作原样返回，摘要和以前逐字节相同。
*/
test("route-group runtime hints do not count as a desired-state change", () => {
  const routeAction = (targets: any[]) => ({ op: "apply", ruleId: 7, sourcePort: 30001, forwardType: "realm", failover: { enabled: true, listenPort: 65040, strategy: "auto", targets } });
  const plainTargets = () => [
    { targetIp: "10.0.0.1", targetPort: 1, weight: 1 },
    { targetIp: "10.0.0.2", targetPort: 2, weight: 1, probeUdpEcho: true },
  ];
  const plain = routeAction(plainTargets());
  const hinted = routeAction([
    { ...plainTargets()[0], loadPct: 90, exitIp: "203.0.113.9", extraLatencyMs: 12 },
    { ...plainTargets()[1], down: true, downReason: "maintenance: HK2" },
  ]);
  assert.equal(stableActionSignature([plain]), stableActionSignature([hinted]));
  assert.equal(stableDesiredStateHash([plain]), stableDesiredStateHash([hinted]));
  const pieces = new WeakMap<object, string>();
  const plainHashed = withDesiredStateConfigHash(plain, pieces);
  const hintedHashed = withDesiredStateConfigHash(hinted, pieces);
  assert.equal(plainHashed.configHash, hintedHashed.configHash);
  assert.equal(stableDesiredStateHash([hintedHashed], pieces), stableDesiredStateHash([plainHashed], pieces));
  assert.equal(hintedHashed.failover.targets[0].loadPct, 90, "动作里照样带着提示");
  assert.equal(hinted.failover.targets[1].downReason, "maintenance: HK2", "算摘要不改原动作");

  // 发过一次之后只是提示变了：不重发
  const hostId = 990_001;
  assert.equal(shouldSendDesiredState(hostId, [plain], [], 1_000, 3), true);
  assert.equal(shouldSendDesiredState(hostId, [hinted], [], 2_000, 3), false);

  const behaviourChanges: Array<[string, any[]]> = [
    ["weight", [{ ...plainTargets()[0], weight: 5 }, plainTargets()[1]]],
    ["probeUdpEcho", [plainTargets()[0], { ...plainTargets()[1], probeUdpEcho: undefined }]],
    ["targetPort", [{ ...plainTargets()[0], targetPort: 9 }, plainTargets()[1]]],
  ];
  for (const [name, targets] of behaviourChanges) {
    const changed = routeAction(targets);
    assert.notEqual(stableActionSignature([changed]), stableActionSignature([plain]), `${name} 是行为参数`);
    assert.notEqual(stableDesiredStateHash([changed]), stableDesiredStateHash([plain]), `${name} 是行为参数`);
  }
  assert.equal(shouldSendDesiredState(hostId, [routeAction([{ ...plainTargets()[0], weight: 5 }, plainTargets()[1]])], [], 3_000, 3), true, "行为参数变了要发");

  // 没带提示：同一个对象，摘要和直接 hashConfig 一样
  assert.equal(failoverWithoutRuntimeHints(plain.failover), plain.failover);
  assert.equal(withDesiredStateConfigHash(plain, new WeakMap()).configHash, hashConfig(plain));
  assert.equal(failoverWithoutRuntimeHints(null), null);
  assert.deepEqual(failoverWithoutRuntimeHints({ enabled: true }), { enabled: true });
});

test("the heartbeat route keeps exporting the moved helpers", async () => {
  const route = await import("./agentHeartbeatRoute");
  assert.equal(route.stableStateSignature, stableStateSignature);
  assert.equal(route.stableDesiredStateHash, stableDesiredStateHash);
  assert.equal(route.withDesiredStateConfigHash, withDesiredStateConfigHash);
});
