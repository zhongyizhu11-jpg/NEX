import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  后台任务租约接上真库（SQLite）：同一个进程里起两个「实例」（两份 PanelLease，同一个库、同一个假时钟）。
  - 租约行、实例登记行真的写进 panel_leases，只有一个是持有者；
  - 非持有实例上的转发组评估不写 DNS，写成 panel_work_requests 里的一行，持有者取走后才写（只写一次）；
  - 两个实例各起一份「转发组巡检」，每一轮 DNS 只写一次；持有者停了，另一个在 TTL + 一个续约间隔内接手，之后只有它写。
  外部库（PostgreSQL / MySQL）上同一套租约语句见 panelLease.external.test.ts。
*/
test("SQLite：两个实例只有一个跑巡检，非持有者的评估交给持有者，换持有者后 DNS 也只写一次", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-panel-lease-"));
  const databasePath = path.join(directory, "lease.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const requests = [];
    const webhook = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body || "{}"));
        response.writeHead(204);
        response.end();
      });
    });
    while (true) {
      await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
      const address = webhook.address();
      if (address && typeof address === "object" && address.port > 10080) break;
      await new Promise((resolve) => webhook.close(resolve));
    }
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
      const forwardGroups = await import(moduleUrl("server/db.ts"));
      const fast = await import(moduleUrl("server/agentFastLiveness.ts"));
      const leaseModule = await import(moduleUrl("server/panelLease.ts"));
      const work = await import(moduleUrl("server/panelWorkRequests.ts"));
      const scheduled = await import(moduleUrl("server/scheduledTask.ts"));
      const address = webhook.address();
      await settings.setSettings({
        ddnsEnabled: "true",
        ddnsProvider: "webhook",
        ddnsWebhookUrl: "http://127.0.0.1:" + address.port + "/ddns",
        ddnsWebhookMethod: "POST",
        ddnsTtl: "60",
      });

      const q = (name) => '"' + name + '"';
      const insert = (table, columns, values) => runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
      const now = Math.floor(Date.now() / 1000);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [1, "primary", "198.51.100.10", "198.51.100.10", 1, 1, now, "2.2.264"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [2, "standby", "198.51.100.20", "198.51.100.20", 1, 1, now, "2.2.264"]);
      fast.registerPresenceCapableHost(1);
      fast.registerPresenceCapableHost(2);
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "failoverSeconds", "recoverSeconds", "autoFailback"],
        [10, "failover", "host", "failover", "edge.example.test", "A", "0.0.0.0", 1, 1, 101, 60, 120, 1],
      );
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 1, 1]);

      // 两个「实例」：同一个库、同一个假时钟；续约由测试手动推进
      let clock = Date.now();
      const store = new leaseModule.SqlPanelLeaseStore();
      const quiet = { info: () => {}, warn: () => {} };
      const makeLease = (instanceId) => new leaseModule.PanelLease({
        store, instanceId, now: () => clock, logger: quiet,
        setTimer: () => ({ unref() {} }), clearTimer: () => {},
      });
      const a = makeLease("instance-a");
      const b = makeLease("instance-b");
      await a.start();
      await b.start();
      await a.tick();
      assert.equal(a.isHolder(), true);
      assert.equal(b.isHolder(), false);
      assert.equal(b.status().holderId, "instance-a");
      assert.deepEqual(a.status().otherInstanceIds, ["instance-b"]);
      const leaseRows = await runtime.queryRaw('SELECT "name", "holder" FROM "panel_leases" ORDER BY "name"');
      assert.deepEqual(leaseRows.map((row) => row.name + "=" + row.holder), ["background=instance-a", "instance:instance-a=instance-a", "instance:instance-b=instance-b"]);

      // 非持有实例上点「立即同步」：不写 DNS，交给持有者
      leaseModule.setPanelBackgroundLeaseForTests(b);
      await forwardGroups.runForwardGroupFailover(10, { manual: true, forceSync: true });
      assert.equal(requests.length, 0, "非持有实例写了 DNS");
      const pending = await runtime.queryRaw('SELECT "name", "payload" FROM "panel_work_requests"');
      assert.deepEqual(pending.map((row) => row.name), ["forward-group:10"]);
      assert.deepEqual(JSON.parse(pending[0].payload), { forceSync: true, manual: true });
      // 再来一次：同一件事只留一行
      await forwardGroups.runForwardGroupFailover(10, { manual: true, forceSync: true });
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "panel_work_requests"'))[0].n, 1);
      // 非持有者取不走（只有持有者轮询；这里直接看 drain 也不会被非持有者调）
      leaseModule.setPanelBackgroundLeaseForTests(a);
      assert.equal(await work.drainPanelWorkRequests(), 1);
      assert.equal(requests.length, 1, "持有者取走后写一次 DNS");
      assert.equal(requests[0].value, "198.51.100.10");
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "panel_work_requests"'))[0].n, 0);

      // 两个实例各起一份巡检（和 scheduler.ts 一样用 shouldRun 挡），每一轮 DNS 只写一次
      const sweepFor = (lease) => scheduled.createNonOverlappingScheduledTask("forward-group sweep " + lease.instanceId, async () => {
        leaseModule.setPanelBackgroundLeaseForTests(lease);
        await forwardGroups.runForwardGroupFailoverSweep({ manual: true, forceSync: true });
      }, { shouldRun: () => lease.isHolder(), logger: quiet });
      const sweepA = sweepFor(a);
      const sweepB = sweepFor(b);
      const runRound = async () => {
        const before = requests.length;
        const ran = [await sweepA(), await sweepB()];
        return { ran, writes: requests.length - before };
      };
      for (let round = 0; round < 3; round += 1) {
        clock += 10_000;
        await a.tick();
        await b.tick();
        const result = await runRound();
        assert.deepEqual(result.ran, [true, false]);
        assert.equal(result.writes, 1, "一轮写了 " + result.writes + " 次");
      }

      // A 卡住不再续约：B 每 10 秒续一次，最迟 TTL + 一个续约间隔后接手；期间每一轮最多一个实例写
      const lastRenew = clock;
      let takeoverAt = null;
      while (clock - lastRenew <= leaseModule.PANEL_LEASE_TTL_MS + 2 * leaseModule.PANEL_LEASE_RENEW_INTERVAL_MS) {
        clock += leaseModule.PANEL_LEASE_RENEW_INTERVAL_MS;
        await b.tick();
        assert.ok(!(a.isHolder() && b.isHolder()), "两边同时是持有者");
        const result = await runRound();
        assert.ok(result.writes <= 1, "一轮写了 " + result.writes + " 次");
        if (b.isHolder() && takeoverAt === null) takeoverAt = clock;
        if (takeoverAt !== null) assert.deepEqual(result.ran, [false, true]);
      }
      assert.ok(takeoverAt !== null, "B 没接手");
      assert.ok(takeoverAt - lastRenew <= leaseModule.PANEL_LEASE_TTL_MS + leaseModule.PANEL_LEASE_RENEW_INTERVAL_MS, "接手用了 " + (takeoverAt - lastRenew) + "ms");
      assert.equal((await runtime.queryRaw('SELECT "holder" FROM "panel_leases" WHERE "name" = ?', ["background"]))[0].holder, "instance-b");
      // A 醒过来：抢不回来，也不跑
      await a.tick();
      assert.equal(a.isHolder(), false);
      assert.equal(a.status().holderId, "instance-b");
      const result = await runRound();
      assert.deepEqual(result.ran, [false, true]);
      assert.equal(result.writes, 1);

      // B 正常退出放掉租约：A 下一轮就接手
      await b.stop({ release: true });
      clock += 1_000;
      await a.tick();
      assert.equal(a.isHolder(), true);
      leaseModule.setPanelBackgroundLeaseForTests(null);
    } finally {
      await new Promise((resolve) => webhook.close(resolve));
    }
    process.exit(0);
  `;
  try {
    const scriptPath = path.join(directory, "lease.mjs");
    fs.writeFileSync(scriptPath, script, "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
