import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("转发组 / 入口组的线路：先在线路名字里那台（组模板自己的入口机）上测，它测不了才换组里别的、并写明", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-entry-member-"));
  try {
    const script = String.raw`
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      const now = Math.floor(Date.now() / 1000);
      const hosts = [[1, "po0(300M)"], [2, "jinx(39.9y)"]];
      for (const [id, name] of hosts) {
        await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)', [id, name, "203.0.113." + id, "203.0.113." + id, "slave", "tok" + id, now, "2.2.247"]);
      }
      const rule = (id, hostId, extra) => exec('INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isForwardGroupTemplate", "forwardGroupRuleId", "createdAt") VALUES (?, ?, ?, ?, ?, 30000, ?, 443, 1, 1, ?, ?, ?)', [id, hostId, "组", "nftables", "tcp", "198.51.100.50", extra.template ? 1 : 0, extra.parent || null, extra.createdAt || now]);
      await rule(10, 1, { template: true });
      await rule(11, 1, { parent: 10, createdAt: now - 3600 });
      // jinx 是后加进组的：成员按新到旧排，以前挑第一个能用的就挑到它
      await rule(12, 2, { parent: 10, createdAt: now });
      const view = await import(url("server/nodeCheckView.ts"));
      const out = {};
      const first = await view.entryRuleOf(10);
      out.first = [Number(first.rule.id), first.namedHostSkipped];
      await exec('UPDATE hosts SET "isOnline" = 0 WHERE id = 1');
      const second = await view.entryRuleOf(10);
      out.second = [Number(second.rule.id), second.namedHostSkipped];
      await exec('UPDATE hosts SET "isOnline" = 1, "agentVersion" = ? WHERE id = 1', ["2.2.240"]);
      const third = await view.entryRuleOf(10);
      out.third = [Number(third.rule.id), third.namedHostSkipped];
      const plain = await view.entryRuleOf(11);
      out.plain = [Number(plain.rule.id), plain.namedHostSkipped];
      console.log("RESULT " + JSON.stringify(out));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "entry.db"), FORWARDX_LOG_DIR: directory },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split("\n").find((row) => row.startsWith("RESULT "));
    assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
    const out = JSON.parse(line.slice("RESULT ".length));
    assert.deepEqual(out.first, [11, ""], "线路叫「po0(300M) → 落地」：在 po0(300M) 上测，不是后加进组的 jinx");
    assert.deepEqual(out.second, [12, "po0(300M) 离线"], "它离线才换组里别的，并说为什么");
    assert.deepEqual(out.third, [12, "po0(300M) 的 Agent 太旧"]);
    assert.deepEqual(out.plain, [11, ""], "不是组模板：就是它自己");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("入口机自己的带宽：拿它最近一次主机网速测试；只测到面板的、30 天以前的不算", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-entry-speed-"));
  try {
    const script = String.raw`
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const now = Math.floor(Date.now() / 1000);
      const add = (runId, hostId, checkedAt, result, entryKey = null) => exec('INSERT INTO host_speed_tests ("hostId", "nodeId", "entryKey", "runId", "resultJson", "checkedAt") VALUES (?, 0, ?, ?, ?, ?)', [hostId, entryKey, runId, JSON.stringify(result), checkedAt]);
      await add("old", 1, now - 40 * 86400, { server: "ookla", downloadMbps: 50, uploadMbps: 50, samples: [] });
      await add("good", 1, now - 3 * 86400, { server: "ookla", serverName: "China Telecom · Guangzhou", downloadMbps: 920, uploadMbps: 298, samples: [] });
      await add("panel", 1, now - 60, { server: "panel", downloadMbps: 41.9, uploadMbps: 93.6, samples: [] });
      await add("chain", 1, now - 30, { server: "ookla", downloadMbps: 3660, uploadMbps: 1210, samples: [] }, "r:1");
      const view = await import(url("server/nodeCheckView.ts"));
      const out = { picked: await view.entryHostSpeedOf(1, now), none: await view.entryHostSpeedOf(2, now) };
      console.log("RESULT " + JSON.stringify(out));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "speed.db"), FORWARDX_LOG_DIR: directory },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split("\n").find((row) => row.startsWith("RESULT "));
    assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
    const out = JSON.parse(line.slice("RESULT ".length));
    assert.equal(out.picked.downloadMbps, 920, "跳过只测到面板的那次，用三天前测到 Ookla 的那次；线路测速（带 entryKey）的不算");
    assert.equal(out.picked.uploadMbps, 298);
    assert.equal(out.picked.serverName, "China Telecom · Guangzhou");
    assert.equal(out.none, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
