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
import { stableActionSignature, stableActionSignatureHash, stableDesiredStateHash, withDesiredStateConfigHash } from "./agentDesiredStateHash";
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

test("the heartbeat route keeps exporting the moved helpers", async () => {
  const route = await import("./agentHeartbeatRoute");
  assert.equal(route.stableStateSignature, stableStateSignature);
  assert.equal(route.stableDesiredStateHash, stableDesiredStateHash);
  assert.equal(route.withDesiredStateConfigHash, withDesiredStateConfigHash);
});
