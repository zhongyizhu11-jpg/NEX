import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 资源告警接上真库（SQLite）跑一遍：设置存得进、读得回；心跳样本持续超过阈值记一条「超过」事件，
 * 回落记一条「恢复」；关掉之后不再记。
 */
test("resource alerts record fire / recover events against a real database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-resource-alert-"));
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
      const notifier = await import(url("server/resourceAlertNotifier.ts"));
      const events = await import(url("server/ops/panelEvents.ts"));
      const settled = () => new Promise((resolve) => setTimeout(resolve, 200));
      // 并发跑测试时机器很忙：等到事件真的写进去（最多 15 秒），不靠固定的等待时间。
      const waitForEvents = async (prefix, count) => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const list = await events.listPanelEvents({ kindPrefix: prefix, limit: 10 });
          if (list.length >= count || Date.now() > deadline) return list;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };

      await runtime.executeRaw("INSERT INTO users (id, username, password, role, email) VALUES (1, 'admin', 'h', 'admin', 'ops@example.com')");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (1, '港-1', '203.0.113.1', 'slave', 'tok1', 1, 1)");

      assert.equal((await notifier.readResourceAlertConfig()).enabled, false);
      const saved = await notifier.saveResourceAlertConfig({ enabled: true, cpuPercent: 90, memoryPercent: 0, diskPercent: 90, sustainSeconds: 60, recoverMarginPercent: 5, emailEnabled: false });
      assert.equal(saved.enabled, true);
      assert.equal(saved.memoryPercent, 0);
      // 保存会清掉 getAllSettings 的缓存，马上读得到新值
      assert.equal((await notifier.readResourceAlertConfig()).enabled, true);

      const host = { id: 1, name: "港-1" };
      const t0 = Date.now();
      notifier.observeHostResourceSample(host, { cpu: 95, memory: 99, disk: 10 }, t0);
      await settled();
      notifier.observeHostResourceSample(host, { cpu: 97, memory: 99, disk: 10 }, t0 + 61_000);
      await waitForEvents("host.resource", 1);
      assert.deepEqual(notifier.getFiringResourceAlerts().map((item) => item.metric), ["cpu"]);
      notifier.observeHostResourceSample(host, { cpu: 40, memory: 99, disk: 10 }, t0 + 180_000);
      await settled();

      const list = await waitForEvents("host.resource", 2);
      const kinds = list.map((event) => event.kind).sort();
      assert.deepEqual(kinds, ["host.resource_high", "host.resource_recovered"]);
      const high = list.find((event) => event.kind === "host.resource_high");
      assert.equal(high.level, "warn");
      assert.match(high.message, /港-1 的 CPU 使用率 97%/);
      const recovered = list.find((event) => event.kind === "host.resource_recovered");
      assert.match(recovered.message, /最高 97%/);
      assert.equal(notifier.getFiringResourceAlerts().length, 0);

      // OOM / 服务崩溃：第一次只做基线，涨了才报；换了 bootId（机器重启）重新当基线
      notifier.observeHostHealthCounters(host, { bootId: "b1", oomKillCount: 2, serviceRestarts: { "forwardx-runtime.service": 1 } });
      notifier.observeHostHealthCounters(host, { bootId: "b1", oomKillCount: 3, serviceRestarts: { "forwardx-runtime.service": 1, "forwardx-realm-12.service": 2 } });
      await settled();
      notifier.observeHostHealthCounters(host, { bootId: "b2", oomKillCount: 0, serviceRestarts: {} });
      notifier.observeHostHealthCounters(host, { bootId: "b2", oomKillCount: 0, serviceRestarts: {} });
      await settled();
      const oom = await waitForEvents("host.oom", 1);
      assert.equal(oom.length, 1);
      assert.equal(oom[0].level, "crit");
      assert.match(oom[0].message, /OOM 杀掉了 1 个进程/);
      const crash = await waitForEvents("host.process", 1);
      assert.equal(crash.length, 1);
      assert.match(crash[0].message, /realm 规则 #12 ×2/);

      // 隧道丢包
      await runtime.executeRaw("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (7, '港-日', 1, 1, 30000, 1)");
      notifier.observeTunnelProbeLoss(host, [{ tunnelId: 7, count: 10, ok: 5 }], t0);
      await waitForEvents("host.packet", 1);
      notifier.observeTunnelProbeLoss(host, [{ tunnelId: 7, count: 40, ok: 40 }], t0 + 11 * 60_000);
      await settled();
      const loss = await waitForEvents("host.packet", 2);
      assert.deepEqual(loss.map((event) => event.kind).sort(), ["host.packet_loss", "host.packet_loss_recovered"]);
      assert.match(loss.find((event) => event.kind === "host.packet_loss").message, /隧道「港-日」从 港-1 探测丢包 50%/);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "resource-alert.db"),
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
