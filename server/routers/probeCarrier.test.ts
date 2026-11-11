import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("三网视图：一键加上海三网、标签存得住（启停开关不清标签）、按运营商读出探测数据", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-carrier-"));
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
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'u', 'hash', 'user')");
      await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId", "geoCountryCode") VALUES (1, ?, ?, ?, ?, 1, ?)', ["沪A", "8.8.8.8", "slave", "tok1", "cn"]);
      const db = await import(url("server/db.ts"));
      const { probeCarrierRouter } = await import(url("server/routers/probeCarrier.ts"));
      const { hostsRouter } = await import(url("server/routers/hosts.ts"));
      const ctx = (id, role) => ({ user: { id, role, username: role }, req: { headers: {} }, res: { setHeader: () => {} } });
      const admin = probeCarrierRouter.createCaller(ctx(1, "admin"));

      assert.equal((await admin.view()).presetMissing.length, 3);
      assert.deepEqual(await admin.addShanghaiPreset(), { created: 3, skipped: 0 });
      assert.deepEqual(await admin.addShanghaiPreset(), { created: 0, skipped: 3 }, "再点一次不重复加");
      const services = await db.getHostProbeServices();
      const byCarrier = Object.fromEntries(services.map((s) => [s.carrier, s]));
      assert.equal(byCarrier.cu.method, "tcping");
      assert.equal(byCarrier.cu.targetPort, 53);
      assert.equal(byCarrier.ct.hostScope, "all");

      // 列表上的启停开关只带老字段：标签不能被清掉
      const hosts = hostsRouter.createCaller(ctx(1, "admin"));
      const ct = byCarrier.ct;
      await hosts.updateProbeService({ id: ct.id, name: ct.name, method: "ping", targetIp: ct.targetIp, targetPort: null, addressFamily: "auto", hostScope: "all", hostIds: [], excludeHostIds: [], intervalSeconds: 60, isEnabled: false });
      assert.equal((await db.getHostProbeServiceById(ct.id)).carrier, "ct");
      // 编辑表单显式清掉
      await hosts.updateProbeService({ id: ct.id, name: ct.name, method: "ping", targetIp: ct.targetIp, targetPort: null, addressFamily: "auto", carrier: null, hostScope: "all", intervalSeconds: 60, isEnabled: true });
      assert.equal((await db.getHostProbeServiceById(ct.id)).carrier, null);
      await hosts.updateProbeService({ id: ct.id, name: ct.name, method: "ping", targetIp: ct.targetIp, targetPort: null, addressFamily: "auto", carrier: "ct", hostScope: "all", intervalSeconds: 60, isEnabled: true });

      await db.insertHostProbeServiceStats([
        { serviceId: ct.id, hostId: 1, latencyMs: 31, isTimeout: false, probeCount: 5, probeSuccesses: 5 },
        { serviceId: byCarrier.cu.id, hostId: 1, latencyMs: null, isTimeout: true, probeCount: 1, probeSuccesses: 0 },
      ]);
      const view = await admin.view();
      const ctGroup = view.groups.find((g) => g.carrier === "ct");
      assert.equal(ctGroup.hosts[0].currentMs, 31);
      assert.equal(ctGroup.hosts[0].failKind, "loss");
      const cuGroup = view.groups.find((g) => g.carrier === "cu");
      assert.equal(cuGroup.hosts[0].failPct, 100);
      assert.equal(cuGroup.hosts[0].failKind, "tcpFail");
      assert.deepEqual(view.hosts, [{ id: 1, name: "沪A", online: false, country: "CN" }]);
      assert.ok(view.series.length >= 2);

      // 只给管理员
      await assert.rejects(() => probeCarrierRouter.createCaller(ctx(2, "user")).view());
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
