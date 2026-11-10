import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 事件推送接上真库（SQLite）和一个本地接收方跑一遍：
 * 默认关着什么都不发；开了以后事件从 recordPanelEvent 这一个入口分发出去，只到订阅了那一类的地址；
 * 停用的地址、关掉总开关后不发；密钥读回来是打码的、库里是密文；改地址不填密钥就是不换；
 * 填错的地址和太短的密钥被拒；测试事件不看开关；只有管理员能配、令牌碰不到、改动进操作审计。
 */
test("event webhooks: dispatch from the single event entry, filters, masking, validation and audit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-event-webhooks-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import crypto from "node:crypto";
      import http from "node:http";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const { recordPanelEvent } = await import(url("server/ops/panelEvents.ts"));
      const hooks = await import(url("server/ops/eventWebhooks.ts"));
      const audit = await import(url("server/operationAudit.ts"));
      const { apiTokenPolicyError } = await import(url("server/ops/apiTokenPolicy.ts"));
      const { appRouter } = await import(url("server/routers.ts"));
      const { auditRouter } = await import(url("server/routers/ops/audit.ts"));

      await runtime.executeRaw("INSERT INTO users (id, username, name, password, role) VALUES (1, 'root', '管理员', 'h', 'admin')");
      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'h', 'user')");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (1, '港-1', '203.0.113.1', 'slave', 'tok1', 1)");

      // 本地接收方：按路径分开记
      const received = [];
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
          res.writeHead(200);
          res.end("ok");
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = "http://127.0.0.1:" + server.address().port;
      const of = (p) => received.filter((item) => item.path === p);
      const verify = (secret, item) => {
        const timestamp = String(item.headers["x-nex-timestamp"]);
        const expected = "sha256=" + crypto.createHmac("sha256", secret).update(timestamp + "." + item.body).digest("hex");
        return expected === item.headers["x-nex-signature"];
      };
      const settled = async () => {
        // 事件监听器是异步的：等它跑完、队列发空
        for (let i = 0; i < 200; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (i > 5 && hooks.eventWebhookQueueIdleForTests()) return;
        }
        throw new Error("队列一直没发空");
      };
      const ctxOf = (user, extra = {}) => ({
        req: { headers: {}, ip: "127.0.0.1", socket: {}, originalUrl: "/api/trpc/x" },
        res: { cookie() {}, clearCookie() {} },
        user,
        authSession: null,
        authFailureReason: null,
        ...extra,
      });
      const admin = { id: 1, username: "root", role: "admin" };
      const api = appRouter.createCaller(ctxOf(admin)).ops.eventWebhooks;

      // ── 默认：关着，没有地址 ──
      let view = await api.list();
      assert.equal(view.enabled, false);
      assert.deepEqual(view.endpoints, []);
      await recordPanelEvent({ kind: "host.offline", level: "warn", hostId: 1, message: "港-1 断线" });
      await settled();
      assert.equal(received.length, 0);

      // ── 配三个地址：A 订主机，B 订线路和规则，C 订主机但停用 ──
      const SECRET_A = "secret-A-0123456789abcd";
      const SECRET_B = "secret-B-0123456789wxyz";
      view = await api.save({ url: base + "/a?token=in-url", secret: SECRET_A, categories: ["host"], enabled: true });
      view = await api.save({ url: base + "/b", secret: SECRET_B, categories: ["route", "rule"], enabled: true });
      view = await api.save({ url: base + "/c", secret: "secret-C-0123456789abcd", categories: ["host"], enabled: false });
      assert.equal(view.endpoints.length, 3);
      const [a, b, c] = view.endpoints;

      // 密钥读回来是打码的；库里存的是密文，既看不到密钥也看不到地址
      assert.equal(a.secretHint, "••••abcd");
      assert.equal(JSON.stringify(view).includes(SECRET_A), false);
      assert.equal(JSON.stringify(view).includes(SECRET_B), false);
      assert.equal(a.urlLabel.includes("in-url"), false, "给人看的地址不带查询串");
      const stored = await runtime.queryRaw("SELECT value FROM system_settings WHERE key = 'ops.eventWebhooks.endpoints'");
      assert.equal(stored.length, 1);
      assert.equal(String(stored[0].value).includes("secret-A"), false);
      assert.equal(String(stored[0].value).includes("127.0.0.1"), false);
      assert.equal(String(stored[0].value).startsWith("["), false);

      // 地址都配好了，但总开关没开：还是不发
      await recordPanelEvent({ kind: "host.offline", level: "warn", hostId: 1, message: "港-1 断线" });
      await settled();
      assert.equal(received.length, 0);

      // ── 打开总开关 ──
      view = await api.setEnabled({ enabled: true });
      assert.equal(view.enabled, true);
      const offline = await recordPanelEvent({ kind: "host.offline", level: "warn", hostId: 1, message: "港-1 断线", data: { lastSeenAt: 1700000000 } });
      await settled();
      assert.equal(of("/a?token=in-url").length, 1, "订了主机的 A 收到");
      assert.equal(of("/b").length, 0, "B 没订主机");
      assert.equal(of("/c").length, 0, "C 停用着");
      const first = of("/a?token=in-url")[0];
      assert.equal(verify(SECRET_A, first), true);
      assert.equal(verify(SECRET_B, first), false);
      const body = JSON.parse(first.body);
      assert.deepEqual(Object.keys(body), ["id", "type", "occurredAt", "data"]);
      assert.equal(body.id, "evt_" + offline.id);
      assert.equal(body.type, "host.offline");
      assert.equal(body.occurredAt, offline.createdAt.toISOString());
      assert.deepEqual(body.data, { level: "warn", message: "港-1 断线", hostId: 1, hostName: "港-1", userId: null, userName: null, ruleId: null, detail: { lastSeenAt: 1700000000 } });
      assert.equal(first.headers["x-nex-event"], "host.offline");
      assert.equal(first.headers["x-nex-delivery"], body.id);

      // 类别过滤：线路和规则到 B，面板运维没人订，认不出前缀的不推
      await recordPanelEvent({ kind: "route.switched", message: "规则「web」从 A 切到 B", ruleId: 9, userId: 1, data: { from: "A", to: "B", reason: "primary_down" } });
      await recordPanelEvent({ kind: "rule.error", level: "warn", message: "规则「web」出错", ruleId: 9 });
      await recordPanelEvent({ kind: "ops.maintenance", message: "维护模式已开启" });
      await recordPanelEvent({ kind: "weird.thing", message: "不在类别表里" });
      await settled();
      assert.deepEqual(of("/b").map((item) => JSON.parse(item.body).type).sort(), ["route.switched", "rule.error"]);
      assert.equal(of("/b").every((item) => verify(SECRET_B, item)), true);
      assert.equal(JSON.parse(of("/b").find((item) => item.headers["x-nex-event"] === "route.switched").body).data.userName, "管理员");
      assert.equal(of("/a?token=in-url").length, 1);
      assert.equal(received.length, 3);

      // 最近投递结果看得到状态码和耗时
      view = await api.list();
      const aView = view.endpoints.find((item) => item.id === a.id);
      assert.equal(aView.recent.length, 1);
      assert.deepEqual([aView.recent[0].ok, aView.recent[0].status, aView.recent[0].attempt, aView.recent[0].type], [true, 200, 1, "host.offline"]);
      assert.equal(typeof aView.recent[0].durationMs, "number");

      // ── 改 A：不填密钥 = 不换；填了就换 ──
      view = await api.save({ id: a.id, url: base + "/a2", categories: ["host", "ops"], enabled: true });
      assert.equal(view.endpoints.length, 3);
      await recordPanelEvent({ kind: "host.online", hostId: 1, message: "港-1 上线" });
      await settled();
      assert.equal(of("/a2").length, 1);
      assert.equal(verify(SECRET_A, of("/a2")[0]), true, "密钥没变");
      const SECRET_A2 = "rotated-A-0123456789zzzz";
      await api.save({ id: a.id, url: base + "/a2", secret: SECRET_A2, categories: ["host", "ops"], enabled: true });
      await recordPanelEvent({ kind: "ops.maintenance", message: "维护模式已开启" });
      await settled();
      assert.equal(of("/a2").length, 2);
      assert.equal(verify(SECRET_A2, of("/a2")[1]), true, "换了新密钥");
      assert.equal(verify(SECRET_A, of("/a2")[1]), false);

      // ── 停用 A 后不发；关掉总开关后谁都不发 ──
      await api.save({ id: a.id, url: base + "/a2", categories: ["host", "ops"], enabled: false });
      await recordPanelEvent({ kind: "host.offline", level: "warn", hostId: 1, message: "港-1 断线" });
      await settled();
      assert.equal(of("/a2").length, 2, "停用后没有再收到");
      await api.setEnabled({ enabled: false });
      const before = received.length;
      await recordPanelEvent({ kind: "route.switched", message: "又切了一次", ruleId: 9 });
      await settled();
      assert.equal(received.length, before, "总开关关了，B 也不再收到");

      // ── 测试事件：不看开关，只发给这一个地址，结果直接返回 ──
      const tested = await api.test({ id: b.id });
      assert.deepEqual([tested.ok, tested.status, tested.error], [true, 200, null]);
      assert.equal(typeof tested.durationMs, "number");
      const testItem = of("/b").at(-1);
      assert.equal(JSON.parse(testItem.body).type, "webhook.test");
      assert.match(JSON.parse(testItem.body).id, /^evt_test_[0-9a-f]{16}$/);
      assert.equal(verify(SECRET_B, testItem), true);
      assert.equal((await api.list()).endpoints.find((item) => item.id === b.id).recent[0].type, "webhook.test");

      // ── 填错的被拒（400，带原话），不改已有配置 ──
      const rejects = async (input, pattern) => {
        await assert.rejects(() => api.save(input), (error) => {
          assert.equal(error.code, "BAD_REQUEST", error.message);
          assert.match(error.message, pattern);
          return true;
        });
      };
      const good = { url: base + "/x", secret: "0123456789abcdef", categories: ["host"], enabled: true };
      await rejects({ ...good, url: "ftp://example.com/hook" }, /http/);
      await rejects({ ...good, url: "https://user:pass@example.com/hook" }, /账号密码/);
      await rejects({ ...good, secret: "too-short" }, /至少 16/);
      await rejects({ ...good, secret: undefined }, /至少 16/);
      await rejects({ ...good, id: "00000000" }, /不存在/);
      await assert.rejects(() => api.save({ ...good, categories: [] }));
      await assert.rejects(() => api.save({ ...good, categories: ["nope"] }));
      assert.equal((await api.list()).endpoints.length, 3);
      // 内网地址可以（自建用户要推到内网的 n8n / Home Assistant）
      view = await api.save({ ...good, url: "http://192.168.1.10:5678/webhook/nex", enabled: false });
      assert.equal(view.endpoints.length, 4);
      // 最多十个
      for (let n = 0; n < 6; n += 1) await api.save({ ...good, url: base + "/more" + n, enabled: false });
      await rejects({ ...good, url: base + "/eleventh" }, /最多 10 个/);

      // 删除
      view = await api.remove({ id: c.id });
      assert.equal(view.endpoints.some((item) => item.id === c.id), false);
      assert.equal(view.endpoints.length, 9);

      // ── 只有管理员能配；API 令牌整个碰不到 ──
      const tenant = appRouter.createCaller(ctxOf({ id: 2, username: "tenant", role: "user" })).ops.eventWebhooks;
      await assert.rejects(() => tenant.list(), (error) => error.code === "FORBIDDEN");
      await assert.rejects(() => tenant.save(good), (error) => error.code === "FORBIDDEN");
      const withToken = appRouter.createCaller(ctxOf(admin, { apiToken: { id: 5, name: "ci", scope: "full" } })).ops.eventWebhooks;
      await assert.rejects(() => withToken.list(), (error) => error.code === "FORBIDDEN");
      await assert.rejects(() => withToken.test({ id: b.id }), (error) => error.code === "FORBIDDEN");
      for (const procedure of ["list", "save", "remove", "setEnabled", "test"]) {
        assert.ok(apiTokenPolicyError("full", "ops.eventWebhooks." + procedure, procedure === "list" ? "query" : "mutation"), procedure);
      }

      // ── 改动进操作审计，密钥打码 ──
      await audit.drainOperationAuditWrites();
      const reader = auditRouter.createCaller(ctxOf(admin));
      const rows = (await reader.list({ module: "ops.eventWebhooks", limit: 100 })).items;
      const paths = new Set(rows.map((item) => item.path + ":" + item.result));
      for (const expected of ["ops.eventWebhooks.save:ok", "ops.eventWebhooks.save:error", "ops.eventWebhooks.save:denied", "ops.eventWebhooks.setEnabled:ok", "ops.eventWebhooks.remove:ok", "ops.eventWebhooks.test:ok"]) {
        assert.ok(paths.has(expected), expected + " 不在审计里：" + [...paths].join(", "));
      }
      const firstSave = rows.filter((item) => item.path === "ops.eventWebhooks.save" && item.result === "ok").at(-1);
      const detail = await reader.detail({ id: firstSave.id });
      assert.equal(detail.event.input.secret, "[已隐藏]");
      assert.equal(JSON.stringify(detail).includes(SECRET_A), false);
      assert.match(detail.event.input.url, /\/a\?token=/);

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
        JWT_SECRET: "event-webhooks-test-secret",
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "event-webhooks.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        FORWARDX_DATA_DIR: directory,
      },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
