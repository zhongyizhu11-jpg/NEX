import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主机地区：只有自动定位。
 *
 * 手动指定位置那一套（选城市、自定义经纬度、重新定位）用户不要，去掉了；以前
 * 手动设过的主机在补漏扫描第一次跑时交回自动定位。自动定位回到以前的规则：
 * 定位服务只要答出国家/地区就显示，没坐标按国家补一个近似点 —— 2.3.39x 把
 * 「没坐标」当成失败，有些机器就从「有地区」变成了「未定位」。
 * 整条链路放在真 sqlite 上过一遍。
 */

type Probe = {
  manualReset: { manual: boolean; country: string | null; sweepAttempted: number; region: string | null };
  countryOnly: { country: string | null; region: string | null; lat: number | null; lng: number | null; retryAttempts: number };
  countryOnlyUnknown: { country: string | null; lat: number | null };
  fallback: {
    first: { provider: string | null; country: string; region: string | null; hosts: string[] };
    statesAfterFirst: Record<string, boolean>;
    second: { provider: string | null; hosts: string[] };
    third: { provider: string | null; hosts: string[] };
  };
  backoff: { attemptsAfterFail: number; delayMinutes: number; secondDelayMinutes: number };
  privateLookup: { hosts: string[]; region: string | null };
  listRow: { detectedPrivateIpv4: string | null; hasGeoSource: boolean };
};

function runProbe(): Probe {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-geo-auto-"));
  const databasePath = path.join(directory, "geo.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const out = {};
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");

    const fetchLog = [];
    let plan = {};
    globalThis.fetch = async (input) => {
      const host = new URL(String(input)).host;
      fetchLog.push(host);
      const step = plan[host];
      if (!step) throw new Error("unexpected fetch " + host);
      return typeof step === "function" ? step(String(input)) : step;
    };
    const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

    const geo = await import(url("server/hostGeo.ts"));
    const db = await import(url("server/db.ts"));
    const hostsModule = await import(url("server/routers/hosts.ts"));
    const privateAddress = await import(url("server/agentPrivateAddress.ts"));
    const caller = (user) => hostsModule.hostsRouter.createCaller({ user, req: { headers: {} }, res: { setHeader: () => {} } });
    const admin = { id: 1, role: "admin", username: "admin" };

    // ---- 以前手动设过位置的主机：第一次补漏扫描清掉标记，交回自动定位 ----
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "geoManual", "geoCountryCode", "geoRegion", "geoLatitudeMicro", "geoLongitudeMicro", "geoUpdatedAt") VALUES (1, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)',
      ["手动过", "8.8.8.8", "8.8.8.8", "slave", "tok1", "HK", "香港", 22319300, 114169400, now],
    );
    plan = { "ipapi.co": jsonResponse(200, { country_code: "US", country_name: "United States", region: "California", latitude: 37.4, longitude: -122.1 }) };
    const sweep = await geo.runHostGeoSweep();
    const resetRow = await db.getHostById(1);
    out.manualReset = { manual: !!resetRow?.geoManual, country: resetRow?.geoCountryCode ?? null, sweepAttempted: sweep.attempted, region: resetRow?.geoRegion ?? null };

    // ---- 只答得出国家：照样显示地区，坐标按国家补近似点 ----
    geo.resetHostGeoStateForTests();
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv6, "hostType", "agentToken", "userId") VALUES (2, ?, ?, ?, ?, ?, 1)',
      ["只有国家", "2400:8902::1", "2400:8902::1", "slave", "tok2"],
    );
    plan = {
      "ipapi.co": jsonResponse(200, { country_code: "JP", country_name: "Japan", region: "Tokyo" }),
      "ipwho.is": jsonResponse(200, { success: false, message: "Invalid IP address" }),
    };
    await geo.runHostGeoSweep();
    const countryOnlyRow = await db.getHostById(2);
    out.countryOnly = {
      country: countryOnlyRow?.geoCountryCode ?? null,
      region: countryOnlyRow?.geoRegion ?? null,
      lat: countryOnlyRow?.geoLatitudeMicro ?? null,
      lng: countryOnlyRow?.geoLongitudeMicro ?? null,
      retryAttempts: geo.getHostGeoRetryState(2)?.attempts ?? 0,
    };

    // 城市表里没有的国家：地区照写，坐标留空
    geo.resetHostGeoStateForTests();
    plan = {
      "ipapi.co": jsonResponse(200, { country_code: "AQ", country_name: "Antarctica" }),
      "ipwho.is": jsonResponse(200, { success: false, message: "Invalid IP address" }),
    };
    const unknown = await geo.lookupAddressGeo("2400:8902::99");
    out.countryOnlyUnknown = { country: unknown?.geoCountryCode ?? null, lat: unknown?.geoLatitudeMicro ?? null };

    // ---- 两家兜底（都是 HTTPS）：ipapi.co 429 → ipwho.is ----
    geo.resetHostGeoStateForTests();
    fetchLog.length = 0;
    plan = {
      "ipapi.co": jsonResponse(429, {}),
      "ipwho.is": jsonResponse(200, { success: true, country: "United States", country_code: "US", region: "California", city: "Los Angeles", latitude: 34.05, longitude: -118.24 }),
    };
    const first = await geo.lookupAddressGeo("1.0.0.1");
    const statesAfterFirst = Object.fromEntries(geo.getGeoProviderStates().map((state) => [state.name, state.rateLimitedUntil > Date.now()]));
    const firstHosts = fetchLog.slice();
    fetchLog.length = 0;
    plan = {
      "ipwho.is": jsonResponse(200, { success: true, country: "Japan", country_code: "JP", region: "Tokyo", city: "Tokyo", latitude: 35.68, longitude: 139.69, flag: { emoji: "🇯🇵" } }),
    };
    const second = await geo.lookupAddressGeo("9.9.9.9");
    const secondHosts = fetchLog.slice();
    fetchLog.length = 0;
    plan = { "ipwho.is": jsonResponse(200, { success: false, message: "Invalid IP address" }) };
    const third = await geo.lookupAddressGeo("4.2.2.2");
    out.fallback = {
      first: { provider: first?.provider ?? null, country: first?.geoCountryCode ?? "", region: first?.geoRegion ?? null, hosts: firstHosts },
      statesAfterFirst,
      second: { provider: second?.provider ?? null, hosts: secondHosts },
      third: { provider: third?.provider ?? null, hosts: fetchLog.slice() },
    };

    // ---- 退避 ----
    geo.resetHostGeoStateForTests();
    await exec('UPDATE hosts SET "geoUpdatedAt" = ? WHERE id IN (1, 2)', [now]);
    await exec('UPDATE hosts SET "geoLatitudeMicro" = 1, "geoLongitudeMicro" = 1 WHERE id IN (1, 2)');
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId") VALUES (3, ?, ?, ?, ?, ?, 1)',
      ["查不到", "208.67.222.222", "208.67.222.222", "slave", "tok3"],
    );
    plan = { "ipapi.co": jsonResponse(500, {}), "ipwho.is": jsonResponse(500, {}) };
    await geo.runHostGeoSweep();
    const retry1 = geo.getHostGeoRetryState(3);
    const firstDelayMinutes = Math.round((retry1.notBefore - Date.now()) / 60000);
    const sweepDuringBackoff = await geo.runHostGeoSweep();
    retry1.notBefore = Date.now() - 1;
    await geo.runHostGeoSweep();
    const retry2 = geo.getHostGeoRetryState(3);
    out.backoff = {
      attemptsAfterFail: retry1?.attempts ?? 0,
      delayMinutes: sweepDuringBackoff.attempted === 0 ? firstDelayMinutes : -1,
      secondDelayMinutes: Math.round((retry2.notBefore - Date.now()) / 60000),
    };

    // ---- 上报的是内网地址：跳过它，拿下一个公网地址去查 ----
    geo.resetHostGeoStateForTests();
    await exec('DELETE FROM hosts WHERE id = 3');
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, ipv6, "hostType", "agentToken", "userId") VALUES (4, ?, ?, ?, ?, ?, ?, 1)',
      ["NAT 机", "10.0.0.8", "10.0.0.8", "2a01:4f8::1", "slave", "tok4"],
    );
    fetchLog.length = 0;
    plan = { "ipapi.co": (target) => jsonResponse(200, target.includes("2a01") ? { country_code: "DE", country_name: "Germany", region: "Bavaria", latitude: 49.4, longitude: 11.1 } : { error: true, reason: "Reserved IP Address" }) };
    await geo.runHostGeoSweep();
    const natRow = await db.getHostById(4);
    out.privateLookup = { hosts: fetchLog.slice(), region: natRow?.geoRegion ?? null };

    // ---- 列表行带上 Agent 报的内网 IPv4，不再有 geoSource ----
    privateAddress.noteAgentPrivateIpv4(4, "10.0.0.8");
    const row = (await caller(admin).list()).find((item) => Number(item.id) === 4);
    out.listRow = { detectedPrivateIpv4: row?.detectedPrivateIpv4 ?? null, hasGeoSource: !!row && "geoSource" in row };

    console.log("GEOPROBE " + JSON.stringify(out));
    await runtime.closeDatabase().catch(() => undefined);
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    timeout: 180_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("GEOPROBE "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("GEOPROBE ".length)) as Probe;
}

const probe = runProbe();

test("以前手动设过位置的主机交回自动定位", () => {
  assert.equal(probe.manualReset.manual, false);
  assert.equal(probe.manualReset.sweepAttempted, 1, "清掉之后同一轮补漏就按 IP 查");
  assert.equal(probe.manualReset.country, "US");
  assert.equal(probe.manualReset.region, "California");
});

test("定位服务只答出国家：地区照样显示，坐标按国家补近似点", () => {
  assert.equal(probe.countryOnly.country, "JP");
  assert.equal(probe.countryOnly.region, "Tokyo");
  assert.equal(probe.countryOnly.lat, 35676200, "地区名对得上城市表就用那座城市");
  assert.equal(probe.countryOnly.lng, 139650300);
  assert.equal(probe.countryOnly.retryAttempts, 0, "有了近似坐标就算定到位，不再退避重查");
  assert.equal(probe.countryOnlyUnknown.country, "AQ", "城市表里没有的国家，地区也要留着");
  assert.equal(probe.countryOnlyUnknown.lat, null);
});

test("两家 HTTPS 服务按顺序兜底，限流状态各记各的", () => {
  assert.deepEqual(probe.fallback.first.hosts, ["ipapi.co", "ipwho.is"]);
  assert.equal(probe.fallback.first.provider, "ipwho.is");
  assert.equal(probe.fallback.first.country, "US");
  assert.equal(probe.fallback.first.region, "California");
  assert.deepEqual(probe.fallback.statesAfterFirst, { "ipapi.co": true, "ipwho.is": false });
  assert.deepEqual(probe.fallback.second.hosts, ["ipwho.is"], "限流中的那家不再打");
  assert.equal(probe.fallback.second.provider, "ipwho.is");
  assert.deepEqual(probe.fallback.third.hosts, ["ipwho.is"]);
  assert.equal(probe.fallback.third.provider, null, "全失败返回 null，不抛");
});

test("查不到的主机按指数退避重试", () => {
  assert.equal(probe.backoff.attemptsAfterFail, 1);
  assert.equal(probe.backoff.delayMinutes, 10);
  assert.equal(probe.backoff.secondDelayMinutes, 20);
});

test("上报的 IPv4 是内网地址时，拿公网 IPv6 去查", () => {
  assert.deepEqual(probe.privateLookup.hosts, ["ipapi.co"]);
  assert.equal(probe.privateLookup.region, "Bavaria");
});

test("主机列表带上 Agent 检测到的内网 IPv4", () => {
  assert.equal(probe.listRow.detectedPrivateIpv4, "10.0.0.8");
  assert.equal(probe.listRow.hasGeoSource, false);
});
