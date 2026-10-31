import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { poolMemberPlan } from "./nodePoolGroups";

/*
  入口组 / 出口组 / 主备转发组跟着节点池（2.3.497）：组的主机成员就是池里的机器。
*/

test("池里还在的照留（连接地址、带宽、权重、启用不动），新加的排在后面，去掉的从组里去掉", () => {
  const plan = poolMemberPlan([
    { id: 11, memberType: "host", hostId: 1, priority: 0, isEnabled: 1, connectHost: "10.0.0.1", bandwidthMbps: 500, aggregationWeight: 2 },
    { id: 12, memberType: "host", hostId: 2, priority: 1, isEnabled: 0 },
    { id: 13, memberType: "host", hostId: 3, priority: 2, isEnabled: 1 },
  ], [2, 1, 4]);
  assert.equal(plan.kept, 2);
  assert.equal(plan.added, 1);
  assert.equal(plan.removed, 1);
  assert.deepEqual(plan.members.map((member) => [member.hostId, member.isEnabled, member.priority]), [[1, true, 0], [2, false, 1], [4, true, 2]]);
  assert.equal(plan.members[0].connectHost, "10.0.0.1");
  assert.equal(plan.members[0].bandwidthMbps, 500);
  assert.equal(plan.members[0].aggregationWeight, 2);
});

test("时段停掉的成员算开着（用户的意思）；隧道成员不归池管，照留", () => {
  const plan = poolMemberPlan([
    { id: 21, memberType: "tunnel", tunnelId: 7, priority: 0, isEnabled: 1 },
    { id: 22, memberType: "host", hostId: 5, priority: 1, isEnabled: 0, scheduleSuspended: 1 },
  ], [5]);
  assert.deepEqual(plan.members.map((member) => [member.memberType, member.memberType === "host" ? member.hostId : member.tunnelId, member.isEnabled]), [["tunnel", 7, true], ["host", 5, true]]);
  assert.equal(plan.added + plan.removed, 0);
});

test("成员和池里一样：什么都不改", () => {
  const plan = poolMemberPlan([{ id: 1, memberType: "host", hostId: 9, priority: 0, isEnabled: 1 }], [9]);
  assert.equal(plan.added + plan.removed, 0);
  assert.equal(plan.kept, 1);
});

/**
 * 真的 sqlite 跑一遍：跟上、池改了跟着改、别人的池不能跟、池删了松开。
 */
test("出口组跟着节点池：跟上马上同步，池改了跟着改，池删了松开", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-pool-follow-"));
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
      const query = (sql, params = []) => runtime.queryRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin'), (2, 'user', 'hash', 'user')");
      const now = Math.floor(Date.now() / 1000);
      for (const id of [1, 2, 3, 4]) {
        await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)', [id, "H" + id, "203.0.113." + id, "203.0.113." + id, "slave", "tok" + id, now]);
      }
      await exec('INSERT INTO forward_groups (id, name, "groupMode", "targetIp", "userId", "isEnabled") VALUES (10, ?, ?, ?, 1, 1)', ["解锁出口", "exit", "0.0.0.0"]);
      await exec('INSERT INTO forward_group_members (id, "groupId", "memberType", "hostId", priority, "isEnabled", "bandwidthMbps") VALUES (11, 10, ?, 1, 0, 1, 0), (12, 10, ?, 2, 1, 1, 300)', ["host", "host"]);
      const pools = await import(url("server/nodePools.ts"));
      const follow = await import(url("server/nodePoolGroups.ts"));
      const members = async () => (await query('SELECT "hostId", "bandwidthMbps" FROM forward_group_members WHERE "groupId" = 10 ORDER BY priority')).map((row) => [Number(row.hostId), Number(row.bandwidthMbps || 0)]);
      const poolOf = async () => (await query('SELECT "poolId" FROM forward_groups WHERE id = 10'))[0].poolId ?? null;
      const out = {};

      const poolId = await pools.createNodePool({ userId: 1, name: "落地池", role: "landing", hostIds: [2, 3] });
      out.follow = await follow.setGroupPool(10, poolId);
      out.afterFollow = await members();
      out.poolId = Number(await poolOf()) === poolId;

      await pools.updateNodePool(poolId, { hostIds: [3, 4] });
      out.sync = (await follow.syncGroupsFollowingPool(poolId, "test")).map((row) => ({ added: row.added, removed: row.removed, error: row.error ?? null }));
      out.afterSync = await members();

      // 池空了不同步：组至少要一台
      await pools.updateNodePool(poolId, { hostIds: [] });
      out.emptySkipped = (await follow.syncGroupsFollowingPool(poolId, "test"))[0].skipped || null;
      out.afterEmpty = await members();

      const otherPool = await pools.createNodePool({ userId: 2, name: "别人的池", role: "landing", hostIds: [1] });
      out.foreign = await follow.setGroupPool(10, otherPool).then(() => "ok", (error) => String(error.message));

      await follow.releaseGroupsFollowingPool(poolId);
      out.released = await poolOf();
      console.log("RESULT " + JSON.stringify(out));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "follow.db"), FORWARDX_LOG_DIR: directory },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split("\n").find((row) => row.startsWith("RESULT "));
    assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
    const out = JSON.parse(line.slice("RESULT ".length));
    assert.deepEqual({ added: out.follow.added, removed: out.follow.removed, kept: out.follow.kept }, { added: 1, removed: 1, kept: 1 });
    assert.deepEqual(out.afterFollow, [[2, 300], [3, 0]], "H2 留着自己的带宽设置，H3 加在后面，H1 不在池里去掉");
    assert.equal(out.poolId, true);
    assert.deepEqual(out.sync, [{ added: 1, removed: 1, error: null }]);
    assert.deepEqual(out.afterSync, [[3, 0], [4, 0]]);
    assert.match(String(out.emptySkipped), /空/);
    assert.deepEqual(out.afterEmpty, [[3, 0], [4, 0]], "池空了组的成员不动");
    assert.match(String(out.foreign), /别的用户/);
    assert.equal(out.released, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
