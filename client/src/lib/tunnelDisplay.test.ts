import assert from "node:assert/strict";
import test from "node:test";
import { moveExitInGroup, tunnelBalanceExits, getTunnelExitNames, getTunnelRouteText, tunnelTestIndicatesTimeout } from "./tunnelDisplay";

const hosts = [
  { id: 1, name: "广州 01" },
  { id: 2, name: "香港 07" },
  { id: 3, name: "香港 23" },
  { id: 4, name: "东京 09" },
];

test("keeps multi-exit names in the route without a redundant mode label", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceExits: [{ hostId: 3 }],
  };

  assert.deepEqual(getTunnelExitNames(tunnel, hosts), ["香港 07", "香港 23"]);
  assert.equal(getTunnelRouteText(tunnel, hosts), "广州 01 -> 香港 07；出口：香港 07 / 香港 23");
  assert.equal(getTunnelRouteText(tunnel, hosts).includes("多出口"), false);
});

test("uses the exit group name as the route endpoint and keeps member names in the exit summary", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceExits: [{ hostId: 3 }],
  };

  assert.equal(
    getTunnelRouteText(tunnel, hosts, "18.02"),
    "\u5E7F\u5DDE 01 -> 18.02\uFF1B\u51FA\u53E3\uFF1A\u9999\u6E2F 07 / \u9999\u6E2F 23",
  );
});

test("does not append an exit summary to single-exit tunnels", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceExits: [],
  };

  assert.equal(getTunnelRouteText(tunnel, hosts), "广州 01 -> 香港 07");
});

test("the legacy none strategy is fallback: backup exits are displayed", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceStrategy: "none",
    loadBalanceExits: [{ hostId: 3 }],
  };

  assert.equal(getTunnelExitNames(tunnel, hosts).length, 2);
});

test("renders relay failover candidates as alternatives instead of a serial chain", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 4,
    hopHostIds: [1, 2, 3, 4],
    relayMode: "failover",
    loadBalanceExits: [],
  };

  assert.equal(getTunnelRouteText(tunnel, hosts), "广州 01 -> 中转：香港 07 / 香港 23 -> 东京 09");
});

test("uses the aggregate result when one multi-exit branch fails", () => {
  const details = [
    { success: false, latencyMs: null, message: "primary timeout" },
    { success: true, latencyMs: 105, message: null },
  ];

  assert.equal(tunnelTestIndicatesTimeout({ status: "success", details }), false);
  assert.equal(tunnelTestIndicatesTimeout({ status: "failed", details }), true);
  assert.equal(tunnelTestIndicatesTimeout({ details }), false);
});

test("balanced exits: exit-group order (disabled members skipped), pending ↑↓ order wins, plain tunnels by seq", () => {
  const members = [
    { id: 11, hostId: 2, memberType: "host", priority: 0, aggregationWeight: 5 },
    { id: 12, hostId: 3, memberType: "host", priority: 1, aggregationWeight: 0 },
    { id: 13, hostId: 4, memberType: "host", priority: 2, aggregationWeight: 2 },
  ];
  assert.deepEqual(tunnelBalanceExits({}, members), [{ hostId: 2, weight: 5 }, { hostId: 3, weight: null }, { hostId: 4, weight: 2 }]);
  assert.deepEqual(tunnelBalanceExits({}, members, [4, 2, 3]).map((exit) => exit.hostId), [4, 2, 3]);
  assert.deepEqual(tunnelBalanceExits({}, members, [4, 2]).map((exit) => exit.hostId), [2, 3, 4], "stale override ignored");
  assert.deepEqual(
    tunnelBalanceExits({ exitHostId: 7, loadBalanceExits: [{ hostId: 9, seq: 2 }, { hostId: 8, seq: 1, weight: 3 }, { hostId: 6, isEnabled: false }] }, []),
    [{ hostId: 7, weight: null }, { hostId: 8, weight: 3 }, { hostId: 9, weight: null }],
  );
});

test("moving an exit swaps it with its neighbour and keeps disabled / non-host members in place", () => {
  const all = [
    { id: 11, hostId: 2, memberType: "host", priority: 0 },
    { id: 20, hostId: null, memberType: "tunnel", priority: 1 },
    { id: 12, hostId: 3, memberType: "host", priority: 2 },
    { id: 13, hostId: 4, memberType: "host", priority: 3 },
  ];
  assert.deepEqual(moveExitInGroup(all, [2, 3, 4], 3, -1), { hostIds: [3, 2, 4], memberIds: [12, 20, 11, 13] });
  assert.equal(moveExitInGroup(all, [2, 3, 4], 2, -1), null);
  assert.equal(moveExitInGroup(all, [2, 3, 4], 4, 1), null);
});
