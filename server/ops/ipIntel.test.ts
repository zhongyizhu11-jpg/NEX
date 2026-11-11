import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { agentIntelSources, ipIntelAddresses, ipIntelFresh, panelIntelProviders, panelIntelRequest, queryIntelFromPanel, setIpIntelFetcherForTest } from "./ipIntel";
import { OPS_TABLE_DEFS } from "./opsTables";
import { isSecretSettingKey } from "../settingsSecretKeys";
import { IP_INTEL_KEY_SETTINGS } from "../../shared/ipIntel";

test("谁去查：新 Agent 查不要 Key 的，面板查注册地和带 Key 的；旧 Agent 全由面板代查", () => {
  const fresh = { agentVersion: "2.2.255" };
  const old = { agentVersion: "2.2.226" };
  assert.deepEqual(panelIntelProviders(fresh, {}), ["ripestat"]);
  assert.deepEqual(agentIntelSources({}).map((item) => item.id), ["ipapi_is", "ipinfo", "proxycheck"]);
  // 配了 ipapi.is 的 Key：改由面板带 Key 查，Agent 不再重复打
  assert.deepEqual(agentIntelSources({ ipapi_is: "k" }).map((item) => item.id), ["ipinfo", "proxycheck"]);
  assert.deepEqual(panelIntelProviders(fresh, { ipapi_is: "k", abuseipdb: "a" }).sort(), ["abuseipdb", "ipapi_is", "ripestat"]);
  assert.deepEqual(panelIntelProviders(old, {}).sort(), ["ipapi_is", "ipinfo", "proxycheck", "ripestat"]);
  // AbuseIPDB 没 Key 就不查
  assert.equal(panelIntelRequest("abuseipdb", "8.8.8.8", {}), null);
  const abuse = panelIntelRequest("abuseipdb", "8.8.8.8", { abuseipdb: "secret-key" });
  assert.equal(abuse?.headers.Key, "secret-key");
  assert.ok(!abuse?.url.includes("secret-key"), "AbuseIPDB 的 Key 放请求头，不进地址");
  assert.equal(panelIntelRequest("ipinfo", "8.8.8.8", { ipinfo: "tok" })?.headers.Authorization, "Bearer tok");
  // Key 都是加密落库的设置项
  for (const key of Object.values(IP_INTEL_KEY_SETTINGS)) assert.ok(isSecretSettingKey(key), `${key} 要加密存`);
  assert.ok(OPS_TABLE_DEFS.some((table) => table.name === "host_ip_intel"));
});

test("查哪个地址：Agent 测到的出口优先；内网 / 保留地址不查", () => {
  assert.deepEqual(ipIntelAddresses({ ipv4: "8.8.4.4", ipv6: "fe80::1" }, { ipv4: { ok: true, address: "8.8.8.8" } as any, ipv6: null }), { 4: "8.8.8.8", 6: null });
  assert.deepEqual(ipIntelAddresses({ ip: "10.0.0.1", ipv6: "2606:4700::1111" }, null), { 4: null, 6: "2606:4700::1111" });
  assert.equal(ipIntelFresh({ ok: true, checkedAt: 1000 }, 1000 + 3600), true);
  assert.equal(ipIntelFresh({ ok: false, checkedAt: 1000 }, 1000 + 3600), false, "失败的半小时后就可以重试");
});

test("面板查一家：限流、非 JSON、网络错误都是「暂不可用（原因）」", async () => {
  try {
    setIpIntelFetcherForTest(async (url) => {
      if (url.includes("proxycheck")) return { status: 429, body: '{"status":"denied","message":"limit"}' };
      if (url.includes("ipinfo")) return { status: 200, body: "<html>blocked</html>" };
      if (url.includes("ipapi")) throw new Error("网络画像 IP 信息查询 超时");
      return { status: 200, body: JSON.stringify({ status: "ok", data: { located_resources: [{ location: "DE" }] } }) };
    });
    const limited = await queryIntelFromPanel("proxycheck", 4, "8.8.8.8", {}, 100);
    assert.equal(limited.ok, false);
    assert.match(limited.reason || "", /限流/);
    const html = await queryIntelFromPanel("ipinfo", 4, "8.8.8.8", {}, 100);
    assert.equal(html.ok, false);
    assert.match(html.reason || "", /JSON/);
    const timeout = await queryIntelFromPanel("ipapi_is", 4, "8.8.8.8", {}, 100);
    assert.equal(timeout.reason, "请求超时");
    const ripe = await queryIntelFromPanel("ripestat", 4, "8.8.8.8", {}, 100);
    assert.equal(ripe.ok && ripe.info?.regCountryCode, "DE");
    assert.equal(ripe.via, "panel");
  } finally {
    setIpIntelFetcherForTest(null);
  }
});

test("落库：Agent 交上来的原始响应、面板补查、指令什么时候带 intel、Key 的状态", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-ipintel-"));
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
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "agentVersion") VALUES (1, ?, ?, ?, ?, ?, 1, ?)', ["新", "8.8.8.8", "8.8.8.8", "slave", "tok1", "2.2.255"]);
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "agentVersion") VALUES (2, ?, ?, ?, ?, ?, 1, ?)', ["旧", "9.9.9.9", "9.9.9.9", "slave", "tok2", "2.2.226"]);
      const intel = await import(url("server/ops/ipIntel.ts"));
      const requested = [];
      intel.setIpIntelFetcherForTest(async (target, headers) => {
        requested.push({ target, headers });
        if (target.includes("stat.ripe.net")) return { status: 200, body: JSON.stringify({ status: "ok", data: { located_resources: [{ location: "US" }] } }) };
        if (target.includes("abuseipdb")) return { status: 200, body: JSON.stringify({ data: { abuseConfidenceScore: 3, countryCode: target.includes("8.8.8.8") ? "JP" : "US", usageType: "Data Center/Web Hosting/Transit" } }) };
        if (target.includes("proxycheck")) return { status: 200, body: JSON.stringify({ status: "ok", "9.9.9.9": { isocode: "US", type: "Business", risk: 10, proxy: "no" } }) };
        return { status: 200, body: JSON.stringify({ ip: "9.9.9.9", location: { country_code: "US" }, asn: { asn: 19281, country: "us" } }) };
      });
      const db = await import(url("server/db.ts"));
      const host1 = await db.getHostById(1);
      const host2 = await db.getHostById(2);

      // 新 Agent：缓存是空的 → 指令里带 intel；旧 Agent 不带
      assert.deepEqual((await intel.agentIntelDirective(host1, false)).map((s) => s.id), ["ipapi_is", "ipinfo", "proxycheck"]);
      assert.deepEqual(await intel.agentIntelDirective(host2, true), []);

      // Agent 交上来：一家成功、一家 429、一家网络错误、一家不认识的
      const saved = await intel.ingestAgentIpIntel(1, [
        { source: "ipapi_is", family: 4, address: "8.8.8.8", status: 200, body: JSON.stringify({ ip: "8.8.8.8", location: { country_code: "JP", city: "Tokyo" }, asn: { asn: 15169, org: "Google LLC", country: "us" }, company: { type: "hosting" }, is_datacenter: true }) },
        { source: "proxycheck", family: 4, address: "8.8.8.8", status: 429, body: "{}" },
        { source: "ipinfo", family: 6, address: "2001:4860:4860::8888", error: "dial tcp6: network is unreachable" },
        { source: "evil", family: 4, status: 200, body: "{}" },
      ], 5000);
      assert.equal(saved, 3);
      // 刚查过 → 下一轮不带 intel；手动重新检测照样带
      intel.resetIpIntelStateForTest();
      intel.setIpIntelFetcherForTest(async (target, headers) => {
        requested.push({ target, headers });
        if (target.includes("stat.ripe.net")) return { status: 200, body: JSON.stringify({ status: "ok", data: { located_resources: [{ location: "US" }] } }) };
        if (target.includes("abuseipdb")) return { status: 200, body: JSON.stringify({ data: { abuseConfidenceScore: 3, countryCode: target.includes("8.8.8.8") ? "JP" : "US", usageType: "Data Center/Web Hosting/Transit" } }) };
        return { status: 200, body: JSON.stringify({ status: "ok", "9.9.9.9": { isocode: "US", type: "Business", risk: 10, proxy: "no" }, ip: "9.9.9.9", location: { country_code: "US" } }) };
      });

      // 配 AbuseIPDB 的 Key：加密落库，状态只给末四位
      await intel.setIpIntelKeys({ abuseipdb: "abcdef123456" });
      const raw = await runtime.queryRaw('SELECT value FROM system_settings WHERE key = ?', ["ops.netProfile.abuseIpdbKey"]);
      assert.ok(raw[0] && !String(raw[0].value).includes("abcdef123456"), "Key 要加密存");
      const status = await intel.ipIntelKeyStatus();
      assert.deepEqual(status.find((item) => item.provider === "abuseipdb"), { provider: "abuseipdb", configured: true, masked: "****3456" });

      // 面板补查：新 Agent 只查 RIPEstat + 带 Key 的 AbuseIPDB
      await intel.refreshHostIpIntelFromPanel(host1, { ipv4: { ok: true, address: "8.8.8.8" }, ipv6: null });
      const hostOneTargets = requested.map((item) => item.target);
      assert.ok(hostOneTargets.some((t) => t.includes("stat.ripe.net") && t.includes("8.8.8.8")));
      assert.ok(hostOneTargets.some((t) => t.includes("api.abuseipdb.com")));
      assert.ok(!hostOneTargets.some((t) => t.includes("proxycheck")), "新 Agent 的 proxycheck 由 Agent 自己查");
      assert.equal(requested.find((item) => item.target.includes("abuseipdb")).headers.Key, "abcdef123456");

      const view = await intel.hostIpIntelView(host1, { ipv4: { ok: true, address: "8.8.8.8" }, ipv6: null });
      const v4 = view.families.find((f) => f.family === 4);
      assert.equal(v4.native.verdict, "broadcast", "使用地 JP、注册地 US");
      assert.equal(v4.basic.asn, "AS15169");
      const byProvider = Object.fromEntries(v4.providers.map((p) => [p.provider, p]));
      assert.equal(byProvider.proxycheck.ok, false);
      assert.match(byProvider.proxycheck.reason, /429/);
      assert.equal(byProvider.abuseipdb.info.riskScore, 3);
      const v6 = view.families.find((f) => f.family === 6);
      assert.match(v6.providers[0].reason, /从主机出口请求失败/);
      assert.deepEqual(view.configuredKeys, ["abuseipdb"]);

      // 缓存还新：再刷一遍不发请求
      const before = requested.length;
      await intel.refreshHostIpIntelFromPanel(host1, { ipv4: { ok: true, address: "8.8.8.8" }, ipv6: null });
      assert.equal(requested.length, before);

      // 旧 Agent：面板代查不要 Key 的几家
      await intel.refreshHostIpIntelFromPanel(host2, null);
      assert.ok(requested.slice(before).some((item) => item.target.includes("proxycheck.io/v2/9.9.9.9")));
      const oldView = await intel.hostIpIntelView(host2, null);
      assert.equal(oldView.agentSupported, false);
      assert.equal(oldView.families[0].native.verdict, "native", JSON.stringify(oldView.families[0]));
      assert.ok(oldView.families[0].providers.every((p) => p.via === "panel"));

      await db.deleteHost(1);
      assert.equal((await intel.listHostIpIntel(1)).length, 0, "删主机时缓存一起删");
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
