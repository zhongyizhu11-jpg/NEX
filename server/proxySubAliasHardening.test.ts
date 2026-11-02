import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 短链别名不能被未登录的人枚举（P0-3），以及几处「先查后改」的竞态（P2-11）：
 *   - 查空按 IP 计数，一分钟 20 次以后这个 IP 的订阅请求（查得到的也算）一律 429；
 *   - 短链被拒和不存在一样回 404，长地址照旧 403 + 原因；
 *   - 从短链打开的落地页、Profile-Web-Page-Url 头里不出现令牌；
 *   - 新设的别名至少 10 位，老的短别名原样保存照样能过；
 *   - /info 接上订阅限流；
 *   - 同一条令牌同时来几台新设备，设备上限不会被冲破；通知去重标记只有一路抢得到。
 */
test("短链别名防枚举、/info 限流、设备数与通知去重的竞态", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-alias-"));
  const databasePath = path.join(directory, "sub-alias.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const route = await import(url("server/proxySubscriptionRoute.ts"));
    const { proxySubscriptionsRouter } = await import(url("server/routers/proxySubscriptions.ts"));
    const settings = await import(url("server/proxySubSettings.ts"));
    const settingsRepo = await import(url("server/repositories/settingsRepository.ts"));
    const limiter = await import(url("server/proxySubRateLimit.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, trafficUsed, trafficLimit, allowProxySubscription) VALUES (1, 'owner', 'hash', 'user', 0, 0, 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'h1', '1.2.3.4', '1.2.3.4', 1)");
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, path, tls, sni, isEnabled) VALUES (1, 1, 'N', 'vless', 'n.example.com', 443, 'u', 'ws', '/r', 1, 'n.example.com', 1)");
    await exec("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (1,1,'r','realm','tcp',20001,'n.example.com',443,1,1,1,0,1,1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, alias, defaultFormat, isEnabled) VALUES (1, 1, 'phone', 'tok-secret-0123456789abcdefghijklmnopqrst', 'vip1', 'base64', 1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, alias, defaultFormat, isEnabled) VALUES (2, 1, 'off', 'tok-off-0123456789abcdefghijklmnopqrstuv', 'home', 'base64', 0)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (3, 1, 'race', 'tok-race-0123456789abcdefghijklmnopqrstu', 'base64', 1)");
    await settings.saveProxySubSettings({ rateLimitPerMinute: 0, ipRateLimitPerMinute: 0, cacheTtlSec: 0 });

    const app = express();
    app.set("trust proxy", true);
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const get = (p, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: p, headers: { "user-agent": "clash-verge/1.0", ...headers } }, (res) => {
        let body = ""; res.setEncoding("utf8"); res.on("data", (c) => body += c);
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject); req.end();
    });
    const from = (ip, extra = {}) => ({ "x-forwarded-for": ip, ...extra });
    const browser = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", accept: "text/html,application/xhtml+xml" };

    try {
      // 老的 4 位别名照样能拉；Profile-Web-Page-Url 用短链，不带令牌。
      const ok = await get("/s/vip1", from("198.51.100.1"));
      assert.equal(ok.status, 200);
      assert.ok(String(ok.headers["profile-web-page-url"] || "").endsWith("/s/vip1"), ok.headers["profile-web-page-url"]);
      assert.ok(!String(ok.headers["profile-web-page-url"] || "").includes("tok-secret"));
      // 长地址的头照旧是令牌地址。
      const byToken = await get("/api/sub/tok-secret-0123456789abcdefghijklmnopqrst", from("198.51.100.1"));
      assert.ok(String(byToken.headers["profile-web-page-url"] || "").includes("/api/sub/tok-secret"));

      // 从短链打开的落地页：没有令牌，按钮、二维码都用短链。
      const page = await get("/s/vip1", from("198.51.100.1", browser));
      assert.equal(page.status, 200);
      assert.ok(page.headers["content-type"].includes("text/html"));
      assert.ok(!page.body.includes("tok-secret"), "短链落地页不能出现令牌");
      assert.ok(page.body.includes("/s/vip1"), "短链落地页的地址要是短链");
      assert.ok(page.body.includes('data-copy="http://127.0.0.1:' + port + '/s/vip1"'), "复制按钮要给短链");
      assert.ok(page.body.includes("%2Fs%2Fvip1%3Fformat%3Dclash"), "客户端按钮要用短链并钉格式");
      assert.ok(!page.body.includes("api/sub") && !page.body.includes("api%2Fsub"), "任何一个按钮都不能指向令牌地址");
      for (const match of page.body.matchAll(/sub:\/\/([A-Za-z0-9+/=_-]+)/g)) {
        assert.ok(!Buffer.from(match[1], "base64").toString("utf8").includes("tok-secret"), "base64 编码的导入链接里也不能有令牌");
      }
      // 从长地址打开的落地页照旧给令牌地址，另列一行短链。
      const tokenPage = await get("/api/sub/tok-secret-0123456789abcdefghijklmnopqrst", from("198.51.100.1", browser));
      assert.ok(tokenPage.body.includes("/api/sub/tok-secret"), "长地址落地页照旧");
      assert.ok(tokenPage.body.includes("复制短链"));
      // 短链拼出来的格式地址能用。
      assert.equal((await get("/s/vip1?format=clash", from("198.51.100.1"))).status, 200);

      // 被拒：短链 404（和不存在一样），长地址 403 + 原因；面板照样记下原因。
      const offAlias = await get("/s/home", from("198.51.100.2"));
      const missingAlias = await get("/s/nope", from("198.51.100.2"));
      assert.equal(offAlias.status, 404);
      assert.equal(offAlias.body, missingAlias.body, "被拒和不存在要一模一样");
      assert.equal((await get("/api/sub/tok-off-0123456789abcdefghijklmnopqrstuv", from("198.51.100.2"))).status, 403);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((await query("SELECT lastFailureReason FROM proxy_sub_tokens WHERE id = 2"))[0].lastFailureReason, "disabled");

      // 查空计数：同一个 IP 一分钟查空 20 次，之后连查得到的也 429；别的 IP 不受影响。
      limiter.clearProxySubRateLimitForTests();
      for (let i = 0; i < limiter.PROXY_SUB_MISS_LIMIT - 1; i++) {
        assert.equal((await get("/s/guess" + i, from("203.0.113.9"))).status, 404);
      }
      assert.equal((await get("/s/vip1", from("203.0.113.9"))).status, 200, "还没到上限");
      assert.equal((await get("/api/sub/guess-token", from("203.0.113.9"))).status, 404, "第 20 次查空");
      const blocked = await get("/s/vip1", from("203.0.113.9"));
      assert.equal(blocked.status, 429, "到了上限以后查得到的也挡");
      assert.ok(Number(blocked.headers["retry-after"]) > 800, blocked.headers["retry-after"]);
      assert.equal((await get("/api/sub/tok-secret-0123456789abcdefghijklmnopqrst/info", from("203.0.113.9"))).status, 429);
      assert.equal((await get("/s/vip1", from("203.0.113.10"))).status, 200, "别的 IP 不受影响");
      limiter.clearProxySubRateLimitForTests();

      // /info 接上订阅限流（每令牌每分钟 2 次）。
      await settings.saveProxySubSettings({ rateLimitPerMinute: 2 });
      settings.invalidateProxySubSettingsCache();
      const infoPath = "/api/sub/tok-secret-0123456789abcdefghijklmnopqrst/info";
      assert.equal((await get(infoPath, from("198.51.100.3"))).status, 200);
      assert.equal((await get(infoPath, from("198.51.100.3"))).status, 200);
      const infoLimited = await get(infoPath, from("198.51.100.3"));
      assert.equal(infoLimited.status, 429);
      assert.ok(Number(infoLimited.headers["retry-after"]) > 0);
      await settings.saveProxySubSettings({ rateLimitPerMinute: 0 });
      settings.invalidateProxySubSettingsCache();
      limiter.clearProxySubRateLimitForTests();

      // 别名长度：新设的至少 10 位；老的短别名原样保存照样过；改成别的短别名不行。
      const caller = proxySubscriptionsRouter.createCaller({ user: { id: 1, role: "user", username: "owner" }, req: { headers: {}, socket: {} }, res: {} });
      await assert.rejects(() => caller.createToken({ name: "x", alias: "short-1" }), /10–32/);
      const created = await caller.createToken({ name: "x", alias: "long-enough-1" });
      assert.ok(created.id);
      await caller.updateToken({ id: 1, name: "phone", alias: "vip1" });
      assert.equal((await query("SELECT alias FROM proxy_sub_tokens WHERE id = 1"))[0].alias, "vip1");
      await assert.rejects(() => caller.updateToken({ id: 1, alias: "vip2" }), /10–32/);
      await caller.updateToken({ id: 1, alias: "vip1-renamed-x" });
      assert.equal((await query("SELECT alias FROM proxy_sub_tokens WHERE id = 1"))[0].alias, "vip1-renamed-x");

      // 设备数：上限 1、严格模式，五台新设备同时来，只能放进一台。
      await settingsRepo.setSettings({ "proxySub.deviceLimitEnabled": "true", "proxySub.deviceLimitStrict": "true" });
      await exec("UPDATE proxy_sub_tokens SET maxDevices = 1 WHERE id = 3");
      settings.invalidateProxySubSettingsCache();
      const results = await Promise.all([0, 1, 2, 3, 4].map((i) => get("/api/sub/tok-race-0123456789abcdefghijklmnopqrstu", from("198.51.100.4", { "user-agent": "Happ/1.63.1", "x-hwid": "RACE-DEVICE-000" + i }))));
      assert.equal(results.filter((item) => item.status === 200).length, 1, JSON.stringify(results.map((item) => item.status)));
      assert.equal((await query("SELECT COUNT(*) AS c FROM proxy_sub_devices WHERE tokenId = 3"))[0].c, 1);

      // 通知去重：同一个键同时抢十次，只有一次抢到。
      const claims = await Promise.all(Array.from({ length: 10 }, () => settingsRepo.claimSettingKey("proxySubNotify:test:1:2026-01-01")));
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await settingsRepo.claimSettingKey("proxySubNotify:test:1:2026-01-01"), false);
      assert.equal(await settingsRepo.getSetting("proxySubNotify:test:1:2026-01-01"), "1");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
