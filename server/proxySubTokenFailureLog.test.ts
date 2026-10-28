import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 「客户说订阅更新不了」这句话，面板能不能回答。
 *
 * 原来只记成功：令牌行上写着「已拉取 3 次」，全是几天前的。于是四种完全不同的情况
 * 长得一模一样 —— 客户根本没试 / 地址被停用 / 账号没资格了 / 服务端出错。第三种要做的
 * 是去续费，第一种是让客户重新导入，做错方向就是白折腾一晚上。
 *
 * 所以失败也要记，并且记下为什么。给客户端的回应：令牌在但被拒是 403 并写明原因（拿得到 40 位令牌的就是主人），令牌不存在才 404；
 * 面板自己这边也要留下线索。
 */
test("SQLite 被拒的拉取要记下原因，成功之后不再挂着", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sub-failure-"));
  const databasePath = path.join(directory, "sub-failure.db");
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
    const { proxySubTokenStatus } = await import(url("shared/proxySubTokenStatus.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription, accountEnabled) VALUES (1, 'owner', 'hash', 'user', 1, 1)");
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, tls, isEnabled, includeDirect) VALUES (1, 1, 'HKT', 'vless', 'hkt.example.com', 443, 'abc-uuid', 1, 1, 1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (1, 1, '手机', 'tok-live', 'base64', 1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (2, 1, '停用的', 'tok-off', 'base64', 0)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled, expiresAt) VALUES (3, 1, '过期的', 'tok-exp', 'base64', 1, ?)",
      [Math.floor(Date.now() / 1000) - 3600]);

    const app = express();
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const get = (pathname) => new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET" }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      });
      request.on("error", reject);
      request.end();
    });
    const tokenRow = async (id) => (await query('SELECT "accessCount", "lastAccessAt", "lastFailureAt", "lastFailureReason" FROM "proxy_sub_tokens" WHERE "id" = ?', [id]))[0];
    // 记录是 void 出去的，给它一拍时间落库。
    const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

    // 1. 被停用的地址：客户端看到 403 和原因，但面板记下了原因。
    assert.equal((await get("/api/sub/tok-off")).status, 403);
    await settle();
    let row = await tokenRow(2);
    assert.equal(row.lastFailureReason, "disabled");
    assert.equal(proxySubTokenStatus(row).kind, "failed");

    // 2. 过期的地址
    assert.equal((await get("/api/sub/tok-exp")).status, 403);
    await settle();
    assert.equal((await tokenRow(3)).lastFailureReason, "token-expired");

    // 3. 账号没资格了（到期）—— 商家最需要看到的就是这一条
    await exec("UPDATE users SET expiresAt = ? WHERE id = 1", [Math.floor(Date.now() / 1000) - 3600]);
    assert.equal((await get("/api/sub/tok-live")).status, 403);
    await settle();
    row = await tokenRow(1);
    assert.equal(row.lastFailureReason, "not-eligible");
    assert.equal(Number(row.accessCount || 0), 0, "被拒不算一次成功拉取");

    // 4. 续上之后再拉：成功，行上不该再挂着那句红字
    await exec("UPDATE users SET expiresAt = NULL WHERE id = 1");
    const ok = await get("/api/sub/tok-live");
    assert.equal(ok.status, 200);
    await settle();
    row = await tokenRow(1);
    assert.equal(Number(row.accessCount || 0), 1);
    assert.equal(row.lastFailureReason, null, "拉成功了就该把上一次被拒清掉");
    assert.equal(
      proxySubTokenStatus(row).kind,
      "ok",
      "失败之后又拉成功了就别再报警 —— 客户已经拿到了",
    );

    // 5. 令牌根本不存在：无处可记，也不该凭空造一行出来
    const before = Number((await query('SELECT COUNT(*) AS c FROM "proxy_sub_tokens"', []))[0].c);
    assert.equal((await get("/api/sub/no-such-token-at-all")).status, 404);
    await settle();
    assert.equal(
      Number((await query('SELECT COUNT(*) AS c FROM "proxy_sub_tokens"', []))[0].c),
      before,
      "地址被改过或重置过那一种记不了，别假装能分辨",
    );

    console.log("OK");
    await new Promise((resolve) => server.close(resolve));
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
