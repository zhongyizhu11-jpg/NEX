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
      const settled = () => new Promise((resolve) => setTimeout(resolve, 100));

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
      await settled();
      assert.deepEqual(notifier.getFiringResourceAlerts().map((item) => item.metric), ["cpu"]);
      notifier.observeHostResourceSample(host, { cpu: 40, memory: 99, disk: 10 }, t0 + 180_000);
      await settled();

      const list = await events.listPanelEvents({ kindPrefix: "host.resource", limit: 10 });
      const kinds = list.map((event) => event.kind).sort();
      assert.deepEqual(kinds, ["host.resource_high", "host.resource_recovered"]);
      const high = list.find((event) => event.kind === "host.resource_high");
      assert.equal(high.level, "warn");
      assert.match(high.message, /港-1 的CPU使用率 97%/);
      const recovered = list.find((event) => event.kind === "host.resource_recovered");
      assert.match(recovered.message, /最高 97%/);
      assert.equal(notifier.getFiringResourceAlerts().length, 0);
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
