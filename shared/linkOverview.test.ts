import assert from "node:assert/strict";
import test from "node:test";

import { buildLinkOverview } from "./linkOverview";

const direct = (key: string, dest: { ip: string; port: number } | null) => ({ key, name: key, hops: [], dest, weight: 50, probe: null, dial: null });
const paths = JSON.stringify([direct("主线", null), direct("备线", { ip: "198.51.100.9", port: 443 })]);
const rule = (id: number, routeMode: string) => ({
  id, name: `规则${id}`, hostId: 1, sourcePort: 20000 + id, targetIp: "198.51.100.7", targetPort: 443, protocol: "tcp",
  isEnabled: 1, failoverEnabled: 1, failoverStrategy: "fallback", failoverTargets: "[]", routeMode, routePaths: paths, routeSwitchMode: "smooth",
});

const overview = buildLinkOverview({
  hosts: [
    { id: 1, name: "入口" }, { id: 2, name: "出口 A", lineBandwidthMbps: 500 }, { id: 3, name: "出口 B", lineBandwidthMbps: 300 },
    { id: 4, name: "中转 1" }, { id: 5, name: "中转 2" }, { id: 6, name: "出口 C" },
  ],
  tunnels: [
    { id: 10, name: "主备中转", mode: "forwardx", relayMode: "failover", entryHostId: 1, exitHostId: 2 },
    { id: 11, name: "叠加中转", mode: "forwardx", relayMode: "aggregate", entryHostId: 1, exitHostId: 2 },
    { id: 12, name: "并发", mode: "forwardx", parallelStreams: 4, entryHostId: 1, exitHostId: 2 },
    { id: 13, name: "GOST 并发", mode: "tls", parallelStreams: 4, entryHostId: 1, exitHostId: 2 },
    { id: 14, name: "用出口组", mode: "forwardx", exitGroupId: 30, loadBalanceEnabled: 1, loadBalanceStrategy: "weighted", entryHostId: 1, exitHostId: 2 },
    { id: 15, name: "老多出口", mode: "tls", loadBalanceEnabled: 1, loadBalanceStrategy: "random", entryHostId: 1, exitHostId: 2 },
    { id: 16, name: "普通链", mode: "forwardx", relayMode: "chain", entryHostId: 1, exitHostId: 2 },
    { id: 17, name: "热备中转", mode: "forwardx", relayMode: "hot_standby", entryHostId: 1, exitHostId: 2 },
  ],
  hops: [10, 11, 16, 17].flatMap((tunnelId) => [
    { tunnelId, seq: 0, hostId: 1 }, { tunnelId, seq: 1, hostId: 4 }, { tunnelId, seq: 2, hostId: 5 }, { tunnelId, seq: 3, hostId: 2 },
  ]),
  exitNodes: [{ tunnelId: 14, hostId: 3 }, { tunnelId: 15, hostId: 3 }, { tunnelId: 15, hostId: 6, isEnabled: 0 }],
  groups: [
    { id: 20, name: "入口主备", groupMode: "failover", members: [{ hostId: 1 }, { hostId: 4 }] },
    { id: 21, name: "单台主备", groupMode: "failover", members: [{ hostId: 1 }] },
    { id: 22, name: "入口组", groupMode: "entry", members: [{ hostId: 1 }, { hostId: 4 }] },
    { id: 30, name: "出口组", groupMode: "exit", exitStrategy: "weighted", members: [{ hostId: 2, priority: 0 }, { hostId: 3, priority: 1 }] },
    { id: 31, name: "没带宽", groupMode: "exit", exitStrategy: "weighted", members: [{ hostId: 2 }, { hostId: 6 }] },
    { id: 32, name: "只用第一个", groupMode: "exit", exitStrategy: "none", members: [{ hostId: 2 }, { hostId: 3 }] },
    { id: 33, name: "出口主备", groupMode: "exit", exitStrategy: "fallback", members: [{ hostId: 2 }, { hostId: 3 }] },
  ],
  routeRules: [rule(40, "failover"), rule(41, "weighted")],
});

const keys = (items: { key: string }[]) => items.map((item) => item.key).sort();
const find = (key: string) => [...overview.failover, ...overview.loadBalance, ...overview.splitConnection].find((item) => item.key === key);

test("主备：中转主备、入口主备、出口主备、自动切换的线路组", () => {
  assert.deepEqual(keys(overview.failover), ["exit_group:33", "forward_group:20", "forward_group:21", "route_group:40", "tunnel:10:relay", "tunnel:17:relay"]);
  assert.deepEqual(find("tunnel:10:relay")?.members, ["中转 1", "中转 2"]);
  // 热备也是主备的一种，但它连接不断：列在主备里，写明毫秒级接手。
  assert.match(find("tunnel:17:relay")?.how || "", /热备/);
  assert.equal(find("tunnel:17:relay")?.href, "/tunnels?tab=tunnels&edit=17");
  assert.equal(find("forward_group:21")?.note, "只有一台，坏了没得换");
  assert.equal(find("route_group:40")?.href, "/rules?edit=40");
});

test("负载均衡：权重负载的线路组、入口组、出口组按权重、老隧道多出口；「只用第一个」不算", () => {
  assert.deepEqual(keys(overview.loadBalance), ["entry_group:22", "exit_group:30", "exit_group:31", "route_group:41", "tunnel:15:exits"]);
  assert.equal(find("exit_group:30")?.how, "出口按权重 5:3");
  assert.equal(find("exit_group:30")?.note, undefined);
  assert.equal(find("exit_group:31")?.note, "有出口没填线路带宽，现在按平均分");
  // 停用的额外出口不算进去。
  assert.deepEqual(find("tunnel:15:exits")?.members, ["出口 A", "出口 B"]);
  assert.equal(find("exit_group:30")?.href, "/tunnels?tab=exits&edit=30");
});

test("单连接叠加：中转叠加、多路并发；不是 NEX 的多路并发写明没生效", () => {
  assert.deepEqual(keys(overview.splitConnection), ["tunnel:11:relay", "tunnel:12:streams", "tunnel:13:streams"]);
  assert.equal(find("tunnel:12:streams")?.note, undefined);
  assert.match(find("tunnel:13:streams")?.note || "", /^没生效：只有 NEX 隧道/);
  // 单连接叠加在「叠加」页签里改。
  assert.equal(find("tunnel:11:relay")?.href, "/tunnels?tab=aggregates&edit=11");
  assert.equal(find("tunnel:11:relay")?.kind, "aggregate");
});
