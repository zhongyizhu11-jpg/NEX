import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 一键故障包：权限和网页「诊断」一样，配置脱敏，沿线主机只给主人 / 管理员看细节。 */
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fault-bundle-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "db.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let bundle: typeof import("./faultBundle");
let llms: typeof import("./llmsTxt");

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  bundle = await import("./faultBundle");
  llms = await import("./llmsTxt");
  const exec = (sql: string, params: unknown[] = []) => runtime.executeRaw(sql, params);
  await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'bob', 'h', 'user'), (3, 'eve', 'h', 'user')");
  await exec('INSERT INTO hosts (id, name, ip, "userId", "isOnline", "agentVersion", "agentToken") VALUES (1, ?, ?, 1, 1, ?, ?)', ["香港入口", "10.0.0.1", "2.2.230", "agent-secret-token"]);
  await exec('INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled") VALUES (7, 1, ?, ?, ?, 10007, ?, 443, 2, 1)', ["bob 的规则", "gost", "tcp", "example.com"]);
});

after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

const ctx = (id: number, role: "admin" | "user") => ({ user: { id, role } });

test("主人能打包自己的规则：有面板侧结论、规则配置；别人的主机只给名字", async () => {
  const result = await bundle.buildFaultBundle(ctx(2, "user"), { kind: "rule", id: 7 }) as any;
  assert.equal(result.kind, "nex.fault-bundle");
  assert.equal(result.subject.name, "bob 的规则");
  assert.ok(Array.isArray(result.panelChecks.items) && result.panelChecks.items.length > 0, "有面板侧检查项");
  assert.equal(result.resource.targetIp, "example.com");
  const host = result.hosts.find((item: any) => item.id === 1);
  assert.equal(host.name, "香港入口");
  assert.equal(host.agentVersion, undefined, "不是自己的主机，不给版本等细节");
  assert.equal(result.events, undefined, "普通用户没有主机事件");
  assert.equal(result.configHistory, undefined);
  assert.ok(!JSON.stringify(result).includes("agent-secret-token"));
});

test("管理员看得到主机细节、事件、配置变更；令牌类字段抹掉", async () => {
  const result = await bundle.buildFaultBundle(ctx(1, "admin"), { kind: "rule", id: 7 }) as any;
  const host = result.hosts.find((item: any) => item.id === 1);
  assert.equal(host.agentVersion, "2.2.230");
  assert.ok(Array.isArray(result.events));
  assert.ok(Array.isArray(result.configHistory));
  assert.ok(!JSON.stringify(result).includes("agent-secret-token"));
  assert.match(bundle.faultBundleFilename({ kind: "rule", id: 7 }, new Date("2026-10-18T01:02:03Z")), /^nex-fault-rule-7-20261018010203\.json$/);
});

test("别人的规则打包不了", async () => {
  await assert.rejects(() => bundle.buildFaultBundle(ctx(3, "user"), { kind: "rule", id: 7 }), /无权/);
  await assert.rejects(() => bundle.buildFaultBundle(ctx(1, "admin"), { kind: "tunnel", id: 999 }), /不存在/);
});

test("llms.txt：写清楚 MCP 地址、令牌位置和每个工具，不含面板数据", async () => {
  const text = llms.buildLlmsTxt("https://panel.example.com");
  assert.match(text, /https:\/\/panel\.example\.com\/mcp/);
  assert.match(text, /API 令牌/);
  for (const name of ["get_fault_bundle", "list_rules", "diagnose_rule", "get_fault_board"]) assert.ok(text.includes(`\`${name}\``), name);
  assert.match(text, /`diagnose_rule`（会改动/);
  assert.ok(!text.includes("香港入口"));
});
