import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  P11：国内健康检查关着时，保存组（改个名字、改备注）不该重置成员健康。

  以前「要不要重置」的第一个条件是「健康检查没开」，于是没开健康检查的组每保存一次，所有成员的
  healthStatus / failureSince / healthySince 都被清掉：正在计时的故障观察、恢复观察从头再来（切换被推迟，
  或者刚恢复的成员又要重新等一遍），界面上成员全部变回「未知」。
  只有健康检查的开关 / 目标 / 方式变了，旧结论才不作数。
*/
test("健康检查关着时保存组不重置成员健康；改了健康检查设置才重置", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-save-health-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    console.info = () => {};
    console.warn = () => {};
    const service = await import(moduleUrl("server/services/forwardGroupService.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    for (const [id, ip] of [[1, "198.51.100.1"], [2, "198.51.100.2"]]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, 1, 1, ?)', [id, "h" + id, ip, ip, now]);
    }
    const input = (overrides = {}) => ({
      name: "resource",
      remark: null,
      groupMode: "failover",
      groupType: "host",
      protocol: "tcp",
      forwardType: "iptables",
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: 1,
      tcpFastOpen: false,
      zeroCopy: false,
      udpOverTcp: false,
      udpOverTcpPort: null,
      failoverEnabled: false,
      failoverStrategy: "fallback",
      failoverTargets: [],
      domain: null,
      recordType: "A",
      failoverSeconds: 60,
      recoverSeconds: 120,
      trafficMultiplier: 100,
      chinaHealthCheckEnabled: false,
      chinaHealthCheckTarget: null,
      telegramSwitchNotifyEnabled: false,
      ddnsAutoResolveEnabled: false,
      autoFailback: true,
      isEnabled: true,
      members: [
        { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
        { memberType: "host", hostId: 2, priority: 1, isEnabled: true },
      ],
      ...overrides,
    });
    const id = await service.createForwardGroupFromInput(input(), 1);
    const seedHealth = () => exec(
      'UPDATE forward_group_members SET "healthStatus" = CASE WHEN "hostId" = 1 THEN \'unhealthy\' ELSE \'healthy\' END,'
        + ' "failureSince" = CASE WHEN "hostId" = 1 THEN ? ELSE NULL END, "healthySince" = CASE WHEN "hostId" = 2 THEN ? ELSE NULL END, "lastCheckedAt" = ? WHERE "groupId" = ?',
      [now - 40, now - 300, now, id],
    );
    const health = async () => (await query('SELECT "hostId", "healthStatus", "failureSince", "healthySince" FROM forward_group_members WHERE "groupId" = ? ORDER BY priority', [id]))
      .map((row) => [Number(row.hostId), row.healthStatus, row.failureSince === null ? null : Number(row.failureSince), row.healthySince === null ? null : Number(row.healthySince)]);

    await seedHealth();
    await service.updateForwardGroupFromInput(id, input({ name: "renamed", remark: "改个备注" }));
    assert.deepEqual(await health(), [[1, "unhealthy", now - 40, null], [2, "healthy", null, now - 300]], "只改了名字和备注：成员健康和计时原样留着");

    // 打开健康检查：旧结论不是按这个目标测的，要重置。
    await service.updateForwardGroupFromInput(id, input({ name: "renamed", chinaHealthCheckEnabled: true, chinaHealthCheckTarget: "203.0.113.9:443" }));
    assert.deepEqual(await health(), [[1, "unknown", null, null], [2, "unknown", null, null]], "健康检查设置变了才重置");
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "save.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
