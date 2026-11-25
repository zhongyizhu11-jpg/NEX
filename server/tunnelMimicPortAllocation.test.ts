import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * Mimic UDP ports are persisted across Agent reconciliations.  A host NAT
 * policy change must therefore repair an old value instead of blindly
 * retaining a port that can never be reached through the gateway.
 */
test("reconciles a stale mimic UDP port inside the host policy", () => {
  runInDatabase(String.raw`
    const tunnelRepo = await import(url("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await exec(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
      [1, "entry", "198.51.100.10", "slave", 1, 10000, 10099, 1]);
    await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
      [2, "nat-exit", "198.51.100.11", "slave", 1, 22600, 22602, 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "mimicPort", "udpOverTcp", "forwardxVersion", "userId", "isEnabled"],
      [10, "stale-mimic", 1, 2, "forwardx", 22600, 56645, 1, "v1", 1, 1]);

    const tunnel = (await query('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
    const result = await tunnelRepo.ensureForwardXMimicPorts(tunnel, [], []);
    const repaired = (await query('SELECT "mimicPort" FROM "tunnels" WHERE "id" = ?', [10]))[0];
    assert.ok(result.changed, "stale mimic value should be repaired");
    assert.ok(Number(repaired.mimicPort) >= 22601 && Number(repaired.mimicPort) <= 22602,
      "mimic port escaped the NAT range: " + repaired.mimicPort);
    assert.notEqual(Number(repaired.mimicPort), 56645);
    assert.equal(Number(result.tunnel.mimicPort), Number(repaired.mimicPort));
  `, { name: "mimic-port" });
});

test("mimic allocation preserves an allowed port outside the host range", () => {
  runInDatabase(String.raw`
    const tunnelRepo = await import(url("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await exec(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "portAllowlist", "isOnline"],
      [1, "entry", "198.51.100.20", "slave", 1, 10000, 10099, "", 1]);
    await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "portAllowlist", "isOnline"],
      [2, "nat-exit", "198.51.100.21", "slave", 1, 22600, 22600, "23001", 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "mimicPort", "udpOverTcp", "forwardxVersion", "userId", "isEnabled"],
      [10, "allowlisted-mimic", 1, 2, "forwardx", 22600, 0, 1, "v1", 1, 1]);

    const tunnel = (await query('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
    const result = await tunnelRepo.ensureForwardXMimicPorts(tunnel, [], []);
    const repaired = (await query('SELECT "mimicPort" FROM "tunnels" WHERE "id" = ?', [10]))[0];
    assert.equal(Number(repaired.mimicPort), 23001, "allowlisted mimic port was discarded");
    assert.equal(Number(result.tunnel.mimicPort), 23001);
  `, { name: "mimic-allowlist" });
});

test("duplicate mimic ports within one tunnel are split safely", () => {
  runInDatabase(String.raw`
    const tunnelRepo = await import(url("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await exec(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
      [1, "entry", "198.51.100.30", "slave", 1, 10000, 10099, 1]);
    await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
      [2, "nat-exit", "198.51.100.31", "slave", 1, 22600, 22603, 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "mimicPort", "udpOverTcp", "forwardxVersion", "userId", "isEnabled"],
      [10, "duplicate-mimic", 1, 2, "forwardx", 22600, 22601, 1, "v1", 1, 1]);
    await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "mimicPort", "isEnabled"],
      [100, 10, 1, 2, 22602, 22601, 1]);

    const tunnel = (await query('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
    const nodes = await query('SELECT * FROM "tunnel_exit_nodes" WHERE "tunnelId" = ?', [10]);
    const result = await tunnelRepo.ensureForwardXMimicPorts(tunnel, [], nodes);
    const repaired = (await query('SELECT "mimicPort" FROM "tunnel_exit_nodes" WHERE "id" = ?', [100]))[0];
    assert.notEqual(Number(repaired.mimicPort), 22601, "duplicate mimic port was retained");
    assert.ok(Number(repaired.mimicPort) >= 22600 && Number(repaired.mimicPort) <= 22603);
    assert.notEqual(Number(repaired.mimicPort), 22600, "mimic port may not shadow the tunnel listener");
    assert.equal(Number(result.exitNodes[0].mimicPort), Number(repaired.mimicPort));
  `, { name: "mimic-duplicate" });
});
