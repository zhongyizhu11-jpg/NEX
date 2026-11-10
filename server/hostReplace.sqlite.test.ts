import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主机替换（server/hostReplace/）走真库：一台旧机上挂着直连规则、转发组成员、线路组中转、
 * 隧道出口 / 入口，换到新机后逐类核对引用，再撤回核对恢复原样；预览之后数据变了执行要拒绝。
 *
 * 走的是 trpc.hostReplace.*（和界面同一个入口），转发组同步、中继同步都是真跑的。
 */

type RuleState = { hostId: number; sourcePort: number; pendingDelete: boolean } | null;
type Snapshot = {
  ruleA: RuleState;
  ruleB: RuleState;
  ruleD: RuleState;
  tunnelRule: RuleState;
  member: number | null;
  childHosts: number[];
  routeHops: number[][];
  relayHosts: number[];
  tunnel50: { entryHostId: number; exitHostId: number; listenPort: number } | null;
  tunnel51: { entryHostId: number; exitHostId: number } | null;
  tunnelPrimaryExitPort: number | null;
  permission: number;
  bridges: Array<{ ruleId: number; hostId: number; sourcePort: number }>;
  pool: number[];
};
type Outcome = {
  error: string | null;
  preview: {
    categories: Array<{ category: string; count: number }>;
    conflicts: Array<{ key: string; unit: string; options: string[]; port: number | null; suggestedPort: number | null }>;
    blockers: string[];
    manualKinds: string[];
  };
  stale: string | null;
  nonAdmin: string | null;
  offline: string[];
  before: Snapshot;
  executed: { recordId: number; skipped: number; bridged: number } | null;
  after: Snapshot;
  records: Array<{ id: number; status: string }>;
  undo: { reverted: number; report: string[] } | null;
  undone: Snapshot;
  undoAgain: string | null;
};

function runScenario(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-replace-"));
  const databasePath = path.join(directory, "host-replace.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => exec(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const now = Math.floor(Date.now() / 1000);
    const out = { error: null };
    try {
      await insert("users", ["id", "username", "password", "role"], [1, "admin", "hash", "admin"]);
      await insert("users", ["id", "username", "password", "role"], [2, "tenant", "hash", "user"]);
      const host = (id, name, ip, online = 1) => insert(
        "hosts", ["id", "name", "ip", "ipv4", "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion"],
        [id, name, ip, ip, "slave", "tok" + id, 1, online, online ? now : null, "2.2.250"],
      );
      await host(1, "旧机", "198.51.100.1");
      await host(2, "新机", "198.51.100.2");
      await host(3, "入口机", "198.51.100.3");
      await host(4, "落地机", "198.51.100.4");
      await host(5, "离线机", "198.51.100.5", 0);

      const rule = (id, hostId, name, port, extra = {}) => {
        const columns = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", ...Object.keys(extra)];
        return insert("forward_rules", columns, [id, hostId, name, "gost", "tcp", port, "203.0.113.9", 80, 1, 1, 1, ...Object.values(extra)]);
      };
      // 直连：A 不冲突；B 和新机上的规则撞端口（换端口）；D 撞端口（跳过）
      await rule(201, 1, "A", 20001);
      await rule(202, 1, "B", 20002);
      await rule(203, 1, "D", 20003);
      await rule(290, 2, "新机上的 B'", 20002);
      await rule(291, 2, "新机上的 D'", 20003);

      // 转发组（端口转发）：旧机和入口机两个成员，模板端口 21000
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [10, "端口组", "host", "port", "gost", "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 3, 1, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled"],
        [300, 1, "组规则", "gost", "tcp", 10, 1, 21000, "203.0.113.10", 443, 1, 1]);

      // 线路组：入口机上一条规则，主线路经旧机中转，备用经落地机
      const paths = JSON.stringify([
        { key: "a", name: "主线路", hops: [1], dest: null, weight: 50, probe: null, dial: null },
        { key: "b", name: "备用 1", hops: [4], dest: null, weight: 50, probe: null, dial: null },
      ]);
      await rule(400, 3, "线路组", 23000, { failoverEnabled: 1, failoverStrategy: "fallback", routeMode: "failover", routePaths: paths });

      // 隧道 50：入口机 → 旧机（出口），隧道上一条规则
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled", "secret"], [50, "出口在旧机", 3, 1, "tls", 22000, 1, 1, "s50"]);
      await rule(500, 3, "走隧道 50", 24000, { tunnelId: 50, tunnelExitPort: 22000 });
      // 隧道 51：旧机（入口）→ 落地机，规则跟着入口搬
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled", "secret"], [51, "入口在旧机", 1, 4, "tls", 22100, 1, 1, "s51"]);
      await rule(510, 1, "走隧道 51", 24100, { tunnelId: 51, tunnelExitPort: 22100 });

      // 节点池、授权
      await insert("node_pools", ["id", "userId", "name", "role", "hostIdsJson", "createdAt", "updatedAt"], [7, 1, "中转池", "relay", JSON.stringify([1, 4]), now, now]);
      await insert("user_host_permissions", ["userId", "hostId"], [2, 1]);
      // 旧机上的落地入站：不自动搬，只提示
      await insert("proxy_inbounds", ["id", "userId", "hostId", "name", "port"], [60, 1, 1, "落地", 25000]);

      const forwardGroups = await import(url("server/repositories/forwardGroupRepository.ts"));
      await forwardGroups.syncForwardGroupRules(10);
      const routeGroups = await import(url("server/routeGroups.ts"));
      await routeGroups.syncRouteRelayRulesForRule(400, { reason: "test" });

      const one = async (sql, params) => (await runtime.queryRaw(sql, params))[0] || null;
      const ruleState = async (id) => {
        const row = await one('SELECT "hostId", "sourcePort", "pendingDelete" FROM forward_rules WHERE id = ?', [id]);
        return row ? { hostId: Number(row.hostId), sourcePort: Number(row.sourcePort), pendingDelete: !!Number(row.pendingDelete) } : null;
      };
      const snapshot = async () => {
        const member = await one('SELECT "hostId" FROM forward_group_members WHERE id = ?', [101]);
        const children = await runtime.queryRaw('SELECT "hostId" FROM forward_rules WHERE "forwardGroupRuleId" = ? AND "pendingDelete" = 0 ORDER BY "hostId"', [300]);
        const parent = await one('SELECT "routePaths" FROM forward_rules WHERE id = ?', [400]);
        const relays = await runtime.queryRaw('SELECT DISTINCT "hostId" FROM forward_rules WHERE "routeParentRuleId" = ? AND "pendingDelete" = 0 ORDER BY "hostId"', [400]);
        const t50 = await one('SELECT "entryHostId", "exitHostId", "listenPort" FROM tunnels WHERE id = ?', [50]);
        const t51 = await one('SELECT "entryHostId", "exitHostId" FROM tunnels WHERE id = ?', [51]);
        const primary = await one('SELECT "tunnelExitPort" FROM forward_rules WHERE id = ?', [500]);
        const permission = await one('SELECT COUNT(*) AS c FROM user_host_permissions WHERE "userId" = ? AND "hostId" = ?', [2, 2]);
        const bridges = await runtime.queryRaw('SELECT "ruleId", "hostId", "sourcePort" FROM forward_rule_entry_bridges ORDER BY "ruleId"');
        const pool = await one('SELECT "hostIdsJson" FROM node_pools WHERE id = ?', [7]);
        return {
          ruleA: await ruleState(201), ruleB: await ruleState(202), ruleD: await ruleState(203), tunnelRule: await ruleState(510),
          member: member ? Number(member.hostId) : null,
          childHosts: children.map((row) => Number(row.hostId)),
          routeHops: JSON.parse(parent.routePaths).map((p) => p.hops),
          relayHosts: relays.map((row) => Number(row.hostId)),
          tunnel50: t50 ? { entryHostId: Number(t50.entryHostId), exitHostId: Number(t50.exitHostId), listenPort: Number(t50.listenPort) } : null,
          tunnel51: t51 ? { entryHostId: Number(t51.entryHostId), exitHostId: Number(t51.exitHostId) } : null,
          tunnelPrimaryExitPort: primary ? Number(primary.tunnelExitPort) : null,
          permission: Number(permission.c),
          bridges: bridges.map((row) => ({ ruleId: Number(row.ruleId), hostId: Number(row.hostId), sourcePort: Number(row.sourcePort) })),
          pool: JSON.parse(pool.hostIdsJson),
        };
      };

      const { hostReplaceRouter } = await import(url("server/routers/hostReplace.ts"));
      const ctxFor = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
      const caller = hostReplaceRouter.createCaller(ctxFor({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const tenant = hostReplaceRouter.createCaller(ctxFor({ id: 2, username: "tenant", role: "user", accountEnabled: true }));
      const message = async (work) => { try { await work(); return null; } catch (error) { return String(error?.message || error); } };

      out.nonAdmin = await message(() => tenant.preview({ oldHostId: 1, newHostId: 2 }));
      out.offline = (await caller.preview({ oldHostId: 1, newHostId: 5 })).blockers;
      out.before = await snapshot();

      const preview = await caller.preview({ oldHostId: 1, newHostId: 2 });
      out.preview = {
        categories: preview.categories.map((item) => ({ category: item.category, count: item.count })),
        conflicts: preview.conflicts.map((item) => ({ key: item.key, unit: item.unit, options: item.options, port: item.port, suggestedPort: item.suggestedPort })),
        blockers: preview.blockers,
        manualKinds: preview.manual.map((item) => item.kind),
      };
      const resolutions = {};
      for (const conflict of preview.conflicts) {
        resolutions[conflict.key] = conflict.unit === "rule:203" ? { action: "skip" } : { action: "newPort", port: conflict.suggestedPort };
      }

      // 预览之后有人改了规则 A：拿旧预览执行要被拒绝，库里什么都不动
      await exec('UPDATE forward_rules SET "sourcePort" = 20011, "updatedAt" = ? WHERE id = 201', [now + 5]);
      out.stale = await message(() => caller.execute({ oldHostId: 1, newHostId: 2, fingerprint: preview.fingerprint, resolutions }));
      await exec('UPDATE forward_rules SET "sourcePort" = 20001 WHERE id = 201');

      const fresh = await caller.preview({ oldHostId: 1, newHostId: 2 });
      const executed = await caller.execute({ oldHostId: 1, newHostId: 2, fingerprint: fresh.fingerprint, resolutions, bridge: true });
      out.executed = { recordId: executed.recordId, skipped: executed.skipped.length, bridged: executed.bridged };
      out.after = await snapshot();
      out.records = (await caller.records({ hostId: 1 })).map((row) => ({ id: row.id, status: row.status }));

      // 当成新机的 Agent 已经把搬过去的规则跑起来了，撤回不能被这个挡住
      await exec('UPDATE forward_rules SET "isRunning" = 1 WHERE "hostId" = 2');
      out.undo = await caller.undo({ recordId: executed.recordId });
      out.undone = await snapshot();
      out.undoAgain = await message(() => caller.undo({ recordId: executed.recordId }));
    } catch (error) {
      out.error = String(error?.stack || error);
    }
    console.log("OUTCOME " + JSON.stringify(out));
    await runtime.closeDatabase();
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    timeout: 180_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = runScenario();

test("场景本身跑通，没有抛错", () => {
  assert.equal(outcome.error, null);
});

test("只有管理员能用；新机不在线时预览给出阻断原因", () => {
  assert.ok(outcome.nonAdmin, "普通用户调到了替换接口");
  assert.ok(outcome.offline.some((text) => text.includes("新机不在线")), JSON.stringify(outcome.offline));
});

test("前提：旧机上的组子规则和中继规则都建出来了", () => {
  assert.deepEqual(outcome.before.childHosts, [1, 3]);
  assert.ok(outcome.before.relayHosts.includes(1), `旧机上应有中继：${JSON.stringify(outcome.before.relayHosts)}`);
});

test("预览逐类列出会搬的东西，端口冲突逐条给出处理办法，落地入站标成要手动处理", () => {
  const counts = Object.fromEntries(outcome.preview.categories.map((item) => [item.category, item.count]));
  assert.equal(counts.rules, 3, "直连 A、B、D 三条");
  assert.equal(counts.tunnels, 2);
  assert.equal(counts.groupMembers, 1);
  assert.equal(counts.routeGroups, 1);
  assert.equal(counts.nodePools, 1);
  assert.equal(counts.access, 1);
  const byUnit = new Map(outcome.preview.conflicts.map((item) => [item.unit, item]));
  assert.equal(byUnit.get("rule:202")?.port, 20002);
  assert.deepEqual(byUnit.get("rule:202")?.options, ["newPort", "skip"]);
  assert.ok(byUnit.get("rule:202")?.suggestedPort, "冲突应给出一个空闲端口");
  assert.equal(byUnit.get("rule:203")?.port, 20003);
  assert.ok(!byUnit.has("rule:201"), "A 不冲突");
  assert.deepEqual(outcome.preview.blockers, []);
  assert.ok(outcome.preview.manualKinds.includes("proxy-inbounds"));
});

test("预览之后数据变了，执行被拒绝，库里什么都没动", () => {
  assert.ok(outcome.stale?.includes("重新预览"), String(outcome.stale));
  assert.ok(outcome.executed, "重新预览后应能执行");
});

test("执行后：直连规则换到新机，冲突的换了端口，选跳过的留在旧机", () => {
  const { after } = outcome;
  assert.deepEqual(after.ruleA, { hostId: 2, sourcePort: 20001, pendingDelete: false });
  assert.equal(after.ruleB?.hostId, 2);
  assert.notEqual(after.ruleB?.sourcePort, 20002, "B 撞端口，应换成别的端口");
  assert.deepEqual(after.ruleD, { hostId: 1, sourcePort: 20003, pendingDelete: false });
  assert.equal(outcome.executed?.skipped, 1);
});

test("执行后：转发组成员换成新机，组同步在新机上重建子规则、旧机上的收掉", () => {
  assert.equal(outcome.after.member, 2);
  assert.deepEqual(outcome.after.childHosts, [2, 3]);
});

test("执行后：线路组的中转换成新机，中继规则按路径重新同步到新机", () => {
  assert.deepEqual(outcome.after.routeHops, [[2], [4]]);
  assert.ok(outcome.after.relayHosts.includes(2), JSON.stringify(outcome.after.relayHosts));
  assert.ok(!outcome.after.relayHosts.includes(1), "旧机上不该再有在用的中继");
});

test("执行后：隧道出口 / 入口换成新机，入口上的规则跟着走", () => {
  assert.equal(outcome.after.tunnel50?.exitHostId, 2);
  assert.equal(outcome.after.tunnel50?.entryHostId, 3);
  assert.equal(outcome.after.tunnel50?.listenPort, 22000, "新机上 22000 空着，出口端口不该变");
  assert.equal(outcome.after.tunnelPrimaryExitPort, 22000);
  assert.equal(outcome.after.tunnel51?.entryHostId, 2);
  assert.deepEqual(outcome.after.tunnelRule, { hostId: 2, sourcePort: 24100, pendingDelete: false });
});

test("执行后：节点池、授权换到新机，旧入口留了桥接", () => {
  assert.deepEqual(outcome.after.pool, [2, 4]);
  assert.equal(outcome.after.permission, 1);
  const bridged = outcome.after.bridges.filter((row) => row.hostId === 1).map((row) => row.ruleId);
  assert.ok(bridged.includes(201) && bridged.includes(202) && bridged.includes(510), JSON.stringify(outcome.after.bridges));
  assert.ok(!bridged.includes(203), "没搬的规则不留桥接");
  assert.ok((outcome.executed?.bridged || 0) >= 3);
  assert.deepEqual(outcome.records.map((row) => row.status), ["done"]);
});

test("撤回后：所有引用改回旧机，端口用回原来的，桥接和授权收掉", () => {
  const { undone, before } = outcome;
  assert.deepEqual(outcome.undo?.report, []);
  assert.deepEqual(undone.ruleA, before.ruleA);
  assert.deepEqual(undone.ruleB, before.ruleB);
  assert.deepEqual(undone.ruleD, before.ruleD);
  assert.deepEqual(undone.tunnelRule, before.tunnelRule);
  assert.equal(undone.member, 1);
  assert.deepEqual(undone.childHosts, [1, 3]);
  assert.deepEqual(undone.routeHops, before.routeHops);
  assert.ok(undone.relayHosts.includes(1) && !undone.relayHosts.includes(2), JSON.stringify(undone.relayHosts));
  assert.deepEqual(undone.tunnel50, before.tunnel50);
  assert.deepEqual(undone.tunnel51, before.tunnel51);
  assert.deepEqual(undone.pool, before.pool);
  assert.equal(undone.permission, 0);
  assert.deepEqual(undone.bridges.filter((row) => row.hostId === 1), []);
});

test("同一次替换不能撤回两次", () => {
  assert.ok(outcome.undoAgain?.includes("撤回过"), String(outcome.undoAgain));
});
