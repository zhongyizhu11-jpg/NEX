import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createForwardxUpstreamSqlite } from "./forwardxMigration.fixture";

/*
  从原版 ForwardX 迁到 NEX（server/forwardxMigration.ts + forwardxMigrationCli.ts），真跑一遍：
  按原版 2.3.299 的表结构建 SQLite 库 → 命令行导进一个全新的 NEX 库 → 直接开库看结果；
  再拿导出来的库起心跳路由，看原版 Agent 会不会被自动换成 NEX 的 Agent。
*/
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "server", "forwardxMigrationCli.ts");
const JWT_SECRET = "f".repeat(64);

function sha256(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, JWT_SECRET, DATABASE_TYPE: "", DATABASE_CONFIG_PATH: "/nonexistent/database.json", ...env },
    timeout: 180_000,
  });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-forwardx-migrate-"));
  const source = path.join(dir, "forwardx.db");
  createForwardxUpstreamSqlite(source);
  return { dir, source, target: path.join(dir, "nex", "forwardx.db.nex-import") };
}

test("原版 2.3.299 的 SQLite 库：只读导进全新的 NEX 库，能换算的换算，不迁的写进报告", () => {
  const { dir, source, target } = sandbox();
  try {
    const before = sha256(source);
    const inspect = runCli(["inspect", "--source-sqlite", source, "--json"]);
    assert.equal(inspect.status, 0, inspect.stderr);
    const inspection = JSON.parse(inspect.stdout);
    assert.equal(inspection.isForwardx, true);
    assert.deepEqual(inspection.counts, { users: 2, hosts: 2, forwardRules: 2, tunnels: 1, forwardGroups: 0 });

    const reportFile = path.join(dir, "report.json");
    const result = runCli(["import", "--source-sqlite", source, "--target-sqlite", target, "--report", reportFile, "--json"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    assert.equal(output.success, true);
    assert.equal(output.import.mode, "restore");
    assert.equal(output.import.skippedRows, 0, `导入时不该有被跳过的行：${JSON.stringify(output.import.skipped)}\n${result.stderr.split("\n").filter((line) => line.includes("[Migration] skipped")).join("\n")}`);
    assert.equal(sha256(source), before, "原版的库一个字节都不能改");

    const tables = new Map(output.report.tables.map((item: any) => [item.table, item]));
    assert.equal((tables.get("support_tickets") as any)?.status, "converted");
    assert.equal((tables.get("affiliate_referrals") as any)?.target, "users.inviterId");
    assert.equal((tables.get("plugins") as any)?.status, "skipped");
    assert.equal((tables.get("support_ticket_attachments") as any)?.status, "skipped");
    assert.ok(!output.report.droppedColumns.some((item: any) => item.table === "tunnels" && item.column.startsWith("v3")), "NEX 也有 V3 了，原版的 v3 列照迁");
    assert.ok(output.report.skippedSettings.includes("runtimeCache:exitPort:3"));
    assert.ok(output.report.skippedSettings.includes("panelMigrationPhase"));
    assert.ok(output.report.warnings.some((warning: string) => /迁成 NEX V3/.test(warning)));
    assert.ok(output.report.warnings.some((warning: string) => /推广账户/.test(warning)));

    // 先看文件：WAL 已并回主文件，脚本只用挪一个文件（下面只读打开以后 SQLite 自己会再建 -wal / -shm）
    assert.equal(fs.existsSync(`${target}-wal`), false, "WAL 已并回主文件");
    const nex = new Database(target, { readonly: true });
    try {
      const all = (sql: string) => nex.prepare(sql).all() as any[];
      const users = all("SELECT id, username, googleSub, inviterId FROM users ORDER BY username");
      const admin = users.find((user) => user.username === "admin");
      const alice = users.find((user) => user.username === "alice");
      assert.ok(admin && alice);
      assert.equal(alice.googleSub, "google-sub-alice", "googleSubject → googleSub");
      assert.equal(alice.inviterId, admin.id, "推广关系 → 邀请人");

      const hosts = all('SELECT id, "agentToken", "agentDistribution", "agentUpgradeRequested", "isOnline", "ddnsValueMode" FROM hosts ORDER BY id');
      assert.deepEqual(hosts.map((host) => [host.id, host.agentToken, host.agentDistribution, host.agentUpgradeRequested, host.isOnline]), [
        [10, "tok-entry", "forwardx", 0, 0],
        [11, "tok-exit", "forwardx", 0, 0],
      ], "主机 ID 和 Agent 令牌原样保留，先记成原版的 Agent、运行状态清零");
      assert.equal(hosts[0].ddnsValueMode, "primary");

      const rules = all('SELECT id, "hostId", "tunnelId", "userId", "isRunning" FROM forward_rules ORDER BY id');
      assert.deepEqual(rules.map((rule) => [rule.id, rule.hostId, rule.tunnelId, rule.userId, rule.isRunning]), [
        [100, 10, null, alice.id, 0],
        [101, 10, 3, alice.id, 0],
      ]);
      const tunnelColumns = (nex.prepare("PRAGMA table_info(tunnels)").all() as any[]).map((column) => column.name);
      assert.ok(tunnelColumns.includes("v3Transport"));
      const [tunnel] = all('SELECT "forwardxVersion", "v3Transport", "v3Path", "v3Multiplex" FROM tunnels');
      assert.deepEqual([tunnel.forwardxVersion, tunnel.v3Transport, tunnel.v3Path, tunnel.v3Multiplex], ["v3", "ws", "/fxp", 1], "原版的 V3 隧道迁成 NEX V3；多路复用空着按原版的默认（开）");
      assert.equal(all("SELECT COUNT(*) AS n FROM tunnels")[0].n, 1);

      const settings = new Map(all("SELECT key, value FROM system_settings").map((row) => [row.key, row.value]));
      assert.equal(settings.get("panelPublicUrl"), "https://panel.example.com", "面板地址保留（Agent 连的就是它）");
      assert.equal(settings.get("siteName"), "我的转发");
      assert.match(String(settings.get("emailPassword")), /^enc:v1:/, "原版明文存的密钥类设置，导进来加密");
      assert.equal(settings.has("runtimeCache:exitPort:3"), false);
      assert.equal(settings.has("panelMigrationPhase"), false);
      assert.equal(JSON.parse(String(settings.get("forwardxAgentMigration"))).enabled, true, "开着「原版 Agent 自动换成 NEX」");
      assert.equal(settings.get("databaseType"), "sqlite");
      assert.equal(settings.get("sqlitePath"), path.join(dir, "nex", "forwardx.db"), "记的是挪到位以后的正式路径");

      const [ticket] = all("SELECT * FROM tickets");
      assert.equal(ticket.userId, alice.id);
      assert.equal(ticket.status, "waiting_user");
      assert.equal(ticket.priority, "high", "urgent → high");
      assert.equal(ticket.lastMessageByStaff, 1);
      const messages = all('SELECT "senderId", "isStaff", content FROM ticket_messages ORDER BY id');
      assert.deepEqual(messages.map((message) => [message.senderId, message.isStaff, message.content]), [
        [alice.id, 0, "从昨天开始不通"],
        [admin.id, 1, "请再试一次"],
      ], "内部备注不迁");

      const [probe] = all('SELECT method, "targetIp", "httpTimeoutSeconds", "httpExpectedStatus" FROM host_probe_services');
      assert.deepEqual([probe.method, probe.targetIp, probe.httpTimeoutSeconds, probe.httpExpectedStatus], ["http", "https://example.com/health", 8, "204"]);
      const [metric] = all('SELECT "loadAvg1", "loadAvg5", "loadAvg15" FROM host_metrics');
      assert.deepEqual([metric.loadAvg1, metric.loadAvg5, metric.loadAvg15], [1, 2, 3]);
      assert.equal(all("SELECT COUNT(*) AS n FROM plugins")[0].n, 0, "插件不迁");
    } finally {
      nex.close();
    }

    // 再跑一次：目标已经存在，拒绝（不往有数据的库里合并）
    const again = runCli(["import", "--source-sqlite", source, "--target-sqlite", target, "--json"]);
    assert.equal(again.status, 4, again.stderr);
    assert.match(again.stderr, /目标文件已经存在/);
    // 拿 NEX 的库当来源：认出来不是原版
    const nexAsSource = runCli(["import", "--source-sqlite", target, "--target-sqlite", path.join(dir, "other.db"), "--json"]);
    assert.equal(nexAsSource.status, 3, nexAsSource.stderr);
    assert.match(nexAsSource.stderr, /已经是 NEX 的数据库/);
    const inspectNex = runCli(["inspect", "--source-sqlite", target]);
    assert.equal(inspectNex.status, 3);
    assert.match(inspectNex.stdout, /不用迁移/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("来源配置：按原版的顺序找库，备份目录 / 容器挂载可以改路径", () => {
  const { dir, source, target } = sandbox();
  try {
    // 原版 database.json 里写的是部署时的路径（/data/forwardx.db），实际文件在备份目录里
    const config = path.join(dir, "database.json");
    fs.writeFileSync(config, JSON.stringify({ type: "sqlite", sqlite: { path: "/data/forwardx.db" } }));
    const mapped = runCli(["inspect", "--source-config", config, "--map-path", `/data=${dir}`, "--json"]);
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.equal(JSON.parse(mapped.stdout).source, `SQLite ${source}`);
    // 没有 database.json：看 .env 里的 SQLITE_PATH
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, `SQLITE_PATH=/data/forwardx.db\nJWT_SECRET=x\n`);
    const fromEnv = runCli(["inspect", "--source-config", path.join(dir, "missing.json"), "--source-env-file", envFile, "--map-path", `/data=${dir}`, "--json"]);
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(JSON.parse(fromEnv.stdout).source, `SQLite ${source}`);
    // 参数写错
    assert.equal(runCli(["import", "--source-sqlite", source]).status, 2);
    assert.equal(runCli(["inspect", "--map-path", "nonsense"]).status, 2);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁过来的原版 Agent：心跳自动排升级换成 NEX；版本号再高也要等它报 nex 才算完成", () => {
  const { dir, source, target } = sandbox();
  try {
    const imported = runCli(["import", "--source-sqlite", source, "--target-sqlite", target, "--json"]);
    assert.equal(imported.status, 0, imported.stderr);
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
      const { AGENT_VERSION, FXP_RUNTIME_VERSION } = await import(url("shared/versions.ts"));
      const query = (sql, params = []) => runtime.queryRaw(sql, params);
      const express = (await import("express")).default;
      const route = await import(url("server/agentHeartbeatRoute.ts"));
      const gate = await import(url("server/agentHeartbeatGate.ts"));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      route.registerAgentHeartbeatRoute(app);
      const server = http.createServer(app);
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const heartbeat = async (extra) => {
        gate.agentStableHeartbeatPlanCache.invalidate(10);
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer tok-entry" },
          body: JSON.stringify({ uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true, ...extra }),
        });
        const body = await response.json();
        if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
        return body;
      };
      const host = async () => (await query('SELECT "agentDistribution" AS d, "agentUpgradeRequested" AS r, "agentUpgradeTargetVersion" AS v, "agentUpgradeTargetDistribution" AS td FROM hosts WHERE id = 10'))[0];
      try {
        // 原版 Agent，版本号比 NEX 的还高：照样排升级，目标是 NEX 自带的 Agent 版本
        const first = await heartbeat({ agentVersion: "2.9.999", fxpVersion: FXP_RUNTIME_VERSION });
        assert.equal(first.agentUpgrade?.targetVersion, AGENT_VERSION, JSON.stringify(first.agentUpgrade));
        let row = await host();
        assert.equal(row.d, "forwardx");
        assert.equal(Number(row.r), 1);
        assert.equal(row.td, "nex");
        // 版本号够了也不算完成：还是原版的 Agent
        const second = await heartbeat({ agentVersion: "2.9.999", fxpVersion: FXP_RUNTIME_VERSION });
        assert.equal(second.agentUpgrade?.targetVersion, AGENT_VERSION);
        assert.equal(Number((await host()).r), 1);
        // 换上了 NEX 的 Agent：报 nex，升级完成
        await heartbeat({ agentVersion: AGENT_VERSION, agentDistribution: "nex", fxpVersion: FXP_RUNTIME_VERSION, agentCapabilities: [], runtimeVersion: "3.2.6-nex3" });
        row = await host();
        assert.equal(row.d, "nex");
        assert.equal(Number(row.r), 0);
        assert.equal(row.td, null);
        // 之后的精简心跳（什么都没带）不改结论、不再排升级
        const later = await heartbeat({});
        assert.equal(later.agentUpgrade ?? null, null);
        assert.equal((await host()).d, "nex");
        // 密钥类设置用面板的 JWT 密钥（和迁移时同一把）解得开
        const settings = await import(url("server/repositories/settingsRepository.ts"));
        assert.equal(await settings.getSetting("emailPassword"), "smtp-secret");
      } finally {
        server.close();
      }
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, JWT_SECRET, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: target, SQLITE_PATH: target },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
