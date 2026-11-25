import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("network test hosts match the explicit host access boundary", () => {
  runInDatabase(String.raw`
    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const { lookingGlassRouter } = await import(url("server/routers/lookingGlass.ts"));
    const quote = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await exec(
        "INSERT INTO " + quote(table) + " (" + columns.map(quote).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const context = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });

    const now = Math.floor(Date.now() / 1000);
    await insert("users", ["id", "username", "password", "role"], [1, "admin", "x", "admin"]);
    await insert("users", ["id", "username", "password", "role"], [2, "viewer", "x", "user"]);
    for (const [id, name, ownerId] of [
      [1, "manual", 1],
      [2, "hidden", 1],
      [3, "owned", 2],
      [4, "public-billing", 1],
      [5, "subscription", 1],
    ]) {
      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
        [id, name, "198.51.100." + id, "198.51.100." + id, ownerId, 1, now],
      );
    }
    await insert("user_host_permissions", ["userId", "hostId"], [2, 1]);
    await insert("subscription_plans", ["id", "name"], [10, "network-test-host"]);
    await insert("subscription_plan_hosts", ["planId", "hostId"], [10, 5]);
    await insert("user_subscriptions", ["id", "userId", "planId", "status"], [20, 2, 10, "active"]);
    await insert(
      "traffic_billing_configs",
      ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"],
      [30, "host", 4, 1, 0, 1, 100],
    );
    await settings.setSetting("trafficBillingEnabled", "true");

    const userCaller = lookingGlassRouter.createCaller(context({
      id: 2,
      username: "viewer",
      role: "user",
      accountEnabled: true,
    }));
    const adminCaller = lookingGlassRouter.createCaller(context({
      id: 1,
      username: "admin",
      role: "admin",
      accountEnabled: true,
    }));

    assert.deepEqual(
      (await userCaller.hosts()).map((host) => Number(host.id)).sort((a, b) => a - b),
      [1, 3, 5],
    );
    assert.deepEqual(
      (await adminCaller.hosts()).map((host) => Number(host.id)).sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    );

    await settings.setSetting("lookingGlassUserEnabled", "false");
    await assert.rejects(() => userCaller.hosts(), /管理员已关闭普通用户使用网络测试/);
    assert.equal((await adminCaller.hosts()).length, 5);
  `, { name: "looking-glass-access" });
});
