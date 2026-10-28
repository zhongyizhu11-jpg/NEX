import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 「订阅拉了两百多次说地址无效，重置以后导进客户端 404」。
 *
 * 拉取次数从来不是限制；真正让人看不懂的是：
 *   - 令牌在、但被拒（设备满了、账号到期、地址停用）时一律回「订阅不存在」404，客户端上和地址没了一模一样；
 *   - 重置只换了令牌：旧短链 /s/<别名> 照样能拉，「最近一次没拉到」还挂着，按令牌 id 记的限流计数也还在，
 *     新地址一导入就是 429；
 *   - 账号本身没资格时重置照样成功，换来一条同样拉不到的新地址，却没人告诉他为什么。
 */
test("重置订阅地址：旧地址和旧短链失效、限流计数清零、被拒的原因写明白", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sub-rotate-"));
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
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, trafficUsed, trafficLimit, allowProxySubscription) VALUES (1, 'owner', 'hash', 'user', 0, 0, 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'h1', '1.2.3.4', '1.2.3.4', 1)");
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, path, tls, sni, isEnabled) VALUES (1, 1, 'N', 'vless', 'n.example.com', 443, 'u', 'ws', '/r', 1, 'n.example.com', 1)");
    await exec("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (1,1,'r','realm','tcp',20001,'n.example.com',443,1,1,1,0,1,1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, alias, defaultFormat, isEnabled) VALUES (1, 1, 'phone', 'tok-old', 'myphone', 'base64', 1)");
    await settings.saveProxySubSettings({ rateLimitPerMinute: 3, ipRateLimitPerMinute: 0 });

    const app = express();
    app.set("trust proxy", true);
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const get = (p) => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: p, headers: { "user-agent": "clash-verge/1.0" } }, (res) => {
        let body = ""; res.setEncoding("utf8"); res.on("data", (c) => body += c);
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject); req.end();
    });
    const caller = proxySubscriptionsRouter.createCaller({ user: { id: 1, role: "user", username: "owner" }, req: { headers: {}, socket: {} }, res: {} });
    const out = {};
    try {
      // 限流：一分钟 3 次，第 4 次 429。
      for (let i = 0; i < 3; i++) assert.equal((await get("/api/sub/tok-old")).status, 200);
      out.limitedBefore = (await get("/api/sub/tok-old")).status;
      await exec("UPDATE proxy_sub_tokens SET lastFailureAt = ?, lastFailureReason = 'device-limit' WHERE id = 1", [Math.floor(Date.now() / 1000)]);

      const rotated = await caller.rotateToken({ id: 1 });
      out.warningWhenEligible = rotated.warning;
      const row = (await query("SELECT token, alias, lastFailureAt, lastFailureReason FROM proxy_sub_tokens WHERE id = 1"))[0];
      out.row = { aliasCleared: row.alias == null, failureCleared: row.lastFailureAt == null && row.lastFailureReason == null };
      out.oldToken = (await get("/api/sub/tok-old")).status;
      out.oldAlias = (await get("/s/myphone")).status;
      out.newToken = (await get("/api/sub/" + row.token)).status;

      // 停用的地址：403 并写明原因（不再是「订阅不存在」）。
      await exec("UPDATE proxy_sub_tokens SET isEnabled = 0 WHERE id = 1");
      const disabled = await get("/api/sub/" + row.token);
      out.disabled = { status: disabled.status, body: disabled.body };
      await exec("UPDATE proxy_sub_tokens SET isEnabled = 1 WHERE id = 1");

      // 账号到期：重置照样成功，但要告诉他新地址也拉不到。
      await exec("UPDATE users SET expiresAt = ? WHERE id = 1", [Math.floor(Date.now() / 1000) - 60]);
      const expired = await caller.rotateToken({ id: 1 });
      out.warningWhenExpired = expired.warning;
      const expiredPull = await get("/api/sub/" + expired.token);
      out.expiredPull = { status: expiredPull.status, body: expiredPull.body };
    } finally {
      server.close();
    }
    console.log("RESULT " + JSON.stringify(out));
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "rotate.db") },
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
    assert.ok(line, result.stdout);
    const out = JSON.parse(line.slice("RESULT ".length));
    assert.equal(out.limitedBefore, 429);
    assert.deepEqual(out.row, { aliasCleared: true, failureCleared: true });
    assert.equal(out.oldToken, 404, "旧地址立即失效");
    assert.equal(out.oldAlias, 404, "旧短链也要失效");
    assert.equal(out.newToken, 200, "新地址不能一导入就被上一分钟的限流计数挡住");
    assert.equal(out.warningWhenEligible, null);
    assert.equal(out.disabled.status, 403);
    assert.match(out.disabled.body, /停用/);
    assert.match(String(out.warningWhenExpired), /没有订阅资格/);
    assert.equal(out.expiredPull.status, 403);
    assert.match(out.expiredPull.body, /订阅资格/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
