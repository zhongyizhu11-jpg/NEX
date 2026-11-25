import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("disabling an account revokes every auth session and clears all leases", () => {
  runInDatabase(String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const sessions = await import(url("server/repositories/sessionRepository.ts"));
    const session = await import(url("server/session.ts"));
    await exec('INSERT INTO "users" ("id", "username", "password", "name", "role", "accountEnabled") VALUES (?, ?, ?, ?, ?, ?)', [1, "admin@example.com", "x", "Admin", "user", 1]);
    for (const [kind, sid] of [["browser", "browser-1"], ["mobile", "mobile-1"], ["telegram", "telegram-1"]]) {
      await sessions.createAuthSession({ userId: 1, sid, kind, expiresAt: new Date(Date.now() + 60_000) });
      await users.setUserSessionToken(1, kind, session.encodeSessionLease(sid), { touchUserUpdatedAt: false });
    }

    await users.setUserAccountEnabled(1, false);
    const rows = await query('SELECT "sid", "revokedAt", "revokeReason" FROM "auth_sessions" WHERE "userId" = ? ORDER BY "sid"', [1]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.revokedAt));
    assert.ok(rows.every((row) => row.revokeReason === "account_disabled"));
    const user = (await users.getUserById(1));
    assert.equal(Boolean(user.accountEnabled), false);
    assert.equal(user.browserSessionToken, null);
    assert.equal(user.mobileSessionToken, null);
    assert.equal(user.telegramSessionToken, null);
  `, { name: "account-disable" });
});

test("changing a user's role revokes their sessions, re-saving the same role does not", () => {
  runInDatabase(String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const sessions = await import(url("server/repositories/sessionRepository.ts"));
    const session = await import(url("server/session.ts"));
    const revokedCount = async () => (await query('SELECT "sid" FROM "auth_sessions" WHERE "userId" = ? AND "revokedAt" IS NOT NULL', [1])).length;
    await exec('INSERT INTO "users" ("id", "username", "password", "name", "role", "accountEnabled") VALUES (?, ?, ?, ?, ?, ?)', [1, "staff@example.com", "x", "Staff", "admin", 1]);
    await sessions.createAuthSession({ userId: 1, sid: "browser-1", kind: "browser", expiresAt: new Date(Date.now() + 60_000) });
    await users.setUserSessionToken(1, "browser", session.encodeSessionLease("browser-1"), { touchUserUpdatedAt: false });

    await users.updateUserRole(1, "admin");
    assert.equal(await revokedCount(), 0);

    await users.updateUserRole(1, "user");
    const rows = await query('SELECT "revokedAt", "revokeReason" FROM "auth_sessions" WHERE "userId" = ?', [1]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].revokedAt);
    assert.equal(rows[0].revokeReason, "role_changed");
    const user = await users.getUserById(1);
    assert.equal(user.role, "user");
    assert.equal(user.browserSessionToken, null);
  `, { name: "role-change" });
});
