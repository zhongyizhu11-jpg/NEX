import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PORT_ACCESS_LIMIT_AGENT_VERSION,
  agentSupportsPortAccessLimits,
  onlyPortAccessLimitChanged,
  portAccessLimitAction,
  portAccessLimitsEnabled,
  portAccessLimitSpecs,
} from "./portAccessLimits";

test("only per-IP limit changes bypass ordinary runtime restarts; maxConnections is tunnel-only", () => {
  const before = { maxIPs: 2, maxConnections: 100, gostRateLimitIn: 10, gostRateLimitOut: 20, canAddRules: true };
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxIPs: 3 }), true);
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxIPs: 0 }), true);
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxConnections: 50 }), false);
  assert.equal(onlyPortAccessLimitChanged(before, before), false);
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxIPs: 3, gostRateLimitIn: 30 }), false);
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxIPs: 3, canAddRules: false }), false);
  assert.equal(onlyPortAccessLimitChanged(null, before), false);
});

test("all ordinary forwarding backends share TCP limits per user on the entry host", () => {
  const rules = ["iptables", "nftables", "realm", "socat", "gost", "nginx", "guard"].map((forwardType, i) => ({
    userId: 7, sourcePort: 22000 + i, protocol: i % 2 ? "both" : "tcp", forwardType,
  }));
  rules.push({ userId: 8, sourcePort: 65535, protocol: "tcp", forwardType: "realm" });
  const specs = portAccessLimitSpecs(rules, (user) => ({ maxIPs: user === 7 ? 2 : 0, maxConnections: user === 8 ? 40 : 0 }));
  assert.deepEqual(specs, [
    { userId: 7, maxIPs: 2, ports: [22000, 22001, 22002, 22003, 22004, 22005, 22006] },
  ]);
});

test("UDP, tunnel rules, invalid ports and unlimited users do not receive ordinary TCP limits", () => {
  assert.deepEqual(portAccessLimitSpecs([
    { userId: 1, sourcePort: 22, protocol: "udp" },
    { userId: 1, sourcePort: 23, protocol: "tcp", tunnelId: 3 },
    { userId: 1, sourcePort: 65536, protocol: "tcp" },
    { userId: 2, sourcePort: 24, protocol: "both" },
  ], (user) => ({ maxIPs: user === 1 ? 2 : 0, maxConnections: 0 })), []);
});

test("canonical snapshots ignore rule ordering and duplicate ports", () => {
  const rules = [23, 22, 22].map((sourcePort) => ({ userId: 1, sourcePort, protocol: "both" }));
  assert.deepEqual(
    portAccessLimitSpecs(rules, () => ({ maxIPs: 2 })),
    portAccessLimitSpecs([...rules].reverse(), () => ({ maxIPs: 2 })),
  );
});

test("Agent 2.2.229 gate: new Agents always get a snapshot (empty removes limits), old Agents get nothing", () => {
  assert.equal(PORT_ACCESS_LIMIT_AGENT_VERSION, "2.2.229");
  assert.equal(agentSupportsPortAccessLimits("2.2.228"), false);
  assert.equal(agentSupportsPortAccessLimits(""), false);
  assert.equal(agentSupportsPortAccessLimits("2.2.229"), true);
  assert.equal(agentSupportsPortAccessLimits("2.2.230"), true);
  assert.deepEqual(portAccessLimitAction([], true)?.portAccessLimits, []);
  assert.equal(portAccessLimitAction([], false), null);
  const specs = [{ userId: 1, maxIPs: 2, ports: [22] }];
  assert.equal(portAccessLimitAction(specs, false), null);
  const action = portAccessLimitAction(specs, true)!;
  assert.equal(action.statusType, "runtime");
  assert.equal(action.forwardType, "port-access-limit-sync");
  assert.equal(action.sourcePort, 0);
  assert.equal(action.knownRunning, true);
  assert.deepEqual(action.commands, []);
});

test("heartbeat sync covers already-running entry rules without restarting their runtime", () => {
  const source = readFileSync(new URL("./agentHeartbeatRoute.ts", import.meta.url), "utf8");
  const start = source.indexOf("agentSupportsPortAccessLimits(effectiveAgentVersion)");
  const block = source.slice(start, source.indexOf("const effectiveActions = dropStalePortRemoveActions", start));
  assert.ok(start > 0 && block.length > 0, "heartbeat port-limit block not found");
  assert.match(block, /agentHostRules/);
  assert.match(source.slice(start - 80, start), /!deferActionsForLocalState &&/);
  assert.match(block, /runtimeBool\(rule\.pendingDelete\)/);
  assert.match(block, /runtimeBool\(rule\.isEnabled\)/);
  assert.match(block, /isRuleProtocolEnabled/);
  // Only client-facing entries: never relay hops, chain hops, SNI loopbacks or entry bridges.
  assert.match(block, /routeParentRuleId/);
  assert.match(block, /tlsInboundId/);
  assert.match(block, /isEntryBridgeRuntimeRule/);
  assert.match(block, /"chain"/);
  assert.doesNotMatch(block, /rule\.isRunning|restart|resetForward/);
  assert.match(source, /portAccessLimits: action\?\.portAccessLimits \|\| \[\]/);
});

test("the enforcement setting only turns on for an explicit \"true\"", () => {
  assert.equal(portAccessLimitsEnabled("true"), true);
  for (const value of [null, undefined, "", "false", "1", "TRUE"]) assert.equal(portAccessLimitsEnabled(value), false);
});
