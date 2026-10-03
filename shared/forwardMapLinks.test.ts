import assert from "node:assert/strict";
import test from "node:test";

import { buildForwardMapLinks, buildHostAddressIndex } from "./forwardMapLinks";

const hosts = [
  { id: 1, ip: "134.175.173.171", entryIp: "gz.example.com" },
  { id: 2, ipv4: "45.76.10.2", ddnsDomain: "Jinx.Example.com." },
  { id: 3, ipv6: "2001:db8::3" },
];

test("目标地址对上主机：IP、入口域名、DDNS 都认，大小写和末尾的点不算", () => {
  const links = buildForwardMapLinks([
    { id: 10, hostId: 1, targetIp: "jinx.example.com", isEnabled: true },
    { id: 11, hostId: 1, targetIp: "45.76.10.2", isEnabled: false },
    { id: 12, hostId: 2, targetIp: "[2001:db8::3]", isEnabled: true },
    { id: 13, hostId: 2, targetIp: "hkboil.ddos.top", isEnabled: true },
  ], hosts);
  assert.deepEqual(links, [
    { fromHostId: 1, toHostId: 2, rules: 2, enabled: 1 },
    { fromHostId: 2, toHostId: 3, rules: 1, enabled: 1 },
  ]);
});

test("链模板、线路组中继、隧道规则不单算；线路组按路径的中转主机连", () => {
  const links = buildForwardMapLinks([
    { id: 20, hostId: 1, targetIp: "hkboil.ddos.top", isForwardGroupTemplate: true },
    { id: 21, hostId: 2, targetIp: "2001:db8::3", routeParentRuleId: 30 },
    { id: 22, hostId: 1, targetIp: "2001:db8::3", tunnelId: 5 },
    {
      id: 30,
      hostId: 1,
      targetIp: "2001:db8::3",
      targetPort: 443,
      failoverEnabled: true,
      routePaths: JSON.stringify([{ key: "main", name: "", hops: [2], dest: null, weight: 50, probe: null, dial: null, issue: null }]),
    },
  ], hosts);
  assert.deepEqual(links, [
    { fromHostId: 1, toHostId: 2, rules: 1, enabled: 1 },
    { fromHostId: 2, toHostId: 3, rules: 1, enabled: 1 },
  ]);
});

test("租户：任何一端不在他看得到的主机里，这条线不给；指向自己的不画", () => {
  const links = buildForwardMapLinks([
    { id: 40, hostId: 1, targetIp: "45.76.10.2" },
    { id: 41, hostId: 1, targetIp: "134.175.173.171" },
  ], hosts, { visibleHostIds: new Set([1]) });
  assert.deepEqual(links, []);
});

test("两台主机报了同一个地址时，这个地址谁也不认", () => {
  const index = buildHostAddressIndex([{ id: 1, ip: "10.0.0.1" }, { id: 2, entryIp: "10.0.0.1" }, { id: 3, ip: "10.0.0.3" }]);
  assert.equal(index.has("10.0.0.1"), false);
  assert.equal(index.get("10.0.0.3"), 3);
});
