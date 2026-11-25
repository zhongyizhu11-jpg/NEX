import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("changing the profile email rejects someone else's address and clears verification", () => {
  runInDatabase(String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const cols = ["id", "username", "password", "role", "email", "emailVerified"];
    const insert = (values) => exec('INSERT INTO "users" (' + cols.map((c) => '"' + c + '"').join(", ") + ") VALUES (?, ?, ?, ?, ?, ?)", values);
    await insert([1, "alice", "x", "user", "alice@example.com", 1]);
    await insert([2, "bob", "x", "user", "bob@example.com", 1]);
    const row = async (id) => (await query('SELECT "email", "emailVerified" FROM "users" WHERE "id" = ?', [id]))[0];

    await assert.rejects(() => users.updateUserProfile(2, { email: "ALICE@example.com" }), /已被其他账户使用/);
    await assert.rejects(() => users.updateUserProfile(2, { email: "alice" }), /已被其他账户使用/, "another account's username is taken too");
    assert.equal((await row(2)).email, "bob@example.com");

    await users.updateUserProfile(2, { email: "bob.new@example.com" });
    assert.equal((await row(2)).email, "bob.new@example.com");
    assert.equal(Number((await row(2)).emailVerified), 0, "a new address is not verified");

    await exec('UPDATE "users" SET "emailVerified" = 1 WHERE "id" = 1');
    await users.updateUserProfile(1, { email: "Alice@Example.com", name: "Alice" });
    assert.equal(Number((await row(1)).emailVerified), 1, "re-saving the same address (case aside) keeps verification");
  `, { name: "profile-email" });
});
