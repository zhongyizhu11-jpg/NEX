import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  在真的 SQLite 上走一遍：首次运行用 host_metrics 回填，公开接口读出可用率、每日条和断线事件。
*/
test("可用率：回填心跳空档并由公开接口读出", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("../dbRuntime");
  const { ensureDatabaseSchema } = await import("../dbSchema");
  const settings = await import("../repositories/settingsRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-availability-"));
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "a.db") } });
    await ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    const adminId = await runtime.insertAndGetId("users", { username: "admin", password: "x", role: "admin" });
    // 主机 1：在线，两小时前断过一小时；主机 2：半小时前断线至今；主机 3：普通用户的，公开页不显示
    const host1 = await runtime.insertAndGetId("hosts", { name: "香港-1", ip: "1.1.1.1", userId: adminId, isOnline: true, lastHeartbeat: now });
    const host2 = await runtime.insertAndGetId("hosts", { name: "东京-2", ip: "2.2.2.2", userId: adminId, isOnline: false, lastHeartbeat: now - 1800 });
    const userId = await runtime.insertAndGetId("users", { username: "u", password: "x", role: "user" });
    await runtime.insertAndGetId("hosts", { name: "别人的", ip: "3.3.3.3", userId, isOnline: false, lastHeartbeat: now - 1800 });
    for (let t = now - 4 * 3600; t <= now; t += 300) {
      if (!(t > now - 3 * 3600 && t < now - 2 * 3600)) await runtime.insertAndGetId("host_metrics", { hostId: host1, recordedAt: t });
      if (t <= now - 1800) await runtime.insertAndGetId("host_metrics", { hostId: host2, recordedAt: t });
    }
    await settings.setSettings({ publicHostMonitorEnabled: "true", publicHostMonitorPath: "status" });

    const job = await import("./statusAvailabilityJob");
    await job.runStatusAvailabilityTick();

    const incidents = await runtime.queryRaw<any>(`SELECT * FROM host_availability_incidents ORDER BY startedAt`);
    assert.equal(incidents.length, 3, "主机 1 一次已恢复，主机 2 一次未恢复，主机 3 一次未恢复（只是公开页不显示）");
    const h1 = incidents.find((row) => Number(row.hostId) === host1);
    assert.ok(h1.endedAt, "主机 1 的断线已恢复");
    assert.ok(Math.abs(Number(h1.durationSeconds) - (3600 - 300)) <= 300);
    const h2 = incidents.find((row) => Number(row.hostId) === host2);
    assert.equal(h2.endedAt, null);

    const { statusAvailabilityRouter } = await import("../routers/ops/statusAvailability");
    const caller = statusAvailabilityRouter.createCaller({} as any);
    const result: any = await caller.public({ path: "status" });
    assert.equal(result.totalHosts, 2);
    assert.equal(result.offlineHosts, 1);
    assert.deepEqual(result.offlineHostNames, ["东京-2"]);
    assert.equal(result.days.length, 30);
    assert.ok(result.availability24h > 0.5 && result.availability24h < 1);
    assert.ok(result.availability30d > 0.5 && result.availability30d < 1);
    assert.equal(result.incidents.length, 2);
    assert.equal(result.incidents[0].hostName, "东京-2");
    assert.equal(result.incidents[0].endedAt, null);
    assert.ok(result.days.some((cell: any) => cell.state === "partial" || cell.state === "major"));

    // 路径不对就是 404，和公开监控页同一道关
    await assert.rejects(() => caller.public({ path: "nope" }));

    // 第二轮：实时采样接上，不重复回填
    await job.runStatusAvailabilityTick();
    const again = await runtime.queryRaw<any>(`SELECT COUNT(*) AS n FROM host_availability_incidents`);
    assert.equal(Number(again[0].n), 3);
  } finally {
    await runtime.closeDatabase().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
