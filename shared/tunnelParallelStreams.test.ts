import assert from "node:assert/strict";
import test from "node:test";

import {
  buildParallelStreamLegs,
  describeTunnelParallelStreams,
  normalizeTunnelParallelStreams,
  tunnelParallelStreamsAgentsReady,
  tunnelParallelStreamsUnavailableReason,
} from "./tunnelParallelStreams";

test("档位：0 / 1 / 坏值是单路，最多 8 路", () => {
  assert.equal(normalizeTunnelParallelStreams(undefined), 1);
  assert.equal(normalizeTunnelParallelStreams(0), 1);
  assert.equal(normalizeTunnelParallelStreams("abc"), 1);
  assert.equal(normalizeTunnelParallelStreams(4), 4);
  assert.equal(normalizeTunnelParallelStreams(4.7), 4);
  assert.equal(normalizeTunnelParallelStreams(99), 8);
  assert.equal(describeTunnelParallelStreams(1), "单路");
  assert.equal(describeTunnelParallelStreams(4), "4 路并发");
});

test("哪些隧道能开：NEX V1、不是并排中转、单出口", () => {
  const nex = { mode: "forwardx", forwardxVersion: "v1", relayMode: "chain" };
  assert.equal(tunnelParallelStreamsUnavailableReason(nex, []), "");
  assert.equal(tunnelParallelStreamsUnavailableReason({ ...nex, relayMode: "chain" }, [{}, {}, {}]), "", "链式中转可以：每条腿都走同一条链");
  assert.match(tunnelParallelStreamsUnavailableReason({ mode: "tls" }, []), /只有 NEX/);
  assert.match(tunnelParallelStreamsUnavailableReason({ ...nex, forwardxVersion: "v2" }, []), /WireGuard/);
  assert.match(tunnelParallelStreamsUnavailableReason({ ...nex, relayMode: "aggregate" }, [{}, {}, {}, {}]), /叠加/);
  assert.match(tunnelParallelStreamsUnavailableReason(nex, [], 2), /多出口/);
});

test("旧版本退回单路：入口要 2.2.231，中转 / 出口要 2.2.194", () => {
  assert.equal(tunnelParallelStreamsAgentsReady("2.2.231", ["2.2.194"]), true);
  assert.equal(tunnelParallelStreamsAgentsReady("2.2.230", ["2.2.231"]), false, "老入口会把同一地址的腿去重成一条");
  assert.equal(tunnelParallelStreamsAgentsReady("2.2.231", ["2.2.193"]), false, "出口不会收多路会话");
  assert.equal(tunnelParallelStreamsAgentsReady("", []), false);
});

test("腿：同一个出口重复 N 条，各带 stream#N（Agent 按地址 + via 去重）", () => {
  assert.deepEqual(buildParallelStreamLegs({ host: "203.0.113.5", port: 40000, key: "k" }, 3), [
    { host: "203.0.113.5", port: 40000, key: "k", via: "stream#1" },
    { host: "203.0.113.5", port: 40000, key: "k", via: "stream#2" },
    { host: "203.0.113.5", port: 40000, key: "k", via: "stream#3" },
  ]);
  assert.deepEqual(buildParallelStreamLegs({ host: "203.0.113.5", port: 40000, key: "k" }, 1), []);
  assert.deepEqual(buildParallelStreamLegs({ host: "", port: 40000, key: "k" }, 4), []);
});
