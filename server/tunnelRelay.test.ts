import assert from "node:assert/strict";
import test from "node:test";
import {
  isTunnelRelayAggregate,
  isTunnelRelayFailover,
  normalizeTunnelRelayMode,
  tunnelRelayAggregateSupported,
  tunnelRelayCandidates,
  tunnelRelayFailoverSupported,
  tunnelRelayModeAvailability,
  tunnelRelayUsesParallelRelays,
} from "../shared/tunnelRelay";

test("tunnel relay mode defaults to the existing chain behavior", () => {
  assert.equal(normalizeTunnelRelayMode(null), "chain");
  assert.equal(normalizeTunnelRelayMode("unknown"), "chain");
  assert.equal(normalizeTunnelRelayMode("failover"), "failover");
});

test("relay failover requires a supported runtime and at least two relay candidates", () => {
  const hops = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.deepEqual(tunnelRelayCandidates(hops), [{ id: 2 }, { id: 3 }]);
  assert.equal(tunnelRelayFailoverSupported("forwardx"), true);
  assert.equal(tunnelRelayFailoverSupported("tls"), true);
  assert.equal(tunnelRelayFailoverSupported("nginx_stream"), false);
  assert.equal(isTunnelRelayFailover({ relayMode: "failover", mode: "forwardx" }, hops), true);
  assert.equal(isTunnelRelayFailover({ relayMode: "failover", mode: "forwardx" }, hops.slice(0, 3)), false);
  assert.equal(isTunnelRelayFailover({ relayMode: "failover", mode: "nginx_stream" }, hops), false);
});

test("aggregate mode is recognised only for the NEX protocol", () => {
  const hops = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.equal(normalizeTunnelRelayMode("aggregate"), "aggregate");
  assert.equal(tunnelRelayAggregateSupported("forwardx"), true);
  // GOST transports can fail over between relays but cannot stripe one stream.
  assert.equal(tunnelRelayAggregateSupported("tls"), false);
  assert.equal(tunnelRelayAggregateSupported("nginx_stream"), false);
  assert.equal(isTunnelRelayAggregate({ relayMode: "aggregate", mode: "forwardx" }, hops), true);
  assert.equal(isTunnelRelayAggregate({ relayMode: "aggregate", mode: "tls" }, hops), false);
});

test("aggregation needs at least two relays to combine", () => {
  const oneRelay = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(tunnelRelayCandidates(oneRelay).length, 1);
  assert.equal(isTunnelRelayAggregate({ relayMode: "aggregate", mode: "forwardx" }, oneRelay), false);
});

test("failover and aggregation share the side-by-side relay topology", () => {
  const hops = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.equal(tunnelRelayUsesParallelRelays({ relayMode: "failover", mode: "forwardx" }, hops), true);
  assert.equal(tunnelRelayUsesParallelRelays({ relayMode: "aggregate", mode: "forwardx" }, hops), true);
  // A serial chain keeps its hop-to-hop routing.
  assert.equal(tunnelRelayUsesParallelRelays({ relayMode: "chain", mode: "forwardx" }, hops), false);
});

test("aggregate and failover stay distinct so the entry knows which to run", () => {
  const hops = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const aggregate = { relayMode: "aggregate", mode: "forwardx" };
  assert.equal(isTunnelRelayFailover(aggregate, hops), false);
  assert.equal(isTunnelRelayAggregate(aggregate, hops), true);
  const failover = { relayMode: "failover", mode: "forwardx" };
  assert.equal(isTunnelRelayFailover(failover, hops), true);
  assert.equal(isTunnelRelayAggregate(failover, hops), false);
});

test("relay mode availability explains why a mode cannot be picked", () => {
  const none = tunnelRelayModeAvailability({ relayCount: 0, aggregateSupported: true });
  assert.equal(none.failover.available, false);
  assert.match(none.failover.reason, /当前 0 台/);
  assert.equal(none.aggregate.available, false);
  assert.match(none.aggregate.reason, /当前 0 台/);

  const one = tunnelRelayModeAvailability({ relayCount: 1, aggregateSupported: true });
  assert.equal(one.aggregate.available, false);
  assert.match(one.aggregate.reason, /当前 1 台/);

  const two = tunnelRelayModeAvailability({ relayCount: 2, aggregateSupported: true });
  assert.equal(two.failover.available, true);
  assert.equal(two.failover.reason, "");
  assert.equal(two.aggregate.available, true);
  assert.equal(two.aggregate.reason, "");
});

test("an unsupported protocol is reported instead of a misleading relay count", () => {
  // Telling the operator to add relays would be wrong when the transport cannot
  // stripe a connection at all, so the protocol reason wins.
  const gost = tunnelRelayModeAvailability({ relayCount: 0, aggregateSupported: false });
  assert.equal(gost.aggregate.available, false);
  assert.match(gost.aggregate.reason, /仅 NEX/);
  // Failover still works on those transports, so it keeps the relay-count reason.
  assert.match(gost.failover.reason, /当前 0 台/);

  const gostWithRelays = tunnelRelayModeAvailability({ relayCount: 3, aggregateSupported: false });
  assert.equal(gostWithRelays.failover.available, true);
  assert.equal(gostWithRelays.aggregate.available, false);
  assert.match(gostWithRelays.aggregate.reason, /仅 NEX/);
});

test("a malformed relay count is treated as zero rather than throwing", () => {
  const bad = tunnelRelayModeAvailability({ relayCount: Number.NaN, aggregateSupported: true });
  assert.equal(bad.failover.available, false);
  assert.match(bad.failover.reason, /当前 0 台/);
  const negative = tunnelRelayModeAvailability({ relayCount: -3, aggregateSupported: true });
  assert.match(negative.aggregate.reason, /当前 0 台/);
});
