import assert from "node:assert/strict";
import test from "node:test";
import {
  IP_LIMIT_EVENT_COOLDOWN_MS,
  OnlineSnapshotStore,
  buildOnlineRows,
  distinctIpsByUser,
  inboundTransportProto,
  normalizeOnlineReport,
  pickIpLimitExceeded,
  shouldWriteSighting,
  type OnlinePortOwner,
} from "./onlineIpsCore";

const NOW = 1_800_000_000;

const owner = (port: number, userId: number, extra: Partial<OnlinePortOwner> = {}): OnlinePortOwner => ({
  port, proto: "both", ruleId: port, inboundId: 0, userId, dnat: false, label: `规则 · ${port}`, ...extra,
});

test("report normalization keeps valid ports and IPs only", () => {
  const report = normalizeOnlineReport({
    at: NOW,
    conntrack: true,
    ports: [
      { port: 443, ruleId: 9, ips: [{ ip: "203.0.113.5", conns: 3, since: NOW - 60 }, { ip: "<script>", conns: 1 }, { ip: "2001:DB8::1", conns: 0, since: NOW + 99999 }] },
      { port: 70000, ips: [] },
      "junk",
    ],
  }, NOW);
  assert.ok(report);
  assert.equal(report.ports.length, 1);
  assert.deepEqual(report.ports[0].ips, [
    { ip: "203.0.113.5", conns: 3, since: NOW - 60 },
    { ip: "2001:db8::1", conns: 1, since: NOW },
  ]);
  assert.equal(normalizeOnlineReport(null), null);
});

test("rows map ports to owners and skip panel hosts' own addresses", () => {
  const report = normalizeOnlineReport({ at: NOW, ports: [
    { port: 1000, ips: [{ ip: "198.51.100.1", conns: 2, since: NOW }, { ip: "192.0.2.10", conns: 1, since: NOW }] },
    { port: 2000, ips: [{ ip: "198.51.100.2", conns: 1, since: NOW }] },
    { port: 3000, ips: [{ ip: "198.51.100.3", conns: 1, since: NOW }] },
  ] }, NOW)!;
  const owners = new Map([[1000, owner(1000, 7)], [2000, owner(2000, 8, { ruleId: 0, inboundId: 4 })]]);
  const rows = buildOnlineRows(5, report, owners, new Set(["192.0.2.10"]));
  assert.deepEqual(rows.map((r) => [r.ip, r.userId, r.ruleId, r.inboundId]), [
    ["198.51.100.1", 7, 1000, 0],
    ["198.51.100.2", 8, 0, 4],
  ]);
});

test("snapshots are replaced per host and dropped after two intervals", () => {
  const store = new OnlineSnapshotStore();
  const row = { hostId: 1, port: 1, ruleId: 1, inboundId: 0, userId: 1, ip: "198.51.100.1", conns: 1, since: NOW };
  store.set(1, [row], 0, 10);
  store.set(2, [{ ...row, hostId: 2 }], 0, 60);
  assert.equal(store.live(20_000).length, 2);
  // 10 秒的主机 25 秒后过期，60 秒的还在。
  assert.deepEqual(store.live(26_000).map((r) => r.hostId), [2]);
  store.set(2, [], 30_000, 60);
  assert.equal(store.live(31_000).length, 0);
  assert.deepEqual(store.reportingHostIds(31_000), [2]);
});

test("distinct IPs are counted per user across hosts", () => {
  const base = { port: 1, ruleId: 1, inboundId: 0, conns: 1, since: NOW };
  const map = distinctIpsByUser([
    { ...base, hostId: 1, userId: 1, ip: "a" },
    { ...base, hostId: 2, userId: 1, ip: "a" },
    { ...base, hostId: 2, userId: 1, ip: "b" },
    { ...base, hostId: 2, userId: 0, ip: "c" },
  ]);
  assert.equal(map.get(1)?.size, 2);
  assert.equal(map.has(0), false);
});

test("ip limit events fire above the limit, at most once per 6 hours", () => {
  const ips = new Map([[1, new Set(["a", "b", "c"])], [2, new Set(["a"])], [3, new Set(["a", "b"])]]);
  const limits = new Map([[1, 2], [2, 1], [3, 0]]);
  const last = new Map<number, number>();
  const first = pickIpLimitExceeded(ips, limits, last, 1_000);
  assert.deepEqual(first.map((h) => [h.userId, h.count, h.limit]), [[1, 3, 2]]);
  assert.equal(pickIpLimitExceeded(ips, limits, last, 1_000 + 60_000).length, 0);
  assert.equal(pickIpLimitExceeded(ips, limits, last, 1_000 + IP_LIMIT_EVENT_COOLDOWN_MS).length, 1);
});

test("sighting writes are throttled to once a minute unless connections peak", () => {
  assert.equal(shouldWriteSighting(undefined, 1, 0), true);
  const state = { lastWrittenAt: 0, maxConn: 3 };
  assert.equal(shouldWriteSighting(state, 2, 30_000), false);
  assert.equal(shouldWriteSighting(state, 4, 30_000), true);
  assert.equal(shouldWriteSighting(state, 1, 60_000), true);
});

test("inbound protocols map to their transport", () => {
  assert.equal(inboundTransportProto("hysteria2"), "udp");
  assert.equal(inboundTransportProto("tuic"), "udp");
  assert.equal(inboundTransportProto("shadowsocks"), "both");
  assert.equal(inboundTransportProto("vless"), "tcp");
});
