import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 上游 v2.3.282：机器人 / 命令续期以前只改派生出来的 expiresAt，下一次权益同步按 manualExpiresAt
// 重算，续期就被悄悄改回去了。现在写 manualExpiresAt，并在写完后复核。
test("续期写手工到期时间，权益同步之后仍然是续期后的时间", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-user-renew-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const db = await import(moduleUrl("server/db.ts"));
    const commands = await import(moduleUrl("server/services/userCommandService.ts"));
    const past = new Date(Date.now() - 3 * 86400_000);
    await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [1, "admin", "hash", "admin"]);
    await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [2, "bob", "hash", "user"]);
    await db.updateUserManualEntitlements(2, { manualExpiresAt: past });
    await db.syncUserSubscriptionEntitlements(2);
    const renewTo = new Date(Date.now() + 30 * 86400_000);
    await commands.renewUserCommand({ actor: { id: 1, role: "admin" }, targetUserId: 2, expiresAt: renewTo });
    await db.syncUserSubscriptionEntitlements(2);
    const user = await db.getUserById(2);
    assert.ok(user.expiresAt, "expiresAt set");
    assert.ok(Math.abs(new Date(user.expiresAt).getTime() - renewTo.getTime()) < 2000, "renewal survives the entitlement sync: " + user.expiresAt);
    await assert.rejects(commands.renewUserCommand({ actor: { id: 1, role: "admin" }, targetUserId: 2, expiresAt: new Date(NaN) }), /超出允许范围/);
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "renew.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
