import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 接上真库（SQLite）跑一遍这批主机 / Agent 管理功能的落库部分：
 * - 同 Token 换机接管：登记、接管、旧实例被拒、不带 ID 的旧 Agent 被拒、解除绑定，以及接管守卫中间件的回包；
 * - 流量阈值关机：同一周期只认领一次，过时的计数、关掉的开关认领不到，流量重置换了周期才能再认领；
 * - 资源告警按主机：本机「不监控」时不记事件，范围排除时也不记。
 */
test("host agent management state against a real database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-agent-mgmt-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const installation = await import(url("server/agentInstallation.ts"));
      const shutdown = await import(url("server/hostTrafficShutdown.ts"));
      const notifier = await import(url("server/resourceAlertNotifier.ts"));
      const events = await import(url("server/ops/panelEvents.ts"));

      await runtime.executeRaw("INSERT INTO users (id, username, password, role, email) VALUES (1, 'admin', 'h', 'admin', 'ops@example.com')");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (1, '港-1', '203.0.113.1', 'slave', 'tok1', 1, 1)");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (2, '日-1', '203.0.113.2', 'slave', 'tok2', 1, 1)");

      // ---------- 同 Token 换机接管 ----------
      const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
      assert.deepEqual(await installation.applyAgentInstallation(1, ""), { kind: "accept" }, "没绑定过：旧 Agent 照旧");
      assert.deepEqual(await installation.applyAgentInstallation(1, A), { kind: "bind" });
      assert.deepEqual(await installation.applyAgentInstallation(1, A), { kind: "accept" });
      assert.deepEqual(await installation.applyAgentInstallation(1, B), { kind: "takeover", previous: A });
      assert.deepEqual(await installation.applyAgentInstallation(1, A), { kind: "superseded" }, "旧机器再来被拒");
      assert.deepEqual(await installation.applyAgentInstallation(1, ""), { kind: "legacy-rejected" }, "不带 ID 的旧 Agent 被拒");
      const row = (await runtime.queryRaw("SELECT agentInstallationId, agentRetiredInstallationIds, agentInstallationChangedAt FROM hosts WHERE id = 1"))[0];
      assert.equal(row.agentInstallationId, B);
      assert.deepEqual(JSON.parse(row.agentRetiredInstallationIds), [A]);
      assert.ok(Number(row.agentInstallationChangedAt) > 0);

      // 两台新机器同时来：条件写入只让状态一致地前进，最后当前实例是其中之一，另一个进已接管列表或也被接管
      const results = await Promise.all([installation.applyAgentInstallation(2, B), installation.applyAgentInstallation(2, C)]);
      const after = await installation.getAgentInstallationState(2, { force: true });
      assert.ok([B, C].includes(after.current), JSON.stringify({ results, after }));

      // 守卫中间件：被接管的旧实例拿到 409 + agentSuperseded；当前实例放行；接管时调用回调
      const takeovers = [];
      const guard = installation.createAgentInstallationGuard({ onTakeover: (hostId, previous, next) => { takeovers.push([hostId, previous, next]); } });
      const run = async (installationId) => {
        const req = { method: "POST", agentTunneledPath: "/api/agent/heartbeat", agentToken: "tok1", agentInstallationId: installationId };
        const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        let nextCalled = false;
        await guard(req, res, () => { nextCalled = true; });
        return { nextCalled, status: res.statusCode, body: res.body };
      };
      assert.deepEqual(await run(B), { nextCalled: true, status: 200, body: null });
      const rejected = await run(A);
      assert.equal(rejected.nextCalled, false);
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.agentSuperseded, true);
      const legacy = await run(undefined);
      assert.equal(legacy.status, 409);
      assert.equal(legacy.body.agentSuperseded, undefined, "旧 Agent 不认这个字段，回一个普通错误");
      assert.equal((await run(C)).nextCalled, true);
      assert.deepEqual(takeovers, [[1, B, C]]);
      // 不经 /api/sync 的直连上报（forwardx-fxp 报流量）不管实例
      const direct = { method: "POST", agentToken: "tok1" };
      let directNext = false;
      await guard(direct, {}, () => { directNext = true; });
      assert.equal(directNext, true);

      // 解除绑定：之后第一个来的重新登记，原来被接管的实例也能回来
      await installation.resetAgentInstallation(1);
      assert.deepEqual(await installation.applyAgentInstallation(1, A), { kind: "bind" });
      assert.equal(await installation.isAgentInstallationRejected(1, C), false, "新的 ID 会接管，不算被拒");
      assert.equal(await installation.isAgentInstallationRejected(1, ""), true);

      // ---------- 流量阈值关机 ----------
      const GB = 1024 ** 3;
      const now = Math.floor(Date.now() / 1000);
      await runtime.executeRaw("UPDATE hosts SET trafficLimit = ?, trafficMeasureMode = 'both', trafficShutdownEnabled = 1, trafficShutdownThresholdPercent = 90 WHERE id = 1", [100 * GB]);
      await runtime.executeRaw("INSERT INTO host_traffic_counters (hostId, bytesIn, bytesOut, lastReportedAt, resetAt, createdAt, updatedAt) VALUES (1, ?, ?, ?, ?, ?, ?)", [50 * GB, 45 * GB, now, 1000, now, now]);
      shutdown.invalidateHostTrafficShutdownCache();
      assert.ok((await shutdown.getTrafficShutdownEnabledHostIds()).has(1));
      const snapshot = await shutdown.readHostTrafficShutdownSnapshot(1);
      assert.equal(snapshot.usedBytes, 95 * GB);
      assert.equal(snapshot.cycleMark, 1000);
      assert.equal(shutdown.evaluateSnapshot(snapshot, "2.2.253", true).due, true);
      assert.equal(shutdown.evaluateSnapshot(snapshot, "2.2.252", true).due, false);
      assert.equal(await shutdown.claimHostTrafficShutdown(1, now), 1000, "第一次认领到");
      assert.equal(await shutdown.claimHostTrafficShutdown(1, now), null, "同一周期不再认领");
      const triggered = await shutdown.readHostTrafficShutdownSnapshot(1);
      assert.equal(shutdown.evaluateSnapshot(triggered, "2.2.253", true).reason, "already-triggered");

      // 流量重置换了周期，用量再到阈值才能再认领
      await runtime.executeRaw("UPDATE host_traffic_counters SET bytesIn = 0, bytesOut = 0, resetAt = 2000 WHERE hostId = 1");
      assert.equal(await shutdown.claimHostTrafficShutdown(1, now), null, "刚重置、没到阈值");
      await runtime.executeRaw("UPDATE host_traffic_counters SET bytesIn = ?, lastReportedAt = ? WHERE hostId = 1", [91 * GB, now]);
      // 计数太旧（Agent 掉线期间的数）不认
      assert.equal(await shutdown.claimHostTrafficShutdown(1, now + shutdown.TRAFFIC_SHUTDOWN_COUNTER_FRESH_SECONDS + 5), null);
      // 开关关了不认
      await runtime.executeRaw("UPDATE hosts SET trafficShutdownEnabled = 0 WHERE id = 1");
      assert.equal(await shutdown.claimHostTrafficShutdown(1, now), null);
      await runtime.executeRaw("UPDATE hosts SET trafficShutdownEnabled = 1 WHERE id = 1");
      assert.equal(await shutdown.claimHostTrafficShutdown(1, now), 2000, "新周期认领一次");
      assert.equal(await shutdown.claimHostTrafficShutdown(1, now), null);
      // 重新布防（关掉再打开保存）后同一周期可以再认领
      await shutdown.rearmHostTrafficShutdown(1);
      assert.equal(await shutdown.claimHostTrafficShutdown(1, now), 2000);
      // 没有计数行的主机认领不到
      await runtime.executeRaw("UPDATE hosts SET trafficLimit = ?, trafficShutdownEnabled = 1 WHERE id = 2", [GB]);
      assert.equal(await shutdown.claimHostTrafficShutdown(2, now), null);

      // 扩展通道整条路径：旧 Agent 不下发；Agent 没报「能关」不下发；够新且能关时只下发一次
      const ext = await import(url("server/ops/agentExt.ts"));
      await import(url("server/ops/agentExtModules.ts"));
      await shutdown.rearmHostTrafficShutdown(1);
      shutdown.invalidateHostTrafficShutdownCache();
      const round = (agentVersion, supported) => ext.handleAgentExtRound(
        { id: 1, name: "港-1", agentVersion },
        { modules: supported === undefined ? {} : { traffic_shutdown: { supported, lastMark: "", lastError: "" } } },
      );
      assert.equal((await round("2.2.252", true)).modules.traffic_shutdown, undefined, "旧 Agent 不认这条指令");
      assert.equal((await round("2.2.253", false)).modules.traffic_shutdown, undefined, "不是 root Linux 不下发");
      const first = await round("2.2.253", true);
      assert.deepEqual(first.modules.traffic_shutdown, { shutdown: true, mark: "1:2000", thresholdPercent: 90 });
      assert.equal((await round("2.2.253", true)).modules.traffic_shutdown, undefined, "同一周期只下发一次");
      let notice = [];
      for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
        notice = await events.listPanelEvents({ kindPrefix: "host.traffic", limit: 5 });
        if (notice.length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(notice.length, 1, "关机前先记事件 / 发通知: " + JSON.stringify(notice));
      assert.match(notice[0].message, /即将关闭整台机器/);

      // ---------- 资源告警按主机 ----------
      await notifier.saveResourceAlertConfig({ enabled: true, cpuPercent: 90, memoryPercent: 0, diskPercent: 0, sustainSeconds: 60, recoverMarginPercent: 5, emailEnabled: false, scope: "exclude", scopeHostIds: [2], notifyOwner: false });
      const saved = await notifier.readResourceAlertConfig();
      assert.equal(saved.scope, "exclude");
      assert.deepEqual(saved.scopeHostIds, [2]);
      await runtime.executeRaw("UPDATE hosts SET resourceAlertOverride = ? WHERE id = 1", [JSON.stringify({ mode: "off" })]);
      notifier.invalidateHostResourceAlertOverrides();
      assert.equal((await notifier.readHostResourceAlertConfig(1)).enabled, false, "本机不监控");
      assert.equal((await notifier.readHostResourceAlertConfig(2)).enabled, false, "范围排除");
      const t0 = Date.now();
      for (const host of [{ id: 1, name: "港-1" }, { id: 2, name: "日-1" }]) {
        notifier.observeHostResourceSample(host, { cpu: 99 }, t0);
        notifier.observeHostResourceSample(host, { cpu: 99 }, t0 + 120_000);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal((await events.listPanelEvents({ kindPrefix: "host.resource", limit: 10 })).length, 0);
      // 本机始终监控 + 自己的 CPU 阈值：排除范围里的主机 2 也报
      await runtime.executeRaw("UPDATE hosts SET resourceAlertOverride = ? WHERE id = 2", [JSON.stringify({ mode: "on", cpuPercent: 60 })]);
      notifier.invalidateHostResourceAlertOverrides();
      const effective = await notifier.readHostResourceAlertConfig(2);
      assert.equal(effective.enabled, true);
      assert.equal(effective.cpuPercent, 60);
      notifier.observeHostResourceSample({ id: 2, name: "日-1" }, { cpu: 65 }, t0);
      notifier.observeHostResourceSample({ id: 2, name: "日-1" }, { cpu: 66 }, t0 + 61_000);
      const deadline = Date.now() + 15_000;
      let fired = [];
      while (Date.now() < deadline) {
        fired = await events.listPanelEvents({ kindPrefix: "host.resource", limit: 10 });
        if (fired.length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(fired.length, 1);
      assert.match(fired[0].message, /日-1 的 CPU 使用率 66%.*超过 60%/);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "host-agent.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
