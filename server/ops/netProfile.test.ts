import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MIGRATION_TABLES } from "../dbSchema";
import { AGENT_TUNNEL_PATHS } from "../agentEncryptionMiddleware";
import { DNSBL_QUERY_REFUSED } from "../../shared/netProfile";
import { dnsblAddressForHost, queryDnsblFromPanel } from "./netProfile";
import { OPS_MIGRATION_TABLES, OPS_TABLE_DEFS } from "./opsTables";

test("网络画像表：建表定义在、跟着迁移走、旧库缺表不算错", () => {
  const def = OPS_TABLE_DEFS.find((table) => table.name === "host_network_profiles");
  assert.ok(def, "host_network_profiles 要交给 dbSchema 建表");
  assert.deepEqual(def.unique, [["hostId"]]);
  assert.ok(OPS_MIGRATION_TABLES.includes("host_network_profiles"));
  assert.ok((MIGRATION_TABLES as readonly string[]).includes("host_network_profiles"));
  const migrationSource = fs.readFileSync(path.join(process.cwd(), "server/migration.ts"), "utf8");
  const optional = migrationSource.slice(migrationSource.indexOf("DIRECT_SQLITE_OPTIONAL_SOURCE_TABLES = new Set(["));
  assert.ok(optional.slice(0, optional.indexOf("]);")).includes('"host_network_profiles"'), "老面板的 SQLite 里没有这张表，直接搬库时不能报错");
  // 走扩展通道，不新开上报路径
  assert.ok(AGENT_TUNNEL_PATHS.has("/api/agent/ext"));
});

test("面板兜底查 DNSBL：反写地址、读应答、错误不当列入", async () => {
  const asked: string[] = [];
  const entries = await queryDnsblFromPanel("203.0.113.7", async (name) => {
    asked.push(name);
    if (name.endsWith("zen.spamhaus.org")) return ["127.255.255.254"];
    if (name.endsWith("bl.spamcop.net")) return ["127.0.0.2"];
    if (name.endsWith("b.barracudacentral.org")) throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    throw Object.assign(new Error("queryA ESERVFAIL"), { code: "ESERVFAIL" });
  });
  assert.ok(asked.every((name) => name.startsWith("7.113.0.203.")));
  const byList = Object.fromEntries(entries.map((entry) => [entry.list, entry]));
  assert.equal(byList["zen.spamhaus.org"].listed, false);
  assert.equal(byList["zen.spamhaus.org"].error, DNSBL_QUERY_REFUSED);
  assert.deepEqual(byList["bl.spamcop.net"], { list: "bl.spamcop.net", listed: true, code: "127.0.0.2", error: null });
  assert.deepEqual(byList["b.barracudacentral.org"], { list: "b.barracudacentral.org", listed: false, code: null, error: null });
  assert.match(byList["cbl.abuseat.org"].error || "", /ESERVFAIL/);

  assert.equal(dnsblAddressForHost({ ipv4: "10.0.0.5", ip: "9.9.9.9" }), "9.9.9.9", "内网地址跳过");
  assert.equal(dnsblAddressForHost({ ipv4: "9.9.9.9" }, { ipv4: { ok: true, address: "1.1.1.1" } } as any), "1.1.1.1", "优先 Agent 测到的出口");
  assert.equal(dnsblAddressForHost({ ipv4: "198.51.100.9" }), null, "文档保留段也不查");
  assert.equal(dnsblAddressForHost({ ipv6: "2001:db8::1" }), null);
});

test("扩展通道一轮：收结果、回执、重新检测、旧 Agent 只能面板查 DNSBL", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-netprofile-"));
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
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "agentVersion") VALUES (1, ?, ?, ?, ?, ?, 1, ?)', ["新", "203.0.113.7", "203.0.113.7", "slave", "tok1", "2.2.226"]);
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "agentVersion") VALUES (2, ?, ?, ?, ?, ?, 1, ?)', ["旧", "198.51.100.9", "198.51.100.9", "slave", "tok2", "2.2.224"]);

      const ext = await import(url("server/ops/agentExt.ts"));
      await import(url("server/ops/agentExtModules.ts"));
      const np = await import(url("server/ops/netProfile.ts"));
      const db = await import(url("server/db.ts"));
      const newHost = await db.getHostById(1);
      const oldHost = await db.getHostById(2);

      // 第一轮：没结果。指令里有 lastCheckedAt=0、默认列表；旧 Agent 不给指令
      let reply = await ext.handleAgentExtRound(newHost, { modules: {} });
      const directive = reply.modules.netprofile;
      assert.equal(directive.intervalSeconds, 21600);
      assert.equal(directive.lastCheckedAt, 0);
      assert.equal(directive.runId, "");
      assert.ok(directive.dnsbl.includes("zen.spamhaus.org"));
      assert.ok(directive.smtpTargets.includes("gmail-smtp-in.l.google.com:25"));
      reply = await ext.handleAgentExtRound(oldHost, { modules: {} });
      assert.equal(reply.modules.netprofile, undefined);

      // 「重新检测」：带 runId、让 Agent 5 秒一轮
      const runId = np.requestNetProfileRun(1);
      reply = await ext.handleAgentExtRound(newHost, { modules: {} });
      assert.equal(reply.modules.netprofile.runId, runId);
      assert.equal(reply.interval, 5);
      reply = await ext.handleAgentExtRound(newHost, { modules: { netprofile: { runId, running: true } } });
      assert.equal(np.netProfileRunState(1).running, true);

      // 定时那轮的结果碰巧这时候交上来：存下，但不算重新检测完成
      const now = Math.floor(Date.now() / 1000);
      const result = (checkedAt, resultId, extra = {}) => ({
        resultId, checkedAt,
        ipv4: { ok: true, address: "203.0.113.7", latencyMs: 30 },
        ipv6: { ok: false, error: "network is unreachable", configured: false },
        smtp25: { status: "timeout", detail: "都超时", targets: [] },
        dnsbl: [{ list: "bl.spamcop.net", listed: true, code: "127.0.0.2", answers: ["127.0.0.2"], notFound: false }],
        dnsblAddress: "203.0.113.7",
        ...extra,
      });
      reply = await ext.handleAgentExtRound(newHost, { modules: { netprofile: { runId: "", result: result(now - 100, "r1") } } });
      assert.equal(np.netProfileRunState(1).pending, true, "没带 runId 的结果不结束「重新检测」");
      assert.equal(reply.modules.netprofile.ackResultId, "r1", "同一轮就回执");
      assert.equal(reply.modules.netprofile.lastCheckedAt, now - 100);

      // 回执没送到、Agent 重发同一份：不重复记历史
      await ext.handleAgentExtRound(newHost, { modules: { netprofile: { runId: "", result: result(now - 100, "r1") } } });
      let stored = await np.getHostNetProfile(1);
      assert.equal(stored.history.length, 1);

      // 带 runId 的结果：重新检测完成；这次 Agent 没查 DNSBL，沿用上一次的
      reply = await ext.handleAgentExtRound(newHost, { modules: { netprofile: { runId, result: result(now, "r2", { dnsbl: [] }) } } });
      assert.equal(np.netProfileRunState(1).pending, false);
      assert.equal(reply.modules.netprofile.runId, "");
      assert.notEqual(reply.interval, 5);
      stored = await np.getHostNetProfile(1);
      assert.equal(stored.profile.checkedAt, now);
      assert.equal(stored.profile.smtp25.status, "timeout");
      assert.equal(stored.profile.dnsbl[0].listed, true, "上一次的 DNSBL 还在");
      assert.equal(stored.history.length, 2);
      assert.equal(stored.agentCheckedAt, now);

      // 路由：新 Agent 叫 Agent 测；旧 Agent 只能面板查 DNSBL（这里换成假的解析结果）
      const routerModule = await import(url("server/routers/netProfile.ts"));
      const caller = routerModule.netProfileRouter.createCaller({ user: { id: 1, role: "admin", username: "admin" }, req: { headers: {} }, res: { setHeader: () => {} } });
      const view = await caller.get({ hostId: 1 });
      assert.equal(view.supported, true);
      assert.equal(view.profile.ipv4.address, "203.0.113.7");
      await assert.rejects(caller.recheck({ hostId: 2, mode: "agent" }), /需要升级 Agent/);
      const oldView = await caller.get({ hostId: 2 });
      assert.equal(oldView.supported, false);
      assert.equal(oldView.profile, null);
      // 面板兜底只换 DNSBL 那一块
      await np.savePanelDnsbl(2, "198.51.100.9", [{ list: "zen.spamhaus.org", listed: false, code: null, error: null }]);
      const fallback = await np.getHostNetProfile(2);
      assert.equal(fallback.profile.dnsblSource, "panel");
      assert.equal(fallback.profile.ipv4, null);
      assert.equal(fallback.agentCheckedAt, null);

      // 探测服务的地址族：存下来，下发时只在不是 auto 时带上
      await db.createHostProbeService({ name: "v6", method: "tcping", targetIp: "example.com", targetPort: 443, addressFamily: "ipv6", hostScope: "all", userId: 1 });
      await db.createHostProbeService({ name: "lit", method: "tcping", targetIp: "1.1.1.1", targetPort: 443, addressFamily: "ipv6", hostScope: "all", userId: 1 });
      await db.createHostProbeService({ name: "auto", method: "ping", targetIp: "example.org", hostScope: "all", userId: 1 });
      const tasks = await db.getHostProbeTasksForHost(1);
      const byTarget = Object.fromEntries(tasks.map((task) => [task.targetIp, task]));
      assert.equal(byTarget["example.com"].family, "ipv6");
      assert.equal("family" in byTarget["1.1.1.1"], false, "IP 字面量存成 auto");
      assert.equal("family" in byTarget["example.org"], false);
      const services = await db.getHostProbeServices();
      assert.equal(services.find((s) => s.name === "lit").addressFamily, "auto");

      // 删主机时画像一起删
      await db.deleteHost(1);
      assert.equal((await np.getHostNetProfile(1)).profile, null);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
