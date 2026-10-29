import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 落地选择器的清单（server/landingOptions.ts）：规则出口和节点分流共用的那一份。
 *   - 权限是规则出口那一套：管理员全看；普通用户看自己的主机 + 授权的主机，上面自己的 SS 入站或管理员开放的落地出口；
 *   - 只列 Shadowsocks；方法不支持做出口的照样列、带 methodError；
 *   - 每个入站带所在主机最新一次解锁检测各服务的结论；
 *   - 旧接口 listEgressLandingOptions 照旧（hostName / online，不带解锁）。
 */
test("落地选择器清单：按主机分组、按权限过滤、带最新解锁结论", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-landing-options-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    console.info = () => {};
    console.warn = () => {};
    const landing = await import(url("server/landingOptions.ts"));
    const egress = await import(url("server/ssEgress.ts"));
    const unlock = await import(url("server/ops/unlock.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const now = new Date();
    // bob 没有订阅权限：清单不要求它。
    await exec("INSERT INTO users (id, username, password, role, \"allowProxySubscription\") VALUES (1, 'admin', 'x', 'admin', 1), (2, 'bob', 'x', 'user', 0)");
    await exec('INSERT INTO hosts (id, name, ip, "userId", "isOnline", "lastHeartbeat") VALUES (1, ?, ?, 1, 1, ?), (2, ?, ?, 1, 1, ?), (3, ?, ?, 2, 1, ?), (4, ?, ?, 1, 0, NULL)',
      ["入口", "198.51.100.1", now, "美西", "198.51.100.2", now, "bob 的机器", "198.51.100.3", now, "日本", "198.51.100.4"]);
    await exec('INSERT INTO user_host_permissions ("userId", "hostId") VALUES (2, 4)');
    const inbound = (id, hostId, userId, extra = {}) => exec(
      'INSERT INTO proxy_inbounds (id, "userId", "hostId", name, protocol, port, transport, security, method, password, "landingEgress", "isEnabled") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, userId, hostId, extra.name || ("ss-" + id), extra.protocol || "shadowsocks", 20000 + id, "tcp", "none", extra.method || "aes-256-gcm", "pw" + id, extra.landingEgress ? 1 : 0, extra.enabled === false ? 0 : 1],
    );
    await inbound(1, 1, 1, { name: "入口上的" });
    await inbound(2, 2, 1, { name: "美西出口" });
    await inbound(3, 2, 1, { name: "美西老方法", method: "rc4-md5" });
    await inbound(4, 3, 2, { name: "bob 自己的" });
    await inbound(5, 4, 1, { name: "日本开放出口", landingEgress: true });
    await inbound(6, 4, 1, { name: "日本私有" });
    await inbound(7, 4, 1, { name: "日本 vless", protocol: "vless" });
    await inbound(8, 2, 1, { name: "美西停用", enabled: false });
    const result = (status) => [{ service: "netflix", status, region: "US", detail: "", ms: 1 }];
    await unlock.recordUnlockRun({ hostId: 4, family: "auto", runId: "a", trigger: "manual", requestedBy: 1, checkedAt: 1000, results: result("blocked") });
    await unlock.recordUnlockRun({ hostId: 4, family: "auto", runId: "b", trigger: "manual", requestedBy: 1, checkedAt: 2000, results: result("ok") });

    // 管理员：四台主机都在，有入站的排前面；vless 不列；方法不支持的照列、带原因
    const admin = await landing.listLandingOptions({ id: 1, role: "admin" });
    assert.deepEqual(admin.map((host) => host.hostId).sort(), [1, 2, 3, 4]);
    const west = admin.find((host) => host.hostId === 2);
    assert.deepEqual(west.inbounds.map((row) => row.id), [2, 3, 8]);
    assert.equal(west.isOnline, true);
    assert.equal(west.canCreateInbound, true);
    assert.equal(west.inbounds[0].methodError, null);
    assert.match(west.inbounds[1].methodError, /rc4-md5|不支持/);
    assert.equal(west.inbounds[2].isEnabled, false);
    assert.deepEqual(west.inbounds[0].unlock, {}, "没测过：空对象");
    assert.equal(west.inbounds[0].unlockCheckedAt, 0);
    const japan = admin.find((host) => host.hostId === 4);
    assert.equal(japan.isOnline, false);
    assert.deepEqual(japan.inbounds.map((row) => row.id), [5, 6], "vless 不在清单里");
    assert.deepEqual(japan.inbounds[0].unlock, { netflix: "ok" }, "取最新一次检测");
    assert.equal(japan.inbounds[0].unlockCheckedAt, 2000);
    assert.equal(japan.inbounds[0].landingEgress, true);

    // bob：自己的机器 + 授权的日本；日本上只有开放的落地出口；不要求订阅权限
    const bob = await landing.listLandingOptions({ id: 2, role: "user" });
    assert.deepEqual(bob.map((host) => host.hostId).sort(), [3, 4]);
    const bobJapan = bob.find((host) => host.hostId === 4);
    assert.deepEqual(bobJapan.inbounds.map((row) => row.id), [5]);
    assert.equal(bobJapan.canCreateInbound, false, "不是自己的机器不能一键创建");
    assert.equal(bobJapan.ownHost, false);
    const bobOwn = bob.find((host) => host.hostId === 3);
    assert.deepEqual(bobOwn.inbounds.map((row) => row.id), [4]);
    assert.equal(bobOwn.canCreateInbound, true);

    // 旧接口：同样的内容、旧的字段名
    const legacy = await egress.listEgressLandingOptions({ id: 2, role: "user" });
    assert.deepEqual(legacy.map((host) => [host.hostId, host.hostName, host.online]).sort(), [[3, "bob 的机器", true], [4, "日本", false]]);
    assert.deepEqual(Object.keys(legacy.find((host) => host.hostId === 4).inbounds[0]).sort(), ["id", "isEnabled", "landingEgress", "method", "methodError", "name", "port"]);
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "landing.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
