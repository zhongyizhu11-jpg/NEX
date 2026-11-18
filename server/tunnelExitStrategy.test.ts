import assert from "node:assert/strict";
import test from "node:test";
import { exitGroupUsesMultipleExits, normalizeExitGroupStrategy } from "../shared/exitStrategy";
import {
  forwardXExitStrategy,
  gostExitSelector,
  gostNoBypassGuardNode,
  gostRuntimeHasNoBypassFix,
  planExitGroupTunnelEndpoints,
  shouldUseFastTunnelFailover,
  withGostNoBypassGuard,
} from "./tunnelExitStrategy";

test("normalizes exit-group strategies without enabling unknown values", () => {
  assert.equal(normalizeExitGroupStrategy("fallback"), "fallback");
  assert.equal(normalizeExitGroupStrategy("IP_HASH"), "ip_hash");
  assert.equal(normalizeExitGroupStrategy("unsupported"), "round_robin");
  assert.equal(exitGroupUsesMultipleExits("none"), false);
  assert.equal(exitGroupUsesMultipleExits("random"), true);
});

test("maps shared exit strategies to GOST and NEX selectors", () => {
  assert.deepEqual(gostExitSelector("fallback"), {
    strategy: "fifo",
    maxFails: 1,
    failTimeout: "5s",
  });
  assert.equal(gostExitSelector("random").strategy, "random");
  assert.equal(gostExitSelector("ip_hash").strategy, "hash");
  assert.equal(forwardXExitStrategy("none"), "round_robin");
  assert.equal(forwardXExitStrategy("ip_hash"), "ip_hash");
});

test("enables fast dialing for every multi-exit strategy", () => {
  assert.equal(shouldUseFastTunnelFailover(0), false);
  assert.equal(shouldUseFastTunnelFailover(1), false);
  assert.equal(shouldUseFastTunnelFailover(2), true);
  assert.equal(shouldUseFastTunnelFailover(1, true), true);
});

test("reorders exit-group endpoints without changing ports already assigned to a host", () => {
  const endpoints = planExitGroupTunnelEndpoints([
    { hostId: 2, priority: 0, connectHost: "2001:db8::2" },
    { hostId: 1, priority: 1 },
    { hostId: 3, priority: 2, isEnabled: false },
  ], [
    { hostId: 1, listenPort: 21001, mimicPort: 31001 },
    { hostId: 2, listenPort: 21002, mimicPort: 31002 },
    { hostId: 4, listenPort: 21004, mimicPort: 31004 },
  ]);

  assert.deepEqual(endpoints, [
    { hostId: 2, listenPort: 21002, mimicPort: 31002, connectHost: "2001:db8::2" },
    { hostId: 1, listenPort: 21001, mimicPort: 31001, connectHost: null },
  ]);
});

test("leaves a new exit-group member without a port so the repository can allocate one", () => {
  const endpoints = planExitGroupTunnelEndpoints([
    { hostId: 5, priority: 0 },
    { hostId: 2, priority: 1 },
  ], [
    { hostId: 2, listenPort: 22002, mimicPort: 0 },
  ]);

  assert.deepEqual(endpoints, [
    { hostId: 5, listenPort: 0, mimicPort: 0, connectHost: null },
    { hostId: 2, listenPort: 22002, mimicPort: 0, connectHost: null },
  ]);
});

test("treats string database false values as disabled exit members", () => {
  const endpoints = planExitGroupTunnelEndpoints([
    { hostId: 1, priority: 0, isEnabled: "0" as any },
    { hostId: 2, priority: 1, isEnabled: "false" as any },
    { hostId: 3, priority: 2, isEnabled: "1" as any },
  ], []);

  assert.deepEqual(endpoints, [
    { hostId: 3, listenPort: 0, mimicPort: 0, connectHost: null },
  ]);
});

test("only runtimes before nex6 get the no-bypass guard node, and only on multi-node hops", () => {
  assert.equal(gostRuntimeHasNoBypassFix("3.2.6-nex6"), true);
  assert.equal(gostRuntimeHasNoBypassFix("3.2.6-nex12"), true);
  assert.equal(gostRuntimeHasNoBypassFix("3.2.6-nex5"), false);
  assert.equal(gostRuntimeHasNoBypassFix("3.2.6"), false);
  assert.equal(gostRuntimeHasNoBypassFix(""), false);
  assert.equal(gostRuntimeHasNoBypassFix(null), false);
  assert.equal(gostRuntimeHasNoBypassFix("unknown"), false);

  const nodes = [{ name: "exit-1-0" }, { name: "exit-1-1" }];
  assert.equal(withGostNoBypassGuard(nodes, "guard-1", "3.2.6-nex6"), nodes);
  assert.equal(withGostNoBypassGuard([nodes[0]], "guard-1", "3.2.6-nex5").length, 1);
  const guarded = withGostNoBypassGuard(nodes, "guard-1", "3.2.6-nex5");
  assert.deepEqual(guarded.slice(0, 2), nodes);
  assert.deepEqual(guarded[2], gostNoBypassGuardNode("guard-1"));
  const guard = gostNoBypassGuardNode("guard-1");
  // 端口 0 拨不通；backup 让它平时不参与；maxFails 必须是字符串（gost 不认 JSON 数字）
  assert.equal(guard.addr, "127.0.0.1:0");
  assert.equal(guard.metadata.backup, true);
  assert.equal(typeof guard.metadata.maxFails, "string");
  assert.ok(Number(guard.metadata.maxFails) > 1_000_000);
});
