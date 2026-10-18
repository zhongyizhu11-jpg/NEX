import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  pickAutoUnlockLanding,
  resolveInboundRoutes,
  routingLandingUsableBy,
  type RoutingContext,
  type RoutingLandingCandidate,
  type RoutingOwner,
} from "./inboundRoutingRuntime";

const candidate = (patch: Partial<RoutingLandingCandidate>): RoutingLandingCandidate => ({
  inboundId: 1,
  inboundName: "ss",
  ownerId: 1,
  landingEgress: false,
  enabled: true,
  hostId: 10,
  hostName: "落地",
  hostUserId: 1,
  online: true,
  server: "203.0.113.10",
  port: 20000,
  method: "aes-256-gcm",
  password: "pw",
  ...patch,
});

const admin: RoutingOwner = { id: 1, role: "admin", allowedHostIds: new Set() };
const bob: RoutingOwner = { id: 2, role: "user", allowedHostIds: new Set([12]) };

function context(candidates: RoutingLandingCandidate[], unlock: Record<number, Record<string, [string, number]>>): RoutingContext {
  return {
    candidates,
    unlock: new Map(Object.entries(unlock).map(([hostId, services]) => [
      Number(hostId),
      new Map(Object.entries(services).map(([id, [status, checkedAt]]) => [id, { status, checkedAt }])),
    ])),
  };
}

test("谁能用哪台落地：和规则的 SS 出口同一套", () => {
  assert.ok(routingLandingUsableBy(admin, candidate({ ownerId: 9 })));
  assert.ok(routingLandingUsableBy(bob, candidate({ ownerId: 2 })), "自己的");
  assert.ok(!routingLandingUsableBy(bob, candidate({ ownerId: 9, hostId: 12 })), "别人的普通落地不行");
  assert.ok(routingLandingUsableBy(bob, candidate({ ownerId: 9, hostId: 12, landingEgress: true })), "管理员开放的落地出口 + 有主机权限");
  assert.ok(!routingLandingUsableBy(bob, candidate({ ownerId: 9, hostId: 13, landingEgress: true })), "没有主机权限");
});

test("自动挑：每个服务都可用、在线、不是自己；几台都行挑最近检测的，结果稳定", () => {
  const ctx = context([
    candidate({ inboundId: 1, hostId: 10, hostName: "港" }),
    candidate({ inboundId: 2, hostId: 11, hostName: "美西" }),
    candidate({ inboundId: 3, hostId: 12, hostName: "日本" }),
    candidate({ inboundId: 4, hostId: 13, hostName: "新加坡", online: false }),
    candidate({ inboundId: 5, hostId: 20, hostName: "自己" }),
  ], {
    10: { netflix: ["blocked", 100], chatgpt: ["ok", 100] },
    11: { netflix: ["ok", 200], chatgpt: ["partial", 200] },
    12: { netflix: ["ok", 150], chatgpt: ["ok", 150] },
    13: { netflix: ["ok", 900], chatgpt: ["ok", 900] },
    20: { netflix: ["ok", 999], chatgpt: ["ok", 999] },
  });
  assert.equal(pickAutoUnlockLanding({ presets: ["netflix"] }, ctx, admin, 20)?.hostName, "美西", "最近检测的那台");
  assert.equal(pickAutoUnlockLanding({ presets: ["netflix", "chatgpt"] }, ctx, admin, 20)?.hostName, "日本", "两个服务都要可用");
  assert.equal(pickAutoUnlockLanding({ presets: ["claude"] }, ctx, admin, 20), null, "没测过 = 不算解锁");
  assert.equal(pickAutoUnlockLanding({ presets: ["netflix"] }, ctx, bob, 20), null, "bob 一台都用不了");
});

test("解析：直连 / 拒绝原样；点名的落地失效就拒绝，不退回直连；自动挑不出来就直连", () => {
  const ctx = context([
    candidate({ inboundId: 1, hostId: 10, hostName: "港", inboundName: "出口" }),
    candidate({ inboundId: 2, hostId: 11, hostName: "美西", enabled: false }),
    candidate({ inboundId: 3, hostId: 12, hostName: "离线机", online: false }),
  ], { 10: { netflix: ["ok", 100] } });
  const routes = resolveInboundRoutes({
    routes: [
      { presets: [], domains: ["a.com"], target: "direct", landingInboundId: 0 },
      { presets: [], domains: ["b.com"], target: "block", landingInboundId: 0 },
      { presets: [], domains: ["c.com"], target: "landing", landingInboundId: 1 },
      { presets: [], domains: ["d.com"], target: "landing", landingInboundId: 2 },
      { presets: [], domains: ["e.com"], target: "landing", landingInboundId: 99 },
      { presets: [], domains: ["f.com"], target: "landing", landingInboundId: 3 },
      { presets: ["netflix"], domains: [], target: "auto_unlock", landingInboundId: 0 },
      { presets: ["chatgpt"], domains: [], target: "auto_unlock", landingInboundId: 0 },
    ],
  }, ctx, admin, 20);
  assert.deepEqual(routes.map((route) => route.action), ["direct", "block", "shadowsocks", "block", "block", "shadowsocks", "shadowsocks", "direct"]);
  assert.deepEqual(routes[2].egress, { server: "203.0.113.10", port: 20000, method: "aes-256-gcm", password: "pw" });
  assert.match(routes[3].note, /已停用/);
  assert.match(routes[4].note, /已被删除/);
  assert.match(routes[5].note, /离线/, "离线照样指过去，提示一下");
  assert.match(routes[6].note, /自动选了「港 · 出口」/);
  assert.ok(routes[6].domainSuffix.includes("netflix.com"));
  assert.match(routes[7].note, /暂时直连/);
  const self = resolveInboundRoutes({ routes: [{ presets: [], domains: ["x.com"], target: "landing", landingInboundId: 1 }] }, ctx, admin, 10);
  assert.equal(self[0].action, "block", "点名的落地就是自己：拒绝");
});

/**
 * 真库走一遍：入站存分流 → 心跳解析（查 SS 落地、主机、解锁检测）→ 保存校验 → 删除保护的依据。
 */
test("分流在 SQLite 上：心跳按最新检测挑出口，保存时拦掉别人的落地", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-inbound-routing-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    console.info = () => {};
    console.warn = () => {};
    const routing = await import(url("server/inboundRoutingRuntime.ts"));
    const unlock = await import(url("server/ops/unlock.ts"));
    const repo = await import(url("server/repositories/proxyInboundRepository.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const now = new Date();
    await exec("INSERT INTO users (id, username, password, role, \"allowProxySubscription\") VALUES (1, 'admin', 'x', 'admin', 1), (2, 'bob', 'x', 'user', 1)");
    await exec('INSERT INTO hosts (id, name, ip, "userId", "isOnline", "lastHeartbeat") VALUES (1, ?, ?, 1, 1, ?), (2, ?, ?, 1, 1, ?), (3, ?, ?, 1, 1, ?)',
      ["入口落地", "198.51.100.1", now, "美西", "198.51.100.2", now, "日本", "198.51.100.3", now]);
    const inbound = (id, hostId, userId, extra = {}) => exec(
      'INSERT INTO proxy_inbounds (id, "userId", "hostId", name, protocol, port, transport, security, method, password, "landingEgress", "routingJson") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, userId, hostId, extra.name || ("ss-" + id), "shadowsocks", 20000 + id, "tcp", "none", "aes-256-gcm", "pw" + id, extra.landingEgress ? 1 : 0, extra.routingJson || null],
    );
    const auto = JSON.stringify({ routes: [{ presets: ["netflix"], domains: [], target: "auto_unlock" }] });
    await inbound(1, 1, 1, { name: "主节点", routingJson: auto });
    await inbound(2, 2, 1, { name: "美西出口" });
    await inbound(3, 3, 1, { name: "日本出口" });
    await inbound(4, 1, 2, { name: "bob 的节点" });

    const resolve = async () => {
      routing.invalidateInboundRoutingContext();
      const rows = await repo.getEnabledProxyInboundsWithUsersByHost(1);
      return routing.resolveHostInboundRoutes(1, rows);
    };
    let routes = await resolve();
    assert.equal(routes.get(1)[0].action, "direct", "还没有检测结果：直连");
    assert.equal(routes.has(4), false, "没设分流的入站不在里面");

    const result = (status) => [{ service: "netflix", status, region: "US", detail: "", ms: 1 }];
    await unlock.recordUnlockRun({ hostId: 2, family: "auto", runId: "a", trigger: "manual", requestedBy: 1, checkedAt: 1000, results: result("ok") });
    await unlock.recordUnlockRun({ hostId: 3, family: "auto", runId: "b", trigger: "manual", requestedBy: 1, checkedAt: 900, results: result("blocked") });
    routes = await resolve();
    assert.equal(routes.get(1)[0].action, "shadowsocks");
    assert.deepEqual(routes.get(1)[0].egress, { server: "198.51.100.2", port: 20002, method: "aes-256-gcm", password: "pw2" });

    // 美西不解锁了、日本解锁了：下一次心跳换过去
    await unlock.recordUnlockRun({ hostId: 2, family: "auto", runId: "c", trigger: "schedule", requestedBy: null, checkedAt: 2000, results: result("blocked") });
    await unlock.recordUnlockRun({ hostId: 3, family: "auto", runId: "d", trigger: "schedule", requestedBy: null, checkedAt: 2000, results: result("ok") });
    routes = await resolve();
    assert.equal(routes.get(1)[0].egress.server, "198.51.100.3");

    // 保存校验：bob 不能点名管理员的普通落地；管理员开放的落地出口 + 主机权限才行
    await assert.rejects(
      () => routing.validateInboundRoutingForSave({ routes: [{ presets: ["netflix"], domains: [], target: "landing", landingInboundId: 2 }] }, { ownerId: 2, hostId: 1 }),
      /用不了/,
    );
    await assert.rejects(
      () => routing.validateInboundRoutingForSave({ routes: [{ presets: [], domains: ["a.com"], target: "landing", landingInboundId: 4 }] }, { ownerId: 1, hostId: 1 }),
      /就是这台机器/,
    );
    await assert.rejects(
      () => routing.validateInboundRoutingForSave({ routes: [{ presets: [], domains: ["bad domain"], target: "direct" }] }, { ownerId: 1, hostId: 1 }),
      /不是域名/,
    );
    const saved = await routing.validateInboundRoutingForSave({ routes: [{ presets: ["chatgpt"], domains: [], target: "landing", landingInboundId: 3 }] }, { ownerId: 1, hostId: 1 });
    assert.equal(saved.routes[0].landingInboundId, 3);
    assert.equal(await routing.validateInboundRoutingForSave({ routes: [] }, { ownerId: 1, hostId: 1 }), null);

    // 删除保护的依据：点名用它的入站
    await exec('UPDATE proxy_inbounds SET "routingJson" = ? WHERE id = 1', [JSON.stringify(saved)]);
    assert.deepEqual((await routing.getInboundsRoutingVia(3)).map((row) => Number(row.id)), [1]);
    assert.deepEqual(await routing.getInboundsRoutingVia(2), []);

    // 列表上的状态
    routing.invalidateInboundRoutingContext();
    const status = await routing.describeInboundRoutingStatus([{ id: 1, userId: 1, hostId: 1, routingJson: JSON.stringify(saved) }]);
    assert.match(status.get(1)[0].note, /日本 · 日本出口/);
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "routing.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
