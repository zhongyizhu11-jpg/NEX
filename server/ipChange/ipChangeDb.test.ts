import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 接上真库（SQLite）跑一遍：建表、SQL 仓库的读写、插件没开时接口拒绝、插件开了以后侧边栏入口指向核心页面、
 * 心跳里真的带上了自动换 IP 的探测任务（保留段 serviceId）。
 */
test("auto IP change against a real database: schema, repository, plugin gating, heartbeat delivery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ip-change-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import http from "node:http";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const { createSqlIpChangeStore } = await import(url("server/ipChange/repository.ts"));
      const { ipChangeRouter } = await import(url("server/routers/ipChange.ts"));
      const ipRuntime = await import(url("server/ipChange/runtime.ts"));
      const plugins = await import(url("server/repositories/pluginRepository.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));

      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, ipv4, hostType, agentToken, userId, isOnline, lastHeartbeat) VALUES (1, '港-1', '203.0.113.10', '203.0.113.10', 'slave', 'tok1', 1, 1, ?)", [Math.floor(Date.now() / 1000)]);

      // ── SQL 仓库 ──
      const store = createSqlIpChangeStore();
      const accountId = await store.createAccount({ name: "账号", provider: "webhook", credentialsJson: "enc:v1:xxx" });
      assert.equal((await store.getAccount(accountId)).name, "账号");
      await store.updateAccount(accountId, { name: "改名" });
      assert.equal((await store.listAccounts())[0].name, "改名");
      const saved = await store.upsertConfig(1, { enabled: true, cloudAccountId: accountId, target: { instanceId: "i-1" }, checkTargets: "a.cn:80\nb.cn:80" });
      assert.equal(saved.enabled, true);
      assert.equal(saved.failureThreshold, 5, "默认值来自表定义");
      assert.equal(saved.releaseOldIp, true);
      assert.deepEqual(saved.target, { instanceId: "i-1" });
      await store.updateConfig(1, { state: "changing", consecutiveFailures: 4, lastCheckAt: new Date(1_800_000_000_000) });
      const changed = await store.getConfig(1);
      assert.equal(changed.state, "changing");
      assert.equal(changed.consecutiveFailures, 4);
      assert.equal(changed.lastCheckAt.getTime(), 1_800_000_000_000);
      const start = new Date();
      const eventId = await store.insertEvent({ hostId: 1, trigger: "auto", provider: "webhook", oldIp: "203.0.113.10", newIp: null, ipRole: null, status: "running", error: null, notes: ["a"], startedAt: start, finishedAt: null });
      await store.insertEvent({ hostId: 1, trigger: "test", provider: "webhook", oldIp: null, newIp: null, ipRole: null, status: "succeeded", error: null, notes: [], startedAt: start, finishedAt: start });
      assert.equal(await store.countAttemptsSince(1, new Date(start.getTime() - 1000)), 1, "测试不算一次更换");
      assert.equal(Math.floor((await store.lastAttemptAt(1)).getTime() / 1000), Math.floor(start.getTime() / 1000));
      assert.equal(await store.markRunningEventsUncertain(null, "restart", new Date()), 1);
      const events = await store.listEvents({ hostId: 1, limit: 10, offset: 0 });
      assert.equal(events.total, 2);
      assert.equal(events.items.find((item) => item.id === eventId).status, "uncertain");
      assert.deepEqual(events.items.find((item) => item.id === eventId).notes, ["a"]);
      await store.updateConfig(1, { state: "idle", consecutiveFailures: 0 });

      // ── 插件没开：接口拒绝，详情卡片为空，心跳不带任务 ──
      const caller = ipChangeRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1", socket: {} },
        res: { cookie() {}, clearCookie() {} },
        user: { id: 1, role: "admin", username: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      const off = await caller.status();
      assert.equal(off.active, false);
      // 插件没开时也照实报云厂商数量（14 家：AWS EC2 / Lightsail、阿里云、腾讯云、华为云、火山引擎、GCP、OCI、Azure、DigitalOcean、Hetzner、Vultr、aws.sb、Webhook）
      assert.equal(off.providerCount, 14, "云厂商列表要全部注册");
      await assert.rejects(caller.hosts.list(), /插件/);
      await assert.rejects(caller.changeNow({ hostId: 1 }), /插件/);
      assert.equal(await caller.hostStatus({ hostId: 1 }), null);
      assert.deepEqual(await ipRuntime.getIpChangeProbeTasksForHost(1), []);

      // ── 装上并启用插件 ──
      await settings.setSetting("pluginsEnabled", "true");
      await plugins.installBundledPluginFromLocal({ bundledPath: "plugins/auto-ip-change" });
      await plugins.setPluginEnabled("auto-ip-change", true);
      const on = await caller.status();
      assert.equal(on.active, true);
      ipRuntime.invalidateAutoIpChangePluginStatus();
      const sidebar = await plugins.getEnabledPluginSidebarPages();
      assert.deepEqual(sidebar.map((page) => [page.pluginId, page.corePath]), [["auto-ip-change", "/ip-change"]], "默认显示入口，指向核心页面");
      const providers = await caller.providers();
      assert.equal(providers.length, 14);
      assert.deepEqual(providers.slice(0, 2).map((item) => item.id), ["aws-ec2", "aws-lightsail"]);
      // 给前端的只有表单定义，不带任何函数
      assert.ok(providers.every((item) => Array.isArray(item.credentialFields) && typeof item.changeIp === "undefined"));
      const rows = await caller.hosts.list();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hostName, "港-1");
      assert.equal(rows[0].accountName, "改名");
      assert.equal(rows[0].providerAvailable, true, "webhook 已注册");
      // 账号指向一个已经不存在（下线）的云厂商时：列表照常显示，但不能开自动更换
      const retiredAccountId = await store.createAccount({ name: "下线的厂商", provider: "retired-cloud", credentialsJson: "enc:v1:xxx" });
      await assert.rejects(caller.hosts.save({ hostId: 1, enabled: true, autoEnabled: true, cloudAccountId: retiredAccountId, target: {}, checkTargets: "a.cn:80", checkMethod: "tcp", failureThreshold: 5, checkIntervalSeconds: 60, cooldownMinutes: 30, maxChangesPerDay: 3, releaseOldIp: true }), /不可用/);
      await caller.hosts.save({ hostId: 1, enabled: true, autoEnabled: false, cloudAccountId: null, target: {}, checkTargets: "a.cn:80\nb.cn:443", checkMethod: "tcp", failureThreshold: 5, checkIntervalSeconds: 60, cooldownMinutes: 30, maxChangesPerDay: 3, releaseOldIp: true });
      assert.equal((await caller.hostStatus({ hostId: 1 })).state, "idle");
      const tasks = await ipRuntime.getIpChangeProbeTasksForHost(1);
      assert.deepEqual(tasks.map((task) => [task.serviceId, task.targetIp, task.targetPort]), [[2000000000, "a.cn", 80], [2000000001, "b.cn", 443]]);

      // ── 心跳里真的带上了 ──
      const express = (await import("express")).default;
      const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      heartbeat.registerAgentHeartbeatRoute(app);
      const server = http.createServer(app);
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const base = "http://127.0.0.1:" + server.address().port;
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok1" },
        body: JSON.stringify({ agentVersion: "2.2.195", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const services = body.hostProbeServices || [];
      assert.deepEqual(services.filter((item) => item.serviceId >= 2000000000).map((item) => item.targetIp), ["a.cn", "b.cn"], JSON.stringify(Object.keys(body)));
      server.close();
      await runtime.closeDatabase().catch(() => undefined);
      console.log("IP_CHANGE_DB_OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "ip-change.db"), NODE_ENV: "test", JWT_SECRET: "ip-change-test-secret-0123456789abcdef" },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /IP_CHANGE_DB_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
