import assert from "node:assert/strict";
import test from "node:test";

import { entryLocalDial, retargetOutbound } from "./nodeCheckView";

/*
  订阅线路测速在入口机上跑（server/nodeCheckView.ts 的 planEntryCheck）：sing-box 连本机的入口，
  这里只看两件纯函数的事 —— 连哪个地址、握手里的 SNI / Host 还是不是客户端那一份。
*/

test("用户态转发、线路组、隧道入口：连本机回环上的入口端口", () => {
  assert.deepEqual(entryLocalDial({ forwardType: "gost", sourcePort: 44760, targetIp: "198.51.100.7", targetPort: 24895 }), { server: "127.0.0.1", port: 44760, via: "loopback" });
  assert.deepEqual(entryLocalDial({ forwardType: "realm", sourcePort: 8443, failoverEnabled: true }), { server: "127.0.0.1", port: 8443, via: "loopback" });
  // 隧道规则的入口是隧道进程在接，哪怕规则上写的是内核转发
  assert.deepEqual(entryLocalDial({ forwardType: "nftables", tunnelId: 3, sourcePort: 9000, targetIp: "10.0.0.2", targetPort: 80 }), { server: "127.0.0.1", port: 9000, via: "loopback" });
});

test("内核转发不接本机发出的连接：直接连它转去的下一跳", () => {
  assert.deepEqual(entryLocalDial({ forwardType: "nftables", sourcePort: 44760, targetIp: "198.51.100.7", targetPort: 24895 }), { server: "198.51.100.7", port: 24895, via: "next-hop" });
  assert.deepEqual(entryLocalDial({ forwardType: "IPTABLES", sourcePort: 1, targetIp: "relay.example.test", targetPort: 30001, failoverEnabled: true }), { server: "relay.example.test", port: 30001, via: "next-hop" });
  assert.equal(entryLocalDial({ forwardType: "iptables", sourcePort: 1, targetIp: "", targetPort: 0 }), null);
  assert.equal(entryLocalDial({ forwardType: "gost", sourcePort: 0 }), null);
});

test("换地址时 SNI / Host 照客户端的来：没写的写死成原来的地址，写了的不动", () => {
  const vless = {
    type: "vless",
    server: "po0.example.test",
    server_port: 44760,
    tls: { enabled: true, utls: { enabled: true, fingerprint: "chrome" } },
    transport: { type: "ws", path: "/ws" },
  };
  const moved = retargetOutbound(vless, "127.0.0.1", 44760);
  assert.equal(moved.server, "127.0.0.1");
  assert.equal(moved.server_port, 44760);
  assert.deepEqual(moved.tls, { enabled: true, utls: { enabled: true, fingerprint: "chrome" }, server_name: "po0.example.test" });
  assert.deepEqual(moved.transport, { type: "ws", path: "/ws", headers: { Host: "po0.example.test" } });
  // 原对象不改
  assert.equal(vless.server, "po0.example.test");
  assert.equal((vless.tls as Record<string, unknown>).server_name, undefined);

  const reality = { type: "vless", server: "203.0.113.5", server_port: 443, tls: { enabled: true, server_name: "www.microsoft.com", reality: { enabled: true } } };
  assert.deepEqual(retargetOutbound(reality, "127.0.0.1", 443).tls, reality.tls);

  const http = { type: "vmess", server: "a.example.test", server_port: 80, transport: { type: "http", host: [] } };
  assert.deepEqual(retargetOutbound(http, "127.0.0.1", 80).transport, { type: "http", host: ["a.example.test"] });
  const upgrade = { type: "vless", server: "b.example.test", server_port: 80, transport: { type: "httpupgrade", host: "cdn.example.test" } };
  assert.deepEqual(retargetOutbound(upgrade, "127.0.0.1", 80).transport, upgrade.transport);

  // 不带 TLS 的（Shadowsocks）只换地址
  const ss = { type: "shadowsocks", server: "c.example.test", server_port: 8388, method: "aes-128-gcm", password: "x" };
  assert.deepEqual(retargetOutbound(ss, "198.51.100.7", 24895), { ...ss, server: "198.51.100.7", server_port: 24895 });
  // TUIC 关了 SNI 的不补
  const tuic = { type: "tuic", server: "d.example.test", server_port: 443, tls: { enabled: true, disable_sni: true } };
  assert.deepEqual(retargetOutbound(tuic, "127.0.0.1", 443).tls, tuic.tls);
});
