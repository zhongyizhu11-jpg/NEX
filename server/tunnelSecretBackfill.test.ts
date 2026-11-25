import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";
import { tunnelSecretSeed } from "./agentRouteUtils";

test("the tunnel secret fallback is no longer derivable from public ids", () => {
  const tunnel = { id: 7, entryHostId: 1, exitHostId: 2, secret: null };
  const legacyPredictable = crypto.createHash("sha256").update("forwardx-tunnel:7:1:2").digest("hex");
  assert.notEqual(tunnelSecretSeed(tunnel), legacyPredictable);
  assert.equal(tunnelSecretSeed(tunnel), tunnelSecretSeed({ ...tunnel }), "fallback stays stable within one panel");
  assert.equal(tunnelSecretSeed({ ...tunnel, secret: "abc" }), "abc");
});

test("schema ensure backfills random secrets for legacy tunnels without one", () => {
  runInDatabase(String.raw`
    const insert = 'INSERT INTO "tunnels" ("id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "secret") VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    await exec(insert, [1, "null-secret", 1, 2, "tls", 20001, 1, null]);
    await exec(insert, [2, "empty-secret", 1, 2, "tls", 20002, 1, ""]);
    await exec(insert, [3, "kept-secret", 1, 2, "tls", 20003, 1, "existing-secret"]);
    await schema.ensureDatabaseSchema();
    const rows = await query('SELECT "id", "secret" FROM "tunnels" ORDER BY "id"');
    assert.match(String(rows[0].secret), /^[a-f0-9]{64}$/);
    assert.match(String(rows[1].secret), /^[a-f0-9]{64}$/);
    assert.notEqual(rows[0].secret, rows[1].secret);
    assert.equal(rows[2].secret, "existing-secret");
  `, { name: "tunnel-secret" });
});
