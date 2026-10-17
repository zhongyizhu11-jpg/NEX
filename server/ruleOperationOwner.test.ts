import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 管理员在规则页选了某个用户之后新建 / 复制规则：规则归他，检查也全按他来（server/ruleOperationOwner.ts）。
 * 端口提示（entryPortPolicy）、端口检查、随机端口和保存用同一个主人，界面上看到的范围就是保存时的判定。
 */
test("administrator rule operations use the selected owner without bypassing user limits", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-rule-owner-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const insert = async (table, columns, values) => {
      const quote = (name) => '"' + name + '"';
      await runtime.executeRaw("INSERT INTO " + quote(table) + " (" + columns.map(quote).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")", values);
    };
    const caller = (id, role) => rulesRouter.createCaller({
      req: { headers: {} }, res: { clearCookie() {} },
      user: { id, username: "test-" + id, role, accountEnabled: true },
      authSession: null, authFailureReason: null,
    });
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      for (const id of [1, 2, 3]) {
        await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents", "accountEnabled", "maxRules", "maxPorts"],
          [id, "test-" + id, "x", id === 1 ? "admin" : "user", 1, 1, 1000, id === 3 ? 0 : 1, 100, 100]);
      }
      const now = Math.floor(Date.now() / 1000);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd", "agentVersion"], [2, "entry", "198.51.100.10", "198.51.100.10", 1, 1, now, 10000, 20000, "2.2.228"]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"], [10, "customer-group", "host", "port", "", "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 2, 0, 1]);
      await insert("subscription_plans", ["id", "name"], [50, "limited-ports"]);
      await insert("subscription_plan_hosts", ["planId", "hostId"], [50, 2]);
      await insert("subscription_plan_forward_groups", ["planId", "forwardGroupId"], [50, 10]);
      await insert("user_subscriptions", ["id", "userId", "planId", "status", "portRangeStart", "portRangeEnd"], [60, 2, 50, "active", 17000, 18000]);
      const admin = caller(1, "admin");
      const customer = caller(2, "user");
      const base = { hostId: 2, name: "test-rule", forwardType: "iptables", protocol: "tcp", sourcePort: 16000, targetIp: "203.0.113.20", targetPort: 8080 };
      const grouped = { ...base, hostId: undefined, forwardGroupId: 10 };
      const self = await admin.create(base);
      const explicitSelf = await admin.create({ ...base, userId: 1, sourcePort: 16001 });
      const selected = await admin.create({ ...grouped, userId: 2, sourcePort: 0 });
      assert.ok(selected.sourcePort >= 17000 && selected.sourcePort <= 18000, "owner plan range ignored: " + selected.sourcePort);
      const owners = await runtime.queryRaw('SELECT "id", "userId", "adminManaged" FROM "forward_rules" WHERE "id" IN (?, ?, ?) ORDER BY "id"', [self.id, explicitSelf.id, selected.id]);
      assert.deepEqual(owners.map((row) => Number(row.userId)), [1, 1, 2]);
      // Rules the administrator creates for someone else are administrator-managed (read-only for the owner).
      assert.deepEqual(owners.map((row) => Number(row.adminManaged)), [0, 0, 1]);
      // The owner's own restrictions apply: no direct host rules for this tenant, and the plan port range.
      await assert.rejects(() => admin.create({ ...base, userId: 2, sourcePort: 17501 }), /普通端口转发请先创建转发组/);
      await assert.rejects(() => admin.create({ ...grouped, userId: 2, sourcePort: 16002 }), /套餐端口/);
      await assert.rejects(() => customer.create({ ...grouped, userId: 1, sourcePort: 17501 }), /无权操作其他用户/);
      await assert.rejects(() => admin.create({ ...grouped, userId: 3, sourcePort: 17501 }), /已被禁用/);
      await assert.rejects(() => admin.create({ ...grouped, userId: 999, sourcePort: 17501 }), /不存在/);
      // Port hints, checks and random ports resolve against the same owner.
      const ownerPolicy = await admin.entryPortPolicy({ forwardGroupId: 10, userId: 2 });
      const adminPolicy = await admin.entryPortPolicy({ forwardGroupId: 10 });
      assert.equal(ownerPolicy.policy.rangeStart, 17000);
      assert.equal(ownerPolicy.policy.rangeEnd, 18000);
      assert.equal(adminPolicy.policy.rangeStart, 10000);
      assert.equal(adminPolicy.policy.rangeEnd, 20000);
      assert.equal((await admin.checkPort({ forwardGroupId: 10, userId: 2, sourcePort: 16002, protocol: "tcp" })).used, true);
      assert.equal((await admin.checkPort({ forwardGroupId: 10, sourcePort: 16002, protocol: "tcp" })).used, false);
      const random = await admin.randomPort({ forwardGroupId: 10, userId: 2, protocol: "tcp" });
      assert.ok(random.port >= 17000 && random.port <= 18000, "random port escaped the owner's plan range: " + random.port);
      await assert.rejects(() => customer.randomPort({ forwardGroupId: 10, userId: 1 }), /无权操作其他用户/);
      await assert.rejects(() => customer.entryPortPolicy({ forwardGroupId: 10, userId: 1 }), /无权操作其他用户/);
      // The owner sees the rule but cannot change, stop or delete an administrator-managed rule.
      await assert.rejects(() => customer.update({ id: selected.id, name: "mine now" }), /管理员管理/);
      await assert.rejects(() => customer.toggle({ id: selected.id, isEnabled: false }), /管理员管理/);
      await assert.rejects(() => customer.delete({ id: selected.id }), /管理员管理/);
      // Rules the user creates themselves stay fully editable.
      const own = await customer.create({ ...grouped, sourcePort: 17600 });
      await customer.update({ id: own.id, name: "self-service edited" });
      await customer.toggle({ id: own.id, isEnabled: false });
    } finally {
      await runtime.closeDatabase();
    }
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "owner.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
