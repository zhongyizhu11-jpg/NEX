import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("host options fall back to the full-row query on a legacy hosts schema", () => {
  runInDatabase(String.raw`
    const hosts = await import(url("server/repositories/hostRepository.ts"));

    await exec(
      'INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)',
      [1, "admin", "hash", "Admin", "admin"],
    );
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [1, "Legacy host", "192.0.2.10", "192.0.2.10", "secret-agent-token", 1, 1, Math.floor(Date.now() / 1000)],
    );

    // Simulate a deployment that did not apply the later geo columns.
    for (const column of [
      "ipv4",
      "geoCountryCode", "geoCountryName", "geoRegion", "geoEmoji",
      "geoLatitudeMicro", "geoLongitudeMicro", "geoUpdatedAt",
    ]) {
      await exec('ALTER TABLE "hosts" DROP COLUMN "' + column + '"');
    }

    const options = await hosts.getHostOptions();
    assert.deepEqual(options.map((host) => Number(host.id)), [1]);
    assert.equal(options[0].name, "Legacy host");
    assert.equal(options[0].isOnline, true);
    assert.equal(options[0].agentToken, undefined);
  `, { name: "host-options" });
});
