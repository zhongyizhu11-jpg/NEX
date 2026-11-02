import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 逐段测延迟（P1-3）：普通用户借共享主机测「落地」时，落地地址按规则那套受限目标策略查
 * （内网、环回、链路本地、元数据地址不让测；域名先解析，并钉在解析出的地址上），
 * 拨落地的是他自己的主机时照旧；管理员不受限。另外接上「网络测试」开关。
 */
test("逐段测延迟：别人的主机不能拿来测内网落地，接上网络测试开关", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-line-segment-latency-"));
  const databasePath = path.join(directory, "segment.db");
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
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const latency = await import(url("server/lineSegmentLatency.ts"));
    const { lineDiagnosticsRouter } = await import(url("server/routers/lineDiagnostics.ts"));
    const settings = await import(url("server/repositories/settingsRepository.ts"));

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'x', 'user')");
    // 主机 1：管理员的，共享给租户；主机 2：租户自己的。
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'shared', '198.51.100.1', '198.51.100.1', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (2, 'mine', '198.51.100.2', '198.51.100.2', 2)");
    await exec("INSERT INTO user_host_permissions (userId, hostId) VALUES (2, 1)");

    const tenant = { id: 2, role: "user" };
    const admin = { id: 1, role: "admin" };
    const resolver = (map) => async (host) => {
      if (!(host in map)) throw new Error("ENOTFOUND");
      return map[host];
    };

    // 别人的主机拨落地：内网 / 环回 / 元数据地址 / inet_aton 写法都拦。
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "[::1]", "2130706433", "localhost"]) {
      const result = await latency.vetSegmentDest(tenant, { entryHostId: 1, hops: [], dest: { ip, port: 22 } }, resolver({}));
      assert.equal(result.dest, null, ip);
      assert.match(String(result.issue), /不能测/, ip);
    }
    // 中转在前、最后一跳是别人的主机：看的是最后一跳。
    assert.equal((await latency.vetSegmentDest(tenant, { entryHostId: 2, hops: [1], dest: { ip: "10.0.0.5", port: 22 } }, resolver({}))).dest, null);
    // 域名解析到内网：拦；解析到公网：放行，并钉在解析出来的地址上。
    assert.equal((await latency.vetSegmentDest(tenant, { entryHostId: 1, hops: [], dest: { ip: "rebind.example", port: 80 } }, resolver({ "rebind.example": ["203.0.113.5", "192.168.1.1"] }))).dest, null);
    assert.deepEqual(
      (await latency.vetSegmentDest(tenant, { entryHostId: 1, hops: [], dest: { ip: "ok.example", port: 443 } }, resolver({ "ok.example": ["8.8.8.8"] }))).dest,
      { ip: "8.8.8.8", port: 443 },
    );
    const unresolved = await latency.vetSegmentDest(tenant, { entryHostId: 1, hops: [], dest: { ip: "nope.example", port: 443 } }, resolver({}));
    assert.equal(unresolved.dest, null);
    assert.match(String(unresolved.issue), /解析不了/);
    // 公网 IP 照旧。
    assert.deepEqual((await latency.vetSegmentDest(tenant, { entryHostId: 1, hops: [], dest: { ip: "8.8.4.4", port: 53 } }, resolver({}))).dest, { ip: "8.8.4.4", port: 53 });
    // 自己的主机拨落地、或者管理员：照旧（内网落地是正经用法）。
    assert.deepEqual((await latency.vetSegmentDest(tenant, { entryHostId: 1, hops: [2], dest: { ip: "10.0.0.5", port: 22 } }, resolver({}))).dest, { ip: "10.0.0.5", port: 22 });
    assert.deepEqual((await latency.vetSegmentDest(admin, { entryHostId: 1, hops: [], dest: { ip: "127.0.0.1", port: 22 } }, resolver({}))).dest, { ip: "127.0.0.1", port: 22 });

    // 走一遍接口：被拦的落地那一段不建测试、报原因，前面的段照测。
    const context = (user) => ({ user: { ...user, username: "u", accountEnabled: true }, req: { headers: {}, socket: {} }, res: {} });
    const caller = lineDiagnosticsRouter.createCaller(context(tenant));
    const { runId } = await caller.segmentLatencyStart({ entryHostId: 2, hops: [1], dest: { ip: "169.254.169.254", port: 80 } });
    const tests = await query("SELECT hostId, message FROM forward_tests ORDER BY id");
    assert.equal(tests.length, 1, JSON.stringify(tests));
    assert.equal(Number(tests[0].hostId), 2);
    assert.ok(!tests.some((row) => String(row.message).includes("169.254.169.254")));
    const status = await caller.segmentLatencyStatus({ runId });
    const last = status.segments[status.segments.length - 1];
    assert.equal(last.status, "skipped");
    assert.match(String(last.error), /链路本地/);

    // 网络测试开关：关了普通用户就不能测，管理员照旧。
    await settings.setSetting("lookingGlassUserEnabled", "false");
    await assert.rejects(() => caller.segmentLatencyStart({ entryHostId: 2, hops: [], dest: { ip: "8.8.8.8", port: 53 } }), /关闭普通用户使用网络测试/);
    const adminCaller = lineDiagnosticsRouter.createCaller(context(admin));
    assert.ok((await adminCaller.segmentLatencyStart({ entryHostId: 1, hops: [], dest: { ip: "8.8.8.8", port: 53 } })).runId);
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
