import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("host probe services with all/exclude scope never run on tenant-owned hosts", () => {
  runInDatabase(String.raw`
    const probes = await import(url("server/repositories/hostProbeServiceRepository.ts"));

    await exec('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)', [1, "admin", "h", "Admin", "admin"]);
    await exec('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)', [2, "tenant", "h", "Tenant", "user"]);
    await exec('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)', [10, "admin-host", "10.0.0.10", "slave", "t10", 1]);
    await exec('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)', [20, "tenant-host", "10.0.0.20", "slave", "t20", 2]);

    await probes.createHostProbeService({ name: "all", method: "ping", targetIp: "1.1.1.1", hostScope: "all", userId: 1 });
    await probes.createHostProbeService({ name: "exclude", method: "ping", targetIp: "8.8.8.8", hostScope: "exclude", excludeHostIds: [99], userId: 1 });
    await probes.createHostProbeService({ name: "specific", method: "ping", targetIp: "9.9.9.9", hostScope: "specific", hostIds: [20], userId: 1 });

    const targets = async (hostId) => (await probes.getHostProbeTasksForHost(hostId)).map((task) => task.targetIp).sort();
    assert.deepEqual(await targets(10), ["1.1.1.1", "8.8.8.8"]);
    // 租户主机只跑管理员点名给它的服务。
    assert.deepEqual(await targets(20), ["9.9.9.9"]);
  `, { name: "probe-scope" });
});
