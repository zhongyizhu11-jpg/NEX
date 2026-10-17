import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";

/**
 * 归属地查询的隐私边界：
 * - 「在线 IP」里看到的是终端用户的 IP：只查面板自带的离线库（ip2region，带 sha256 校验），
 *   一个都不发给第三方；离线库缺了或被改过就显示「未知」，也不退回在线查询。
 * - 面板自己的主机 / 规则目标仍可以在线查，但只走 HTTPS（ip-api.com 免费档只有明文 HTTP，去掉）。
 */
function runScript(body: string, env: Record<string, string> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ip-geo-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const requests = [];
      globalThis.fetch = async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ error: true, reason: "test" }), { status: 500 });
      };
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const waitFor = async (check, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = check();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return check();
      };
      ${body}
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FORWARDX_LOG_DIR: path.join(directory, "logs"), FORWARDX_TEST_TMP: directory, ...env },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
    return result;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("在线 IP 的归属地只查离线库，不把终端用户的 IP 发给任何第三方", () => {
  runScript(String.raw`
    const online = await import(url("server/ops/onlineIps.ts"));
    online.queueIpGeo(["8.8.8.8", "114.114.114.114", "2001:4860:4860::8888"]);
    const labels = await waitFor(() => {
      const values = ["8.8.8.8", "114.114.114.114", "2001:4860:4860::8888"].map((ip) => online.ipRegionLabel(ip));
      return values.every(Boolean) ? values : null;
    });
    assert.deepEqual(requests, [], "不能发出任何网络请求：" + requests.join(", "));
    assert.ok(labels, "离线库应该查得到这几个公网地址");
    assert.match(labels[0], /美国|US/);
    assert.match(labels[1], /中国|CN/);
    assert.match(labels[2], /美国|US/);
    assert.equal(online.ipRegionLabel("10.0.0.8"), "内网");
  `);
});

test("离线库对不上 sha256 就不用，显示未知，也不退回在线查询", () => {
  const tampered = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ip2region-bad-"));
  try {
    const original = path.join(process.cwd(), "server/assets/ip2region");
    fs.copyFileSync(path.join(original, "ip2region_v6.xdb.gz"), path.join(tampered, "ip2region_v6.xdb.gz"));
    // 同样大小的 v4 库，改掉一个字节。
    const real = fs.readFileSync(path.join(original, "ip2region_v4.xdb.gz"));
    const raw = gunzipSync(real);
    raw[raw.length - 1] ^= 0xff;
    fs.writeFileSync(path.join(tampered, "ip2region_v4.xdb.gz"), gzipSync(raw));
    runScript(String.raw`
      const offline = await import(url("server/ipRegionOffline.ts"));
      assert.equal(await offline.lookupOfflineIpRegion("8.8.8.8"), null, "校验不过就当查不到");
      assert.ok(await offline.lookupOfflineIpRegion("2001:4860:4860::8888"), "另一份没坏的库照常用");
      const online = await import(url("server/ops/onlineIps.ts"));
      online.queueIpGeo(["1.1.1.1"]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(online.ipRegionLabel("1.1.1.1"), null);
      assert.deepEqual(requests, []);
    `, { FORWARDX_IP2REGION_DIR: tampered });
  } finally {
    fs.rmSync(tampered, { recursive: true, force: true });
  }
});

test("离线库：公网才查，内网 / 保留地址 / 乱写的直接 null；IPv4 映射的 IPv6 按 IPv4 查", () => {
  runScript(String.raw`
    const offline = await import(url("server/ipRegionOffline.ts"));
    for (const ip of ["10.1.2.3", "192.168.1.1", "127.0.0.1", "100.64.0.1", "198.51.100.7", "::1", "fe80::1", "2001:db8::1", "not-an-ip", ""]) {
      assert.equal(await offline.lookupOfflineIpRegion(ip), null, ip);
    }
    const google = await offline.lookupOfflineIpRegion("8.8.8.8");
    assert.equal(google.countryCode, "US");
    const mapped = await offline.lookupOfflineIpRegion("::ffff:8.8.8.8");
    assert.deepEqual(mapped, google);
    const cn = await offline.lookupOfflineIpRegion("114.114.114.114");
    assert.equal(cn.countryCode, "CN");
    const v6 = await offline.lookupOfflineIpRegion("2001:4860:4860:0:0:0:0:8888");
    assert.equal(v6.countryCode, "US");
    assert.deepEqual(requests, []);
  `);
});

test("主机 / 规则目标的在线归属地查询只走 HTTPS", () => {
  runScript(String.raw`
    const hostGeo = await import(url("server/hostGeo.ts"));
    hostGeo.resetHostGeoStateForTests();
    await assert.rejects(() => hostGeo.fetchHostGeo("1.1.1.1"));
    assert.ok(requests.length > 0, "主机定位仍然在线查");
    for (const request of requests) assert.match(request, /^https:\/\//, "明文 HTTP：" + request);
  `);
});
