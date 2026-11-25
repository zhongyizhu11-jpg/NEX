import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

// 上游 v2.3.282：机器人 / 命令续期以前只改派生出来的 expiresAt，下一次权益同步按 manualExpiresAt
// 重算，续期就被悄悄改回去了。现在写 manualExpiresAt，并在写完后复核。
test("续期写手工到期时间，权益同步之后仍然是续期后的时间", () => {
  runInDatabase(String.raw`
    const db = await import(url("server/db.ts"));
    const commands = await import(url("server/services/userCommandService.ts"));
    const past = new Date(Date.now() - 3 * 86400_000);
    await exec('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [1, "admin", "hash", "admin"]);
    await exec('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [2, "bob", "hash", "user"]);
    await db.updateUserManualEntitlements(2, { manualExpiresAt: past });
    await db.syncUserSubscriptionEntitlements(2);
    const renewTo = new Date(Date.now() + 30 * 86400_000);
    await commands.renewUserCommand({ actor: { id: 1, role: "admin" }, targetUserId: 2, expiresAt: renewTo });
    await db.syncUserSubscriptionEntitlements(2);
    const user = await db.getUserById(2);
    assert.ok(user.expiresAt, "expiresAt set");
    assert.ok(Math.abs(new Date(user.expiresAt).getTime() - renewTo.getTime()) < 2000, "renewal survives the entitlement sync: " + user.expiresAt);
    await assert.rejects(commands.renewUserCommand({ actor: { id: 1, role: "admin" }, targetUserId: 2, expiresAt: new Date(NaN) }), /超出允许范围/);
  `, { name: "user-renew" });
});
