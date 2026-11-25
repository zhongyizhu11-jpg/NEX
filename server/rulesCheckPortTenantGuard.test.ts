import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  「检查端口」要和保存走同一道闸：租户在共享主机/共享转发组入口上查 22、80 或面板端口，
  原来会显示「可用」，点保存才报错。
*/
test("checkPort rejects system and panel ports for tenants on shared hosts and forward groups", () => {
  runInDatabase(String.raw`
    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await exec(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });

    const now = Math.floor(Date.now() / 1000);
    await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
    await insert("users", ["id", "username", "password", "role", "canAddRules"], [2, "tenant", "x", "user", 1]);
    await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [1, "shared", "198.51.100.10", "198.51.100.10", 1, 1, now]);
    await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [2, "own", "198.51.100.11", "198.51.100.11", 2, 1, now]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"], [10, "shared-group", "host", "port", "", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    await insert("subscription_plans", ["id", "name"], [50, "shared"]);
    await insert("subscription_plan_hosts", ["planId", "hostId"], [50, 1]);
    await insert("subscription_plan_forward_groups", ["planId", "forwardGroupId"], [50, 10]);
    await insert("user_subscriptions", ["id", "userId", "planId", "status"], [60, 2, 50, "active"]);

    const tenant = rulesRouter.createCaller(callerContext({ id: 2, username: "tenant", role: "user", accountEnabled: true }));
    const admin = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));

    const ssh = await tenant.checkPort({ hostId: 1, sourcePort: 22, protocol: "tcp" });
    assert.equal(ssh.used, true);
    assert.match(ssh.reason, /系统保留端口/);
    const panel = await tenant.checkPort({ hostId: 1, sourcePort: 17555, protocol: "tcp" });
    assert.equal(panel.used, true);
    assert.match(panel.reason, /面板自身使用的端口/);
    assert.deepEqual(await tenant.checkPort({ hostId: 1, sourcePort: 20000, protocol: "tcp" }), { used: false });

    const groupSsh = await tenant.checkPort({ forwardGroupId: 10, sourcePort: 22, protocol: "tcp" });
    assert.equal(groupSsh.used, true);
    assert.match(groupSsh.reason, /系统保留端口/);
    assert.deepEqual(await tenant.checkPort({ forwardGroupId: 10, sourcePort: 20000, protocol: "tcp" }), { used: false });

    // 自己的主机、管理员不受限制
    assert.deepEqual(await tenant.checkPort({ hostId: 2, sourcePort: 22, protocol: "tcp" }), { used: false });
    assert.deepEqual(await admin.checkPort({ hostId: 1, sourcePort: 22, protocol: "tcp" }), { used: false });
    assert.deepEqual(await admin.checkPort({ forwardGroupId: 10, sourcePort: 22, protocol: "tcp" }), { used: false });
  `, { name: "check-port-tenant", env: { PORT: "17555" } });
});
