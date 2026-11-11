import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  URL 连接检测（method = "http"）在面板这头的三件事：
    1. 只下发给 Agent ≥ 2.2.255 的主机，带超时、预期状态码、证书开关和规格指纹 probeKey；老 Agent 拿不到。
    2. 回报靠 probeKey 认：改了配置之后还在路上的旧结果、方式对不上的结果都丢掉。
    3. 失败种类和 HTTP 状态码随样本入库，「最近一轮」读得出来；范围内版本不够的主机列进 agentUpgradeHosts。
  另外顺带测负载：心跳报的小数存成乘 100 的整数，读最新指标时除回去。
*/
test("http host probe services: version gate, probeKey matching, failure storage, load averages", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-probe-http-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
      const probes = await mod("server/repositories/hostProbeServiceRepository.ts");
      const reports = await mod("server/agentReportRoutes.ts");
      const metrics = await mod("server/repositories/metricsRepository.ts");
      const { flushPendingWrites } = await mod("server/dbWriteBatcher.ts");

      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)', [1, "admin", "h", "Admin", "admin"]);
      await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, ?)', [10, "new", "10.0.0.10", "slave", "t10", 1, "2.2.255"]);
      await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, ?)', [11, "old", "10.0.0.11", "slave", "t11", 1, "2.2.252"]);
      await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)', [12, "never", "10.0.0.12", "slave", "t12", 1]);

      await probes.createHostProbeService({ name: "tcp", method: "tcping", targetIp: "1.1.1.1", targetPort: 443, hostScope: "all", userId: 1 });
      const httpId = await probes.createHostProbeService({
        name: "api", method: "http", targetIp: "https://example.com/health", targetPort: 443,
        httpTimeoutSeconds: 99, httpExpectedStatus: "200,204", httpSkipTlsVerify: true, hostScope: "all", userId: 1,
      });

      const service = await probes.getHostProbeServiceById(httpId);
      assert.equal(service.method, "http");
      assert.equal(service.targetPort, null);
      assert.equal(service.httpTimeoutSeconds, 30);
      assert.equal(service.httpExpectedStatus, "200,204");
      assert.equal(service.httpSkipTlsVerify, true);

      const newTasks = await probes.getHostProbeTasksForHost(10);
      const httpTask = newTasks.find((task) => task.method === "http");
      assert.ok(httpTask, "new Agent gets the http task");
      assert.equal(httpTask.targetIp, "https://example.com/health");
      assert.equal(httpTask.timeoutSeconds, 30);
      assert.equal(httpTask.expectStatus, "200,204");
      assert.equal(httpTask.insecureSkipVerify, true);
      assert.match(httpTask.probeKey, /^service:\d+:http:[0-9a-f]{32}$/);
      // 老 Agent 只拿到 TCPing；心跳传进来的新版本号优先于库里的
      assert.deepEqual((await probes.getHostProbeTasksForHost(11)).map((task) => task.method), ["tcping"]);
      assert.deepEqual((await probes.getHostProbeTasksForHost(11, { agentVersion: "2.2.255" })).map((task) => task.method).sort(), ["http", "tcping"]);
      assert.deepEqual((await probes.getHostProbeTasksForHost(12)).map((task) => task.method), ["tcping"]);

      // 需要升级的只有报过版本、而且不够的那台
      const upgrade = await probes.getHostProbeAgentUpgradeHosts(await probes.getHostProbeServices());
      assert.deepEqual(upgrade.get(httpId), [{ id: 11, name: "old", agentVersion: "2.2.252" }]);

      // 回报：probeKey 对得上才收；方式不符、改配置前的 key 都丢
      const expected = { ...httpTask };
      assert.equal(reports.hostProbeServiceStatFromReport(10, { serviceId: httpId, method: "http", probeKey: "stale", isTimeout: false, latencyMs: 5 }, expected), null);
      assert.equal(reports.hostProbeServiceStatFromReport(10, { serviceId: httpId, method: "tcping", probeKey: httpTask.probeKey, isTimeout: false, latencyMs: 5 }, expected), null);
      const tcpTask = newTasks.find((task) => task.method === "tcping");
      assert.equal(reports.hostProbeServiceStatFromReport(10, { serviceId: tcpTask.serviceId, method: "http", isTimeout: false, latencyMs: 5 }, tcpTask), null);
      const failed = reports.hostProbeServiceStatFromReport(10, {
        serviceId: httpId, method: "http", probeKey: httpTask.probeKey, isTimeout: true, latencyMs: 0,
        probeCount: 1, probeSuccesses: 0, failure: "http_status", httpStatus: 503,
      }, expected);
      assert.equal(failed.failure, "http_status");
      assert.equal(failed.httpStatus, 503);
      await probes.insertHostProbeServiceStats([failed]);
      const latest = (await probes.getLatestHostProbeServiceStats([httpId])).get(httpId);
      assert.equal(latest.isTimeout, true);
      assert.equal(latest.failure, "http_status");
      assert.equal(latest.httpStatus, 503);

      // 改了预期状态码 → probeKey 变了
      await probes.updateHostProbeService(httpId, { ...service, httpExpectedStatus: "200" });
      const changed = (await probes.getHostProbeTasksForHost(10)).find((task) => task.method === "http");
      assert.notEqual(changed.probeKey, httpTask.probeKey);
      // 换回 TCPing 时 URL 那几项回默认
      await probes.updateHostProbeService(httpId, { ...service, method: "tcping", targetIp: "1.0.0.1", targetPort: 80 });
      const back = await probes.getHostProbeServiceById(httpId);
      assert.equal(back.httpSkipTlsVerify, false);
      assert.equal(back.httpExpectedStatus, "200-399");

      // 负载：存乘 100 的整数，读出来是小数；没报的是 null
      await metrics.insertHostMetric({ hostId: 10, cpuUsage: 5, loadAvg1: 12, loadAvg5: 25, loadAvg15: 38 });
      await metrics.insertHostMetric({ hostId: 11, cpuUsage: 5 });
      await flushPendingWrites();
      const rows = await metrics.getLatestHostMetricRows([10, 11]);
      const byHost = new Map(rows.map((row) => [row.hostId, row]));
      assert.deepEqual([byHost.get(10).load1, byHost.get(10).load5, byHost.get(10).load15], [0.12, 0.25, 0.38]);
      assert.deepEqual([byHost.get(11).load1, byHost.get(11).load5, byHost.get(11).load15], [null, null, null]);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "probe.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
