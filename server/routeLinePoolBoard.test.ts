import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 节点池页（2.3.496，效果图 ⑤）里入口组的「几台能用」：
 *   · DNS 入口组数在解析里的；
 *   · 主备入口组的解析只指向在用那一台，健康的待命也能接班 —— 不能显示成 1/2、更不能是 0/2。
 * 起一个真的 sqlite 跑一遍。
 */
test("节点池页：主备入口组健康的待命算能用，DNS 入口组数在解析里的", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-pool-board-"));
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
      for (const [id, name, ip, online] of [[1, "A", "203.0.113.1", 1], [2, "B", "203.0.113.2", 1], [3, "C", "203.0.113.3", 0]]) {
        await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [id, name, ip, ip, "slave", "tok" + id, online, now]);
      }
      // 主备：在用 A（成员 11），B 健康待命
      await exec('INSERT INTO forward_groups (id, name, "groupMode", domain, "targetIp", "userId", "activeMemberId", "lastDdnsValue") VALUES (10, ?, ?, ?, ?, 1, 11, ?)', ["主备组", "failover", "edge.example.test", "0.0.0.0", "203.0.113.1"]);
      await exec('INSERT INTO forward_group_members (id, "groupId", "memberType", "hostId", priority) VALUES (11, 10, ?, 1, 0), (12, 10, ?, 2, 1)', ["host", "host"]);
      // DNS 入口组：解析里只有 A；B 健康但不在解析里，C 离线
      await exec('INSERT INTO forward_groups (id, name, "groupMode", domain, "targetIp", "userId", "lastDdnsValue") VALUES (20, ?, ?, ?, ?, 1, ?)', ["入口组", "entry", "bgp.example.test", "0.0.0.0", "203.0.113.1"]);
      await exec('INSERT INTO forward_group_members (id, "groupId", "memberType", "hostId", priority) VALUES (21, 20, ?, 1, 0), (22, 20, ?, 2, 1), (23, 20, ?, 3, 2)', ["host", "host", "host"]);
      const views = await import(url("server/routeLineViews.ts"));
      const board = await views.poolBoard({ id: 1, role: "admin" });
      console.log("BOARD " + JSON.stringify(board.entryGroups.map((group) => ({ id: group.id, mode: group.mode, usable: group.usable, total: group.total, states: group.members.map((member) => member.state) }))));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "pools.db"), FORWARDX_LOG_DIR: directory },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split("\n").find((row) => row.startsWith("BOARD "));
    assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
    const groups = JSON.parse(line.slice("BOARD ".length)) as Array<{ id: number; mode: string; usable: number; total: number; states: string[] }>;
    assert.deepEqual(groups.find((group) => group.id === 10), { id: 10, mode: "failover", usable: 2, total: 2, states: ["在用", "待命"] });
    assert.deepEqual(groups.find((group) => group.id === 20), { id: 20, mode: "entry", usable: 1, total: 3, states: ["在线", "不在解析里", "离线，已摘除"] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
