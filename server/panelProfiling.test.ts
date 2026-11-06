import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 面板性能剖析（server/panelProfiling.ts + server/panelProfilingRoute.ts）：
 * 默认关着；开了以后采得到 CPU 剖析和堆快照；下载只给网页上的管理员，关掉以后连文件一起没了。
 * 在子进程里跑：要连一个临时 SQLite，堆快照拍的也是子进程自己。
 */
test("性能剖析：默认关、只给管理员下载、关掉就删、文件能被 DevTools 读", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-profiling-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const profiling = await import(url("server/panelProfiling.ts"));
    const { panelProfilingRouter } = await import(url("server/panelProfilingRoute.ts"));
    const express = (await import("express")).default;

    // 默认关：什么都采不了。
    assert.equal((await profiling.getPanelProfilingStatus()).enabledUntil, 0);
    await assert.rejects(() => profiling.startPanelCpuProfile(1), /没有开启/);
    await assert.rejects(() => profiling.takePanelHeapSnapshot(), /没有开启/);

    const until = await profiling.setPanelProfilingEnabled(true);
    assert.ok(until > Date.now() + 59 * 60_000 && until <= Date.now() + 60 * 60_000, "开一次管一小时");

    const cpu = await profiling.startPanelCpuProfile(1);
    assert.equal(cpu.status, "running");
    await assert.rejects(() => profiling.takePanelHeapSnapshot(), /CPU 剖析/, "同一时间只采一份");
    // 采的这一秒里让它有点事做。
    const end = Date.now() + 1500;
    let spin = 0;
    while (Date.now() < end) { spin += Math.sqrt(spin + 1); await new Promise((r) => setImmediate(r)); }
    let status = await profiling.getPanelProfilingStatus();
    for (let i = 0; i < 50 && status.captures.find((c) => c.id === cpu.id)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await profiling.getPanelProfilingStatus();
    }
    const cpuDone = status.captures.find((c) => c.id === cpu.id);
    assert.equal(cpuDone.status, "ready", JSON.stringify(cpuDone));
    assert.ok(cpuDone.bytes > 100);
    assert.match(cpuDone.filename, /^nex-panel-\d{8}-\d{6}\.cpuprofile$/);
    assert.equal("file" in cpuDone, false, "状态里不带服务器上的路径");

    const heap = await profiling.takePanelHeapSnapshot();
    assert.equal(heap.kind, "heap");
    for (let i = 0; i < 100 && (await profiling.getPanelProfilingStatus()).busy; i++) await new Promise((r) => setTimeout(r, 100));
    const heapDone = (await profiling.getPanelProfilingStatus()).captures.find((c) => c.id === heap.id);
    assert.equal(heapDone.status, "ready", JSON.stringify(heapDone));

    // 下载：没登录的、不是管理员的都不给。
    const serve = async () => {
      const app = express();
      app.use(panelProfilingRouter);
      const server = http.createServer(app);
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return server;
    };
    const fetchRaw = (server, id, headers = {}) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/ops/profiling/" + id + "/download", headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
    const anonymous = await serve();
    try {
      assert.equal((await fetchRaw(anonymous, cpu.id)).status, 403, "没登录不给");
      assert.equal((await fetchRaw(anonymous, "zz")).status, 404);
    } finally {
      anonymous.close();
    }

    // 开发面板模式下请求就是开发管理员：拿它测管理员这条路。
    process.env.FORWARDX_DEV_PANEL = "1";
    await runtime.executeRaw("INSERT INTO users (id, username, password, role, accountEnabled) VALUES (1, 'dev.admin@forwardx.local', 'x', 'admin', 1)");
    const admin = await serve();
    try {
      const got = await fetchRaw(admin, cpu.id);
      assert.equal(got.status, 200);
      assert.match(String(got.headers["content-disposition"]), /attachment; filename="nex-panel-.*\.cpuprofile"/);
      assert.equal(got.headers["cache-control"], "no-store, no-transform");
      const profile = JSON.parse(got.body.toString("utf8"));
      assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0 && Array.isArray(profile.samples), "Chrome DevTools 认的 .cpuprofile 结构");
      const heapGot = await fetchRaw(admin, heap.id);
      assert.equal(heapGot.status, 200);
      assert.ok(heapGot.body.subarray(0, 64).toString("utf8").startsWith('{"snapshot":{'), "V8 的 .heapsnapshot");
      assert.equal(Number(heapGot.headers["content-length"]), heapGot.body.length);
      assert.equal((await fetchRaw(admin, "0".repeat(24))).status, 404);

      // 关掉：文件一并删掉，下载也不给了。
      await profiling.setPanelProfilingEnabled(false);
      assert.equal((await profiling.getPanelProfilingStatus()).captures.length, 0);
      assert.equal((await fetchRaw(admin, cpu.id)).status, 403);
    } finally {
      admin.close();
    }
    profiling.resetPanelProfilingForTests();
    console.log("RESULT ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "profiling.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), NODE_ENV: "test" },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /RESULT ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
