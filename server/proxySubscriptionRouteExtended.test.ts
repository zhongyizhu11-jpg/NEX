import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 升级后的订阅路由：作用域、短链、令牌到期、显式格式路径、/info、落地页、限流、设备限制、
 * 信息节点、模板开头部分、Xray JSON、自定义规则、客户端版本门控。
 *
 * 和 proxySubscriptionRoute.test.ts 一样起一个真 SQLite 跑整条路由 —— 这些东西每一样都是
 * 「数据库里一列 + 路由里一段判断」，只测纯函数测不出接没接上。
 */
test("订阅路由的新能力", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-ext-"));
  const databasePath = path.join(directory, "sub-ext.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const route = await import(url("server/proxySubscriptionRoute.ts"));
    const proxyNode = await import(url("shared/proxyNode.ts"));
    const settingsRepo = await import(url("server/repositories/settingsRepository.ts"));
    const subSettings = await import(url("server/proxySubSettings.ts"));
    const cache = await import(url("server/proxySubCache.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, trafficUsed, trafficLimit, allowProxySubscription) VALUES (1, 'owner', 'hash', 'user', 1073741824, 10737418240, 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId, geoCountryCode) VALUES (1, '广州', '1.2.3.4', '1.2.3.4', 1, 'CN')");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId, geoCountryCode) VALUES (2, '上海', '5.6.7.8', '5.6.7.8', 1, 'CN')");
    // 两个落地模板：香港 VLESS、日本 Hysteria2（手填地区）。
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, sni, isEnabled, countryCode) VALUES (1, 1, 'HKT', 'vless', 'hkt.example.com', 443, 'uuid-hk', 'tcp', 1, 'hkt.example.com', 1, 'HK')");
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, password, transport, tls, sni, isEnabled, countryCode) VALUES (2, 1, 'Tokyo', 'hysteria2', 'jp.example.com', 443, 'pw', 'tcp', 1, 'jp.example.com', 1, 'JP')");
    const insertRule = (id, hostId, name, port, nodeId, protocol) => exec(
      "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (?, ?, ?, 'realm', ?, ?, 'x.example.com', 443, 1, 1, 1, 0, ?, 1)",
      [id, hostId, name, protocol, port, nodeId],
    );
    await insertRule(1, 1, '广州转HKT', 20001, 1, 'tcp');
    await insertRule(2, 2, '上海转Tokyo', 20002, 2, 'both');

    const expired = Math.floor(Date.now() / 1000) - 60;
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, rulePreset, isEnabled, alias) VALUES (1, 1, '手机', 'tok-all', 'base64', 'balanced', 1, 'my-phone')");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, rulePreset, isEnabled, scopeJson, optionsJson) VALUES (2, 1, '只要香港', 'tok-hk', 'base64', 'balanced', 1, ?, ?)",
      [JSON.stringify({ regions: ["HK"] }), JSON.stringify({ flagEmoji: "on", nameTemplate: "{flag}{country} · {node}", infoNodes: "on", regionGroups: "on", customRules: "DOMAIN-SUFFIX,bilibili.com,DIRECT" })]);
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled, expiresAt) VALUES (3, 1, '过期的', 'tok-expired', 'base64', 1, ?)", [expired]);

    const app = express();
    app.set("trust proxy", true);
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const get = (pathname, headers = {}) => new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
      });
      request.on("error", reject);
      request.end();
    });
    const links = (body) => proxyNode.decodeBase64Utf8(body).split("\n").filter(Boolean);

    // 全量令牌：两个节点。
    const all = await get("/api/sub/tok-all");
    assert.equal(all.status, 200);
    assert.equal(links(all.body).length, 2, all.body);
    assert.equal(all.headers["profile-update-interval"], "12");
    assert.ok(all.headers["profile-web-page-url"], "要有落地页地址头");

    // 短链和长地址内容一样。
    const alias = await get("/s/my-phone");
    assert.equal(alias.status, 200);
    assert.equal(alias.body, all.body);
    assert.equal((await get("/s/nope")).status, 404);

    // 作用域：只要香港 → 只剩 1 个节点；命名模板 + 旗帜 + 信息节点。
    const hk = await get("/api/sub/tok-hk?format=clash");
    assert.equal(hk.status, 200);
    assert.ok(hk.body.includes('name: "🇭🇰香港 · HKT"'), hk.body);
    assert.ok(!hk.body.includes("Tokyo"), "日本的不该进只要香港的地址");
    assert.ok(hk.body.includes("📊 剩余 9"), "信息节点要显示剩余流量：" + hk.body.slice(0, 400));
    assert.ok(hk.body.includes("到期") || hk.body.includes("长期有效"), hk.body.slice(0, 400));
    // 地区组：只有香港一个节点，照样建「🇭🇰 香港」组。
    assert.ok(hk.body.includes('name: "🇭🇰 香港"'), hk.body);
    // 信息节点不进策略组。
    const groupLine = hk.body.split("\n").find((line) => line.includes('"NEX"') && line.includes("proxies:")) || "";
    assert.ok(!hk.body.includes("📊") || !groupLine.includes("📊"), "信息节点不该在主选择器里");

    // 规则订阅：自定义规则在预设规则前面；模板开头部分（内置）带 mixed-port。
    const hkRules = await get("/api/sub/tok-hk?format=clash&rules=1");
    assert.ok(hkRules.body.includes("DOMAIN-SUFFIX,bilibili.com,DIRECT"), hkRules.body);
    assert.ok(hkRules.body.indexOf("DOMAIN-SUFFIX,bilibili.com") < hkRules.body.indexOf("RULE-SET,"), "自定义规则要排在预设规则前");
    assert.ok(hkRules.body.includes("mixed-port: 7890"), "规则订阅要带模板的开头部分");
    assert.ok(hkRules.body.indexOf("mixed-port") < hkRules.body.indexOf("proxies:"), "开头部分要在 proxies 前面");
    // 节点订阅不带开头部分（保持原样）。
    assert.ok(!hk.body.includes("mixed-port"), "节点订阅不该带模板开头");

    // 显式格式路径。
    const explicit = await get("/api/sub/tok-all/singbox");
    assert.equal(explicit.headers["content-type"].includes("json"), true);
    assert.equal(JSON.parse(explicit.body).outbounds[0].type, "selector");
    const xray = await get("/api/sub/tok-all/v2ray-json");
    const configs = JSON.parse(xray.body);
    assert.ok(Array.isArray(configs));
    // Xray 内核没有 Hysteria2：只剩 VLESS 那一份。
    assert.equal(configs.length, 1, xray.body.slice(0, 200));
    assert.equal(configs[0].outbounds[0].protocol, "vless");
    assert.equal(configs[0].outbounds[0].settings.vnext[0].address, "1.2.3.4");
    assert.equal((await get("/api/sub/tok-all/nonsense")).status, 404);

    // UA 版本门控：老版本 v2rayNG 拿 base64 且没有 Hysteria2；新版本拿 Xray JSON。
    const oldNg = await get("/api/sub/tok-all", { "user-agent": "v2rayNG/1.8.20" });
    assert.equal(oldNg.headers["content-type"].includes("text/plain"), true, oldNg.headers["content-type"]);
    assert.equal(links(oldNg.body).length, 1, "v2rayNG 1.8.20 不支持 Hysteria2，该跳过：" + oldNg.body);
    const newNg = await get("/api/sub/tok-all", { "user-agent": "v2rayNG/1.9.6" });
    assert.ok(newNg.headers["content-type"].includes("json"), newNg.headers["content-type"]);
    // 原版 Clash 读不懂 VLESS / Hysteria2，整份只剩说明。
    const premium = await get("/api/sub/tok-all", { "user-agent": "ClashX/1.118.0" });
    assert.ok(premium.body.includes("原版 Clash 不支持"), premium.body.slice(0, 300));

    // /info。
    const info = await get("/api/sub/tok-all/info");
    assert.equal(info.status, 200);
    const infoJson = JSON.parse(info.body);
    assert.equal(infoJson.username, "owner");
    assert.equal(infoJson.nodeCount, 2);
    assert.equal(infoJson.total, 10737418240);
    assert.ok(Array.isArray(infoJson.urls));

    // 落地页：浏览器 UA + Accept text/html，不含节点凭据。
    const page = await get("/api/sub/tok-all", { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", accept: "text/html,application/xhtml+xml" });
    assert.equal(page.status, 200);
    assert.ok(page.headers["content-type"].includes("text/html"));
    assert.ok(page.body.includes("一键导入"), page.body.slice(0, 200));
    assert.ok(!page.body.includes("uuid-hk"), "落地页不能带节点凭据");
    // 客户端带 Accept: text/html 但 UA 是客户端：照旧给订阅。
    const notPage = await get("/api/sub/tok-all", { "user-agent": "clash-verge/v1.7.7", accept: "text/html" });
    assert.ok(notPage.body.startsWith("proxies:"), notPage.body.slice(0, 60));

    // 令牌到期 → 403 并记 token-expired。
    assert.equal((await get("/api/sub/tok-expired")).status, 403);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expiredRow = (await query("SELECT lastFailureReason FROM proxy_sub_tokens WHERE id = 3"))[0];
    assert.equal(expiredRow.lastFailureReason, "token-expired");

    // 拉取日志落了表（成功、落地页、被拒都有）。
    const logs = await query("SELECT result, clientFamily FROM proxy_sub_access_logs ORDER BY id");
    assert.ok(logs.some((row) => row.result === "ok"), JSON.stringify(logs));
    assert.ok(logs.some((row) => row.result === "page"), JSON.stringify(logs));
    assert.ok(logs.some((row) => row.result === "token-expired"), JSON.stringify(logs));
    assert.ok(logs.some((row) => row.clientFamily === "v2rayng"), JSON.stringify(logs));

    // 设备限制：开严格模式，不带 x-hwid 的拒绝；带的登记，第二台超限。
    await settingsRepo.setSettings({ "proxySub.deviceLimitEnabled": "true", "proxySub.deviceLimitStrict": "true", "proxySub.deviceLimitFallback": "1" });
    subSettings.invalidateProxySubSettingsCache();
    cache.invalidateProxySubCacheAll();
    const noHwid = await get("/api/sub/tok-all", { "user-agent": "Happ/1.63.1" });
    assert.equal(noHwid.status, 403);
    assert.equal(noHwid.headers["x-hwid-not-supported"], "true");
    const first = await get("/api/sub/tok-all", { "user-agent": "Happ/1.63.1", "x-hwid": "DEVICE-0001-ABCDEF", "x-device-os": "iOS" });
    assert.equal(first.status, 200);
    assert.equal(first.headers["x-hwid-active"], "true");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await get("/api/sub/tok-all", { "user-agent": "Happ/1.63.1", "x-hwid": "DEVICE-0002-ABCDEF" });
    assert.equal(second.status, 403);
    assert.equal(second.headers["x-hwid-max-devices-reached"], "true");
    const again = await get("/api/sub/tok-all", { "user-agent": "Happ/1.63.1", "x-hwid": "DEVICE-0001-ABCDEF" });
    assert.equal(again.status, 200, "已登记的设备照样能拉");
    const devices = await query("SELECT hwid, deviceOs FROM proxy_sub_devices");
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceOs, "iOS");
    await settingsRepo.setSettings({ "proxySub.deviceLimitEnabled": "false", "proxySub.deviceLimitStrict": "false" });
    subSettings.invalidateProxySubSettingsCache();

    // 限流：每令牌每分钟 2 次。
    await settingsRepo.setSettings({ "proxySub.rateLimitPerMinute": "2", "proxySub.cacheTtlSec": "0" });
    subSettings.invalidateProxySubSettingsCache();
    await get("/api/sub/tok-hk");
    await get("/api/sub/tok-hk");
    const limited = await get("/api/sub/tok-hk");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) > 0);

    // 缓存：开 60 秒缓存后，改节点名要让这个用户的缓存作废。
    await settingsRepo.setSettings({ "proxySub.rateLimitPerMinute": "0", "proxySub.cacheTtlSec": "60" });
    subSettings.invalidateProxySubSettingsCache();
    const beforeRename = await get("/api/sub/tok-all?format=clash");
    assert.ok(beforeRename.body.includes("HKT"));
    const repo = await import(url("server/repositories/proxySubscriptionRepository.ts"));
    await repo.updateProxyNode(1, { name: "HKT-renamed" });
    const afterRename = await get("/api/sub/tok-all?format=clash");
    assert.ok(afterRename.body.includes("HKT-renamed"), "改名后缓存要作废：" + afterRename.body.slice(0, 200));

    // 透传模式的外部订阅：Clash 输出里写成 proxy-providers，主选择器 use 它；base64 忽略。
    await exec("INSERT INTO proxy_sub_sources (id, userId, name, url, intervalSec, mode, isEnabled) VALUES (1, 1, '机场A', 'https://airport.example.com/sub', 3600, 'provider', 1)");
    cache.invalidateProxySubCacheAll();
    const withProvider = await get("/api/sub/tok-all?format=clash");
    assert.ok(withProvider.body.includes("proxy-providers:"), withProvider.body.slice(0, 600));
    assert.ok(withProvider.body.includes('url: "https://airport.example.com/sub"'), withProvider.body);
    assert.ok(withProvider.body.includes('use: ["机场A"]'), withProvider.body);
    const base64WithProvider = await get("/api/sub/tok-all");
    assert.equal(links(base64WithProvider.body).length, 2, "base64 不认 provider，节点数不变");

    await new Promise((resolve) => server.close(resolve));
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
