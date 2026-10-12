import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTunnelRuntimeStatus,
  clearTunnelRuntimeStatusForHost,
  getTunnelRuntimeTopologyStatus,
  getTunnelWireGuardPlane,
  replaceHostWireGuardPlanes,
  recordTunnelRuntimeHostStatus,
} from "./tunnelRuntimeStatus";

test("runtime topology distinguishes chain and relay failover", () => {
  const tunnelId = 91;
  clearTunnelRuntimeStatus(tunnelId);
  recordTunnelRuntimeHostStatus(tunnelId, 1, true);
  recordTunnelRuntimeHostStatus(tunnelId, 2, true);
  recordTunnelRuntimeHostStatus(tunnelId, 3, false);
  recordTunnelRuntimeHostStatus(tunnelId, 4, true);
  const topology = { hopHostIds: [1, 2, 3, 4], primaryExitHostId: 4 };
  assert.equal(getTunnelRuntimeTopologyStatus(tunnelId, { ...topology, relayMode: "chain" }).running, false);
  assert.equal(getTunnelRuntimeTopologyStatus(tunnelId, { ...topology, relayMode: "failover" }).running, true);
});

test("runtime topology accepts a healthy extra exit and clears offline hosts", () => {
  const tunnelId = 92;
  clearTunnelRuntimeStatus(tunnelId);
  recordTunnelRuntimeHostStatus(tunnelId, 10, false);
  recordTunnelRuntimeHostStatus(tunnelId, 11, true);
  const status = getTunnelRuntimeTopologyStatus(tunnelId, {
    primaryExitHostId: 10,
    extraExitHostIds: [11],
    loadBalanceEnabled: true,
    loadBalanceStrategy: "fallback",
  });
  assert.equal(status.running, true);
  assert.deepEqual(clearTunnelRuntimeStatusForHost(11), [tunnelId]);
  assert.equal(getTunnelRuntimeTopologyStatus(tunnelId, {
    primaryExitHostId: 10,
    extraExitHostIds: [11],
    loadBalanceEnabled: true,
    loadBalanceStrategy: "fallback",
  }).running, false);
});

test("NEX V2 隧道的 WireGuard 数据面按主机汇总，主机掉线就清掉", () => {
  replaceHostWireGuardPlanes(9101, [{ tunnelId: 9901, plane: "kernel" }]);
  replaceHostWireGuardPlanes(9102, [{ tunnelId: 9901, plane: "kernel" }, { tunnelId: 9902, plane: "netstack" }]);
  assert.equal(getTunnelWireGuardPlane(9901), "kernel");
  assert.equal(getTunnelWireGuardPlane(9902), "netstack");
  // 一台退回用户态：整条隧道算混用。
  replaceHostWireGuardPlanes(9102, [{ tunnelId: 9901, plane: "netstack" }]);
  assert.equal(getTunnelWireGuardPlane(9901), "mixed");
  // 这次没报 9902：记录被替换掉。
  assert.equal(getTunnelWireGuardPlane(9902), undefined);
  clearTunnelRuntimeStatusForHost(9102);
  assert.equal(getTunnelWireGuardPlane(9901), "kernel");
  clearTunnelRuntimeStatusForHost(9101);
  assert.equal(getTunnelWireGuardPlane(9901), undefined);
});
