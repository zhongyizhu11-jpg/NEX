import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("single-device login atomically replaces the active browser session", () => {
  runInDatabase(String.raw`
    await exec('INSERT INTO "users" ("id", "username", "password", "name") VALUES (?, ?, ?, ?)', [1, "alice", "x", "Alice"]);

    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const sessions = await import(url("server/repositories/sessionRepository.ts"));
    const policy = await import(url("server/loginSessionService.ts"));
    const sessionValues = await import(url("server/session.ts"));
    await settings.setSetting("allowMultiDeviceLogin", "false");

    await sessions.createAuthSession({
      userId: 1,
      sid: "browser-a",
      kind: "browser",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await users.setUserSessionToken(1, "browser", sessionValues.encodeSessionLease("browser-a"), { touchUserUpdatedAt: false });
    await policy.createLoginAuthSession({
      userId: 1,
      sid: "browser-b",
      kind: "browser",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const user = await users.getUserById(1);
    assert.equal(sessionValues.parseSessionLease(user.browserSessionToken).sid, "browser-b");
    const rows = await query('SELECT "sid", "revokedAt", "revokeReason" FROM "auth_sessions" WHERE "userId" = ? ORDER BY "sid"', [1]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].sid, "browser-a");
    assert.ok(rows[0].revokedAt);
    assert.equal(rows[0].revokeReason, "replaced_by_login");
    assert.equal(rows[1].sid, "browser-b");
    assert.equal(rows[1].revokedAt, null);

    await exec('INSERT INTO "users" ("id", "username", "password", "name") VALUES (?, ?, ?, ?)', [2, "bob", "x", "Bob"]);
    await Promise.all([
      policy.createLoginAuthSession({ userId: 2, sid: "concurrent-a", kind: "browser", expiresAt: new Date(Date.now() + 60_000) }),
      policy.createLoginAuthSession({ userId: 2, sid: "concurrent-b", kind: "browser", expiresAt: new Date(Date.now() + 60_000) }),
    ]);
    const concurrentRows = await query('SELECT "sid", "revokedAt" FROM "auth_sessions" WHERE "userId" = ?', [2]);
    assert.equal(concurrentRows.filter((row) => row.revokedAt == null).length, 1);
    const concurrentUser = await users.getUserById(2);
    const winner = sessionValues.parseSessionLease(concurrentUser.browserSessionToken).sid;
    assert.equal(concurrentRows.find((row) => row.revokedAt == null).sid, winner);

    await exec('INSERT INTO "users" ("id", "username", "password", "name") VALUES (?, ?, ?, ?)', [3, "carol", "x", "Carol"]);
    await sessions.createAuthSession({
      userId: 3,
      sid: "remembered-cookie",
      kind: "browser",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await users.setUserSessionToken(
      3,
      "browser",
      sessionValues.encodeSessionLease("remembered-cookie", Date.now() - sessionValues.SESSION_ACTIVE_LEASE_TTL_MS - 1),
      { touchUserUpdatedAt: false },
    );
    await policy.createLoginAuthSession({
      userId: 3,
      sid: "fresh-login",
      kind: "browser",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const remembered = await query('SELECT "revokedAt" FROM "auth_sessions" WHERE "sid" = ?', ["remembered-cookie"]);
    assert.equal(remembered[0].revokedAt, null);
    const rememberedUser = await users.getUserById(3);
    assert.equal(sessionValues.parseSessionLease(rememberedUser.browserSessionToken).sid, "fresh-login");
  `, { name: "login-session" });
});
