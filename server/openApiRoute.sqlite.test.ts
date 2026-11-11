import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * GET /api/openapi.json 接上真库（SQLite）跑一遍：没登录、令牌无效都是 401；带有效的 API 令牌
 * （只开了部分模块的也行）拿得到；面板地址写进 servers；文档只生成一次，之后走缓存；
 * 浏览器再来问一次是 304。
 */
test("openapi route: auth, servers, download header and cache", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-openapi-route-"));
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
      const express = (await import("express")).default;
      const cookieParser = (await import("cookie-parser")).default;
      const route = await import(url("server/openApiRoute.ts"));
      const tokens = await import(url("server/ops/apiTokens.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const { appRouter } = await import(url("server/routers.ts"));

      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'root', 'h', 'admin')");
      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'h', 'user')");
      const full = await tokens.createUserApiToken({ userId: 1, name: "ci", scope: "full" });
      const scoped = await tokens.createUserApiToken({ userId: 2, name: "rules-only", scope: "read", modules: ["rules"] });

      const app = express();
      app.use(cookieParser());
      app.use(route.openApiRouter);
      const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const base = "http://127.0.0.1:" + server.address().port;
      const get = (headers = {}, suffix = "") => fetch(base + "/api/openapi.json" + suffix, { headers });

      // 没登录、令牌是编的：401，不生成文档
      const anonymous = await get();
      assert.equal(anonymous.status, 401);
      assert.match(anonymous.headers.get("www-authenticate"), /Bearer/);
      assert.match((await anonymous.json()).error, /API 令牌/);
      const forged = await get({ Authorization: "Bearer nex_" + "a".repeat(40) });
      assert.equal(forged.status, 401);
      assert.equal(route.openApiBuildCountForTests(), 0, "没认证的请求不触发生成");

      // 有效令牌：拿得到，是 OpenAPI 3.1，过程数和路由对得上，面板地址是这次请求的地址
      const ok = await get({ Authorization: "Bearer " + full.token });
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get("content-type"), /application\/json/);
      assert.match(ok.headers.get("cache-control"), /private/);
      assert.equal(ok.headers.get("set-cookie"), null, "令牌请求不种 cookie");
      const text = await ok.text();
      const doc = JSON.parse(text);
      assert.equal(doc.openapi, "3.1.0");
      assert.deepEqual(doc.servers, [{ url: base, description: "这个面板" }]);
      assert.equal(Object.keys(doc.paths).length, Object.keys(appRouter._def.procedures).length);
      assert.ok(doc.paths["/api/trpc/rules.listPage"].get);
      assert.ok(doc.paths["/api/trpc/ops.eventWebhooks.save"].post);
      assert.equal(doc.paths["/api/trpc/ops.eventWebhooks.save"].post["x-nex-api-token"].allowed, false);

      // 只开了「转发规则」模块的普通用户令牌也能看文档
      const limited = await get({ Authorization: "Bearer " + scoped.token });
      assert.equal(limited.status, 200);
      assert.equal(await limited.text(), text);

      // 设置里填了面板公开地址：servers 用它；别的部分一个字不差，而且没有重新生成
      await settings.setSetting("panelPublicUrl", "https://panel.example.com/");
      const configured = await get({ Authorization: "Bearer " + full.token }, "?download=1");
      assert.equal(configured.status, 200);
      assert.match(configured.headers.get("content-disposition"), /attachment; filename="nex-openapi\.json"/);
      const configuredDoc = await configured.json();
      assert.deepEqual(configuredDoc.servers, [{ url: "https://panel.example.com", description: "这个面板" }]);
      assert.deepEqual({ ...configuredDoc, servers: null }, { ...doc, servers: null });
      assert.equal(route.openApiBuildCountForTests(), 1, "三次成功的请求只生成了一次");

      // 浏览器带着上次的 ETag 再问：304
      const etag = configured.headers.get("etag");
      assert.ok(etag);
      // （fetch 自己带条件头时会顺手加 Cache-Control: no-cache，服务端就不回 304 了，这里用 http 模块发）
      const http = await import("node:http");
      const againStatus = await new Promise((resolve, reject) => {
        http.get(base + "/api/openapi.json", { headers: { Authorization: "Bearer " + full.token, "If-None-Match": etag } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on("error", reject);
      });
      assert.equal(againStatus, 304);

      // 撤销后的令牌拿不到
      await tokens.revokeUserApiToken(1, full.id);
      assert.equal((await get({ Authorization: "Bearer " + full.token })).status, 401);

      server.closeAllConnections();
      server.close();
      console.log("OK");
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        JWT_SECRET: "openapi-route-test-secret",
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "openapi-route.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        FORWARDX_DATA_DIR: directory,
        FORWARDX_DEV_PANEL: "",
      },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
