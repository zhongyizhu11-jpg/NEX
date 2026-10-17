import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeAsn, parseGeoProviderResponse } from "./hostGeo";

/*
  运营商 / ASN：三家定位服务各自的写法，统一成 geoAsn「AS13335」+ geoIsp + geoOrg。
*/
test("ASN 写法统一成 AS<数字>", () => {
  assert.equal(normalizeAsn("AS13335"), "AS13335");
  assert.equal(normalizeAsn("AS15169 Google LLC"), "AS15169");
  assert.equal(normalizeAsn(4134), "AS4134");
  assert.equal(normalizeAsn("as 9304"), "AS9304");
  assert.equal(normalizeAsn(""), "");
  assert.equal(normalizeAsn(null), "");
  assert.equal(normalizeAsn("Google"), "");
  assert.equal(normalizeAsn(0), "");
});

test("ipapi.co：asn + org", () => {
  const parsed = parseGeoProviderResponse("ipapi.co", {
    ip: "8.8.8.8", country_code: "US", country_name: "United States", region: "California", city: "Mountain View",
    latitude: 37.42, longitude: -122.08, asn: "AS15169", org: "GOOGLE",
  }) as any;
  assert.equal(parsed.geoCountryCode, "US");
  assert.equal(parsed.geoAsn, "AS15169");
  assert.equal(parsed.geoIsp, "GOOGLE");
  assert.equal(parsed.geoOrg, "GOOGLE");
});

test("ip-api.com（免费档只有明文 HTTP）不再是定位服务", () => {
  assert.throws(() => parseGeoProviderResponse("ip-api.com", { status: "success", countryCode: "JP" }), /unknown geo provider/);
});

test("ipwho.is：connection.asn / isp / org", () => {
  const parsed = parseGeoProviderResponse("ipwho.is", {
    success: true, country: "Singapore", country_code: "SG", region: "Singapore", latitude: 1.29, longitude: 103.85,
    flag: { emoji: "🇸🇬" }, connection: { asn: 14061, org: "DigitalOcean, LLC", isp: "Digitalocean", domain: "digitalocean.com" },
  }) as any;
  assert.equal(parsed.geoAsn, "AS14061");
  assert.equal(parsed.geoIsp, "Digitalocean");
  assert.equal(parsed.geoOrg, "DigitalOcean, LLC");
  const noConnection = parseGeoProviderResponse("ipwho.is", { success: true, country_code: "DE", latitude: 50, longitude: 8 }) as any;
  assert.equal(noConnection.geoAsn, "");
  assert.equal(noConnection.geoIsp, null);
});

test("定位时把运营商 / ASN 一起写进主机行；加列之前定位过的主机补上；手动位置只补运营商", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-geo-asn-"));
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
      const now = Math.floor(Date.now() / 1000);
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      const fetched = [];
      globalThis.fetch = async (input) => {
        const host = new URL(String(input)).host;
        fetched.push(String(input));
        if (host !== "ipapi.co") throw new Error("unexpected " + host);
        return { ok: true, status: 200, json: async () => ({ country_code: "US", country_name: "United States", region: "California", latitude: 37.4, longitude: -122.1, asn: "AS15169", org: "GOOGLE" }) };
      };
      const geo = await import(url("server/hostGeo.ts"));
      const db = await import(url("server/db.ts"));

      // 已经定位过（有坐标、不到 7 天）但还没有 ASN：照样要补
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "geoCountryCode", "geoRegion", "geoLatitudeMicro", "geoLongitudeMicro", "geoUpdatedAt") VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
        ["老主机", "8.8.8.8", "8.8.8.8", "slave", "tok1", "US", "California", 37400000, -122100000, now - 60]);
      // 旧缓存行（geoAsn 为 NULL）：当作过期，重新问
      await exec('INSERT INTO ip_geo_cache (address, "resolvedAddress", "geoCountryCode", "geoLatitudeMicro", "geoLongitudeMicro", "fetchedAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        ["8.8.8.8", "8.8.8.8", "US", 1, 1, now - 60, now + 86400]);
      const missing = await db.getHostsMissingGeo();
      assert.deepEqual(missing.map((h) => h.id), [1], "没有 ASN 的主机要进补漏扫描");
      await geo.runHostGeoSweep();
      const row = await db.getHostById(1);
      assert.equal(row.geoAsn, "AS15169");
      assert.equal(row.geoIsp, "GOOGLE");
      assert.equal(row.geoOrg, "GOOGLE");
      assert.equal(fetched.length, 1);
      assert.match(fetched[0], /ipapi\.co\/8\.8\.8\.8/);
      const cache = await runtime.queryRaw('SELECT "geoAsn", "geoIsp" FROM ip_geo_cache WHERE address = ?', ["8.8.8.8"]);
      assert.equal(cache[0].geoAsn, "AS15169", "缓存行也带上 ASN");
      assert.deepEqual((await db.getHostsMissingGeo()).map((h) => h.id), [], "补上之后不再进扫描");

      // 手动位置：地区那几列不动，运营商照写
      geo.resetHostGeoStateForTests();
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "geoManual", "geoCountryCode", "geoRegion", "geoLatitudeMicro", "geoLongitudeMicro", "geoUpdatedAt") VALUES (2, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)',
        ["手动", "8.8.4.4", "8.8.4.4", "slave", "tok2", "HK", "香港", 22319300, 114169400, now]);
      geo.scheduleHostGeoRefresh([await db.getHostById(2)]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const manual = await db.getHostById(2);
      assert.equal(manual.geoCountryCode, "HK", "手动指定的地区不覆盖");
      assert.equal(manual.geoRegion, "香港");
      assert.equal(manual.geoAsn, "AS15169");

      // 换了 IP：ASN 跟着清掉，等重新定位
      await db.applyAgentReportedHostAddress(1, { ip: "1.1.1.1", ipv4: "1.1.1.1", ipv6: null });
      const moved = await db.getHostById(1);
      assert.equal(moved.geoAsn, null);
      assert.equal(moved.geoIsp, null);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "geo.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
