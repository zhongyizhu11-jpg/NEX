import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 操作审计接上真库（SQLite）跑一遍：tRPC 中间件对成功 / 被拒 / 失败的写操作各记一行，
 * 匿名、查询、跳过名单、嵌套调用不记（过程返回后它拉起的后台循环再调写操作要单独记）；参数打码；
 * 同一次请求的配置审计能从详情里找回来；
 * 列表的几种筛选；保留天数清理；跳过名单里的每个名字都还是真实存在的 mutation。
 */
test("operation audit middleware, router filters, config linkage and retention", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-operation-audit-"));
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
      const { z } = await import("zod");
      const { TRPCError } = await import("@trpc/server");
      const core = await import(url("server/_core/trpc.ts"));
      const configAudit = await import(url("server/configAudit.ts"));
      const audit = await import(url("server/operationAudit.ts"));
      const { auditRouter } = await import(url("server/routers/ops/audit.ts"));

      const inner = core.router({ touch: core.adminProcedure.mutation(() => "inner") });
      // 过程里拉起、过程返回后才干活的后台循环（像保存设置时拉起的 Telegram 轮询）：它带着那次的审计上下文
      let releaseLoop;
      const loopGate = new Promise((resolve) => { releaseLoop = resolve; });
      let loopWork = null;
      const app = core.router({
        saveSettings: core.adminProcedure
          .input(z.object({ smtpHost: z.string(), emailPassword: z.string(), nested: z.any().optional() }))
          .mutation(() => ({ saved: true })),
        changeRule: core.adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
          await configAudit.recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: input.id, action: "update", before: { name: "旧名字" }, after: { name: "新名字" } });
          return true;
        }),
        outer: core.adminProcedure.mutation(async ({ ctx }) => inner.createCaller(ctx).touch()),
        spawnLoop: core.adminProcedure.mutation(({ ctx }) => {
          loopWork = loopGate.then(() => app.createCaller(ctx).changeRule({ id: 6 }));
          return "spawned";
        }),
        broken: core.adminProcedure.mutation(() => { throw new TRPCError({ code: "BAD_REQUEST", message: "参数不对：端口超出范围" }); }),
        mine: core.protectedProcedure.mutation(() => "ok"),
        peek: core.adminProcedure.query(() => 1),
        diagnostics: core.router({ start: core.adminProcedure.mutation(() => "started") }),
      });
      const ctxOf = (user, extra = {}) => ({
        req: { headers: { "user-agent": "audit-test/1.0" }, ip: "::ffff:203.0.113.9", socket: {}, originalUrl: "/api/trpc/x" },
        res: { cookie() {}, clearCookie() {} },
        user,
        authSession: null,
        authFailureReason: null,
        ...extra,
      });
      const admin = { id: 1, username: "root", role: "admin" };
      const tenant = { id: 2, username: "tenant", role: "user" };

      await app.createCaller(ctxOf(admin)).saveSettings({ smtpHost: "smtp.example.com", emailPassword: "hunter2", nested: { apiKey: "sk-123", label: "x" } });
      await assert.rejects(() => app.createCaller(ctxOf(tenant)).saveSettings({ smtpHost: "h", emailPassword: "p" }), /permission|FORBIDDEN|管理员/);
      await assert.rejects(() => app.createCaller(ctxOf(null)).saveSettings({ smtpHost: "h", emailPassword: "p" }));
      await assert.rejects(() => app.createCaller(ctxOf(admin)).broken());
      assert.equal(await app.createCaller(ctxOf(admin)).outer(), "inner");
      await app.createCaller(ctxOf(admin)).changeRule({ id: 5 });
      assert.equal(await app.createCaller(ctxOf(admin)).spawnLoop(), "spawned");
      releaseLoop();
      assert.equal(await loopWork, true);
      assert.equal(await app.createCaller(ctxOf(tenant)).mine(), "ok");
      assert.equal(await app.createCaller(ctxOf(admin)).peek(), 1);
      assert.equal(await app.createCaller(ctxOf(admin)).diagnostics.start(), "started");
      // 只读令牌想改设置：被令牌策略拒掉，也记成「被拒绝」，带上令牌名
      await assert.rejects(() => app.createCaller(ctxOf(admin, { apiToken: { id: 9, name: "ci", scope: "read" } })).saveSettings({ smtpHost: "h", emailPassword: "p" }));
      await audit.drainOperationAuditWrites();

      const reader = auditRouter.createCaller(ctxOf(admin));
      const all = (await reader.list()).items;
      const paths = all.map((item) => item.path + ":" + item.result).sort();
      assert.deepEqual(paths, [
        "broken:error", "changeRule:ok", "changeRule:ok", "mine:ok", "outer:ok",
        "saveSettings:denied", "saveSettings:denied", "saveSettings:ok", "spawnLoop:ok",
      ]);
      const ok = all.find((item) => item.path === "saveSettings" && item.result === "ok");
      assert.equal(ok.actorName, "root");
      assert.equal(ok.actorRole, "admin");
      assert.equal(ok.ip, "203.0.113.9");
      assert.equal(ok.userAgent, "audit-test/1.0");
      assert.equal(ok.channel, "web");
      // 列表不带参数（最长 4 KB，列表用不到）；详情里是打过码的参数
      assert.equal("input" in ok, false);
      const okDetail = await reader.detail({ id: ok.id });
      assert.equal(okDetail.event.input.smtpHost, "smtp.example.com");
      assert.equal(okDetail.event.input.emailPassword, "[已隐藏]");
      assert.equal(okDetail.event.input.nested.apiKey, "[已隐藏]");
      assert.equal(okDetail.event.input.nested.label, "x");
      assert.equal(JSON.stringify(okDetail).includes("hunter2"), false);
      assert.equal(JSON.stringify(okDetail).includes("sk-123"), false);
      const tokenDenied = all.find((item) => item.apiTokenName === "ci");
      assert.equal(tokenDenied.result, "denied");
      assert.equal(tokenDenied.channel, "api");
      assert.equal(tokenDenied.apiTokenId, 9);
      const broken = all.find((item) => item.path === "broken");
      assert.equal(broken.errorCode, "BAD_REQUEST");
      assert.match(broken.errorMessage, /端口超出范围/);

      // 筛选
      assert.equal((await reader.list({ result: "denied" })).items.length, 2);
      assert.equal((await reader.list({ actorUserId: 2 })).items.length, 2);
      assert.equal((await reader.list({ module: "outer" })).items.length, 1);
      assert.equal((await reader.list({ search: "端口超出" })).items.length, 1);
      assert.equal((await reader.list({ search: "hunter2" })).items.length, 0);
      assert.equal((await reader.list({ search: "100%_" })).items.length, 0);
      const now = Math.floor(Date.now() / 1000);
      assert.equal((await reader.list({ sinceSeconds: now + 3600 })).items.length, 0);
      assert.equal((await reader.list({ untilSeconds: now + 3600 })).items.length, 9);
      const page1 = await reader.list({ limit: 3 });
      assert.equal(page1.items.length, 3);
      const page2 = await reader.list({ limit: 3, cursor: page1.nextCursor });
      assert.equal(page2.items.length, 3);
      assert.ok(page2.items[0].id < page1.items[2].id);

      // 配置审计用同一个 requestId，详情里带回字段差异
      const changes = all.filter((item) => item.path === "changeRule").sort((a, b) => a.id - b.id);
      const detail = await reader.detail({ id: changes[0].id });
      assert.equal(detail.configChanges.length, 1);
      assert.equal(detail.configChanges[0].resourceType, "forward_rule");
      assert.equal(detail.configChanges[0].resourceId, 5);
      assert.deepEqual(detail.configChanges[0].diff, { name: { before: "旧名字", after: "新名字" } });
      assert.equal(okDetail.configChanges.length, 0);
      // 后台循环里那次改动自己记一行、自己的 requestId，不挂到拉起它的 spawnLoop 名下
      const spawn = all.find((item) => item.path === "spawnLoop");
      assert.notEqual(changes[1].requestId, spawn.requestId);
      assert.deepEqual((await reader.detail({ id: changes[1].id })).configChanges.map((item) => item.resourceId), [6]);
      assert.equal((await reader.detail({ id: spawn.id })).configChanges.length, 0);
      await assert.rejects(() => reader.detail({ id: 999999 }), /不存在/);

      // 非管理员看不了审计
      await assert.rejects(() => auditRouter.createCaller(ctxOf(tenant)).list());

      // 筛选候选
      const facets = await reader.facets();
      assert.ok(facets.modules.some((item) => item.module === "saveSettings" && item.count === 3));
      assert.ok(facets.actors.some((item) => item.userId === 2 && item.name === "tenant"));

      // 保留天数：默认 90；改成 30（这次修改本身也记一行）；过期的行被清掉、新的留着
      assert.equal((await reader.settings()).retentionDays, 90);
      await audit.insertOperationAuditRow({
        actorUserId: 1, actorName: "root", actorRole: "admin", apiTokenId: null, apiTokenName: null, channel: "web",
        path: "users.update", module: "users", result: "ok", errorCode: null, errorMessage: null, inputJson: null,
        ip: null, userAgent: null, requestId: "old", durationMs: 1, createdAt: now - 45 * 86400,
      });
      assert.equal((await reader.setRetention({ days: 30 })).retentionDays, 30);
      await assert.rejects(() => reader.setRetention({ days: 3 }));
      await audit.drainOperationAuditWrites();
      // 中间件记的 9 条 + 手插的一条过期行 + 改保留天数成功的一条 + 填了 3 天被参数校验拒掉的一条（登录管理员的失败尝试也要留痕）
      assert.equal((await reader.list()).items.length, 12);
      assert.equal((await reader.list({ module: "setRetention", result: "error" })).items.length, 1);
      await audit.pruneOperationAuditEvents();
      const after = (await reader.list()).items;
      assert.equal(after.length, 11);
      assert.equal(after.some((item) => item.requestId === "old"), false);
      assert.ok(after.some((item) => item.path === "setRetention"));

      // 跳过名单里的每个名字都要是真实存在的 mutation（过程改名后这里会报出旧名字）
      const { appRouter } = await import(url("server/routers.ts"));
      const procedures = appRouter._def.procedures;
      for (const name of audit.OPERATION_AUDIT_SKIPPED_PATHS) {
        assert.ok(procedures[name], name + " 不存在");
        assert.equal(procedures[name]._def.type, "mutation", name + " 不是 mutation");
      }
      // 审计页自己的读接口不该被跳过名单之外的东西误伤：真实路由上 ops.audit.setRetention 存在
      assert.equal(procedures["ops.audit.setRetention"]._def.type, "mutation");
      console.log("OK");
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "operation-audit.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
