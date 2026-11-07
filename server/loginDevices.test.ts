import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyLogin, loginIpPrefix } from "./ops/loginDevices";

test("登录网段：IPv4 /24、IPv6 /48、IPv4 映射地址按 IPv4 算", () => {
  assert.equal(loginIpPrefix("203.0.113.77"), "203.0.113.0/24");
  assert.equal(loginIpPrefix("::ffff:198.51.100.9"), "198.51.100.0/24");
  assert.equal(loginIpPrefix("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(loginIpPrefix("2001:db8::1"), "2001:db8:0::/48");
  assert.equal(loginIpPrefix(""), "unknown");
});

test("判断：认识 / 第一次 / 新网络 / 新设备", () => {
  const known = [{ deviceKey: "iPhone · Safari|203.0.113.0/24", device: "iPhone · Safari", ipPrefix: "203.0.113.0/24", countryCode: "CN" }];
  assert.equal(classifyLogin([], "iPhone · Safari", "203.0.113.0/24", "203.0.113.5").kind, "first");
  assert.equal(classifyLogin(known, "iPhone · Safari", "203.0.113.0/24", "203.0.113.9").kind, "known");
  assert.equal(classifyLogin(known, "iPhone · Safari", "198.51.100.0/24", "198.51.100.1").kind, "new-network");
  assert.equal(classifyLogin(known, "Windows · Chrome", "203.0.113.0/24", "203.0.113.9").kind, "new-device");
});

test("SQLite：登录记一笔，没见过的组合才算新（每人第一条不提醒）", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-login-devices-"));
  const databasePath = path.join(directory, "login-devices.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const devices = await import(url("server/ops/loginDevices.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'alice', 'hash', 'user')");
    const user = { id: 1, username: "alice", role: "user" };
    const req = (ip, ua) => ({ headers: { "user-agent": ua }, ip, socket: { remoteAddress: ip } });
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
    const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

    assert.equal((await devices.noteLoginDevice(user, req("10.0.0.5", iphone), "browser")).kind, "first");
    assert.equal((await devices.noteLoginDevice(user, req("10.0.0.99", iphone), "browser")).kind, "known", "同一段里换 IP 不算新");
    assert.equal((await devices.noteLoginDevice(user, req("10.9.9.9", iphone), "browser")).kind, "new-network");
    assert.equal((await devices.noteLoginDevice(user, req("10.0.0.5", windows), "browser")).kind, "new-device");
    assert.equal((await devices.noteLoginDevice(user, req("10.9.9.10", iphone), "browser")).kind, "known", "记下来之后再来就认识了");

    const rows = await runtime.queryRaw('SELECT "deviceKey", "loginCount" FROM "user_login_devices" WHERE "userId" = 1 ORDER BY "id"', []);
    assert.equal(rows.length, 3);
    assert.equal(Number(rows[0].loginCount), 2);
    assert.equal(Number(rows[1].loginCount), 2);
    console.log("OK");
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
