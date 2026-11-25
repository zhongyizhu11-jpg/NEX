import test from "node:test";
import { runInDatabase } from "../testing/runInDatabase";

/*
  在真的 SQLite 上走一遍：建表（api_tokens / user_passkeys / auth_sessions 新列）、
  令牌创建 → 解析 → 撤销、维护模式挡登录、已登录设备列表。
*/
test("API 令牌、维护模式、已登录设备在 SQLite 上跑通", () => {
  runInDatabase(String.raw`
    await exec('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)', [1, "admin", "x", "Admin", "admin"]);
    await exec('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)', [2, "bob", "x", "Bob", "user"]);

    const tokens = await import(url("server/ops/apiTokens.ts"));
    const created = await tokens.createUserApiToken({ userId: 1, name: "ci", scope: "read", expiresInDays: 30 });
    assert.match(created.token, /^nex_/);
    const resolved = await tokens.resolveApiToken(created.token, "203.0.113.5");
    assert.equal(resolved.user.id, 1);
    assert.equal(resolved.apiToken.scope, "read");
    const listed = await tokens.listUserApiTokens(1);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].prefix, created.token.slice(0, 8));
    assert.equal(listed[0].lastUsedIp, "203.0.113.5");
    assert.equal(await tokens.resolveApiToken(created.token.slice(0, -1) + (created.token.endsWith("a") ? "b" : "a"), "x"), null);
    assert.equal(await tokens.revokeUserApiToken(2, created.id), false);
    assert.equal(await tokens.revokeUserApiToken(1, created.id), true);
    assert.equal(await tokens.resolveApiToken(created.token, "x"), null);
    assert.equal((await tokens.listUserApiTokens(1)).length, 0);

    const maintenance = await import(url("server/ops/maintenance.ts"));
    const login = await import(url("server/loginSessionService.ts"));
    await maintenance.saveMaintenanceState({ enabled: true, message: "升级中" });
    await assert.rejects(
      login.createLoginAuthSession({ userId: 2, sid: "bob-1", kind: "browser", expiresAt: new Date(Date.now() + 60_000) }),
      /面板维护中，请稍后再来：升级中/,
    );
    await login.createLoginAuthSession({ userId: 1, sid: "admin-1", kind: "browser", expiresAt: new Date(Date.now() + 60_000) });
    await maintenance.saveMaintenanceState({ enabled: false, message: "" });
    await login.createLoginAuthSession({ userId: 2, sid: "bob-1", kind: "browser", expiresAt: new Date(Date.now() + 60_000) });

    const devices = await import(url("server/ops/sessionDevices.ts"));
    devices.noteSessionClient("admin-1", { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1" }, ip: "::ffff:198.51.100.7" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sessions = await devices.listActiveUserSessions(1, "admin-1");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].device, "iPhone · Safari");
    assert.equal(sessions[0].ip, "198.51.100.7");
    assert.equal(sessions[0].current, true);

    const passkeys = await import(url("server/ops/passkeys.ts"));
    const id = await passkeys.insertPasskey({ userId: 1, name: "Mac", credentialId: "cred-1", publicKey: "pk", alg: -7, signCount: 0, transports: ["internal"] });
    assert.equal((await passkeys.findPasskeyByCredentialId("cred-1")).id, id);
    await passkeys.recordPasskeyUse(id, 4);
    assert.equal((await passkeys.listUserPasskeys(1))[0].signCount, 4);
    assert.equal(await passkeys.deletePasskey(2, id), false);
    assert.equal(await passkeys.deletePasskey(1, id), true);
  `, { name: "nex-account-security-" });
});
