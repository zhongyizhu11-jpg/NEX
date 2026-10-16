import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 共享 TLS 入站（SNI 分流）落到库里的那几条规矩：端口不能和别的监听撞、一个名字只能归一条规则
 * （暂停的也算）、白名单不能把已有规则挤出去、入站上有规则不能删、默认规则得是管理员的。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tls-inbound-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const db = await import(url("server/db.ts"));
      const service = await import(url("server/tlsInbounds.ts"));
      const shared = await import(url("shared/tlsInbound.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'bob', 'hash', 'user')");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId, agentVersion) VALUES (10, 'hk', '1.2.3.4', '1.2.3.4', 'tok', 1, '2.2.224')");

      const settings = (overrides = {}) => service.normalizeTlsInboundInput({ name: "共享", port: 443, ...overrides });
      const makeInbound = async (overrides = {}) => {
        const value = settings(overrides);
        await service.validateTlsInboundChange({ hostId: 10, settings: value });
        return Number(await db.createTlsInbound(10, value));
      };
      let nextRuleId = 100;
      const makeSniRule = async (inboundId, names, overrides = {}) => {
        const id = nextRuleId++;
        const row = { userId: 2, isEnabled: 1, sourcePort: 45000 + id, ...overrides };
        await exec(
          "INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, pendingDelete, isForwardGroupTemplate, tlsInboundId, sniNames) VALUES (?, ?, ?, 10, 'realm', 'tcp', ?, '8.8.8.8', 443, ?, 0, 0, ?, ?)",
          [id, row.userId, "r" + id, row.sourcePort, row.isEnabled, inboundId, JSON.stringify(names)],
        );
        await db.replaceRuleSniNames(id, inboundId, names);
        return id;
      };

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "tls.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("入站端口和这台机器上的其他监听互相避让", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, protocol, sourcePort, targetIp, targetPort, isEnabled, pendingDelete, isForwardGroupTemplate) VALUES (1, 1, 'web', 10, 'tcp', 443, '8.8.8.8', 443, 1, 0, 0)");
    await assert.rejects(makeInbound({ port: 443 }), /已被占用/);
    // 不分协议：和规则之间一样，一个端口号在 Agent 上只算一份（UDP 规则也挡）。
    await exec("UPDATE forward_rules SET protocol = 'udp' WHERE id = 1");
    await assert.rejects(makeInbound({ port: 443 }), /已被占用/);
    await exec("UPDATE forward_rules SET pendingDelete = 1, isEnabled = 0 WHERE id = 1");
    const id = await makeInbound({ port: 443 });
    // 反过来：入站占着的端口，规则（不管协议）、落地节点都不能再拿。
    assert.equal(await db.isPortUsedOnHost(10, 443, undefined, "tcp"), true);
    assert.equal(await db.isPortUsedOnHost(10, 443, undefined, "udp"), true);
    assert.ok((await db.getUsedPortsOnHost(10, undefined, "tcp")).has(443));
    // 改自己的设置时不算撞自己；同一台机器上第二个 443 入站不行。
    await service.validateTlsInboundChange({ hostId: 10, inboundId: id, settings: settings({ port: 443 }) });
    await assert.rejects(makeInbound({ port: 443 }), /已有另一个共享 TLS 入站|已被占用/);
    // 停用的入站照样占着端口（它的规则随时会被重新启用）。
    await db.updateTlsInbound(id, { isEnabled: false });
    assert.equal(await db.isPortUsedOnHost(10, 443, undefined, "tcp"), true);
    // 落地节点（sing-box 入站）占的端口也要避开。
    const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
    await inbounds.createProxyInbound({ userId: 1, hostId: 10, name: "n", protocol: "vless", port: 8443, transport: "tcp", security: "none", uuid: "11111111-2222-3333-4444-555555555555", isEnabled: true });
    await assert.rejects(makeInbound({ port: 8443 }), /已被占用/);
  `);
});

test("一个名字在一个入站里只能归一条规则，暂停的规则也保留；唯一索引兜底并回滚事务", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    const inbound = await db.getTlsInboundById(inboundId);
    const first = await makeSniRule(inboundId, ["a.example.com"], { isEnabled: 0 });
    await assert.rejects(
      service.validateSniRuleNames({ inbound, names: "A.Example.com." }),
      (error) => error.message.startsWith(shared.TLS_INBOUND_SNI_CONFLICT_MESSAGE),
    );
    // 自己改自己不算冲突。
    assert.deepEqual(await service.validateSniRuleNames({ inbound, names: "a.example.com\nb.example.com", excludeRuleId: first }), ["a.example.com", "b.example.com"]);
    // 绕过预检（并发）时唯一索引拦下来，同一事务里对规则行的修改一起回滚。
    const second = await makeSniRule(inboundId, ["c.example.com"]);
    await assert.rejects(db.withDatabaseTransaction(async () => {
      await db.updateForwardRule(second, { sniNames: JSON.stringify(["a.example.com"]) });
      await db.replaceRuleSniNames(second, inboundId, ["a.example.com"]);
    }), new RegExp(shared.TLS_INBOUND_SNI_CONFLICT_MESSAGE.replace(/[()（）]/g, ".")));
    const row = (await query("SELECT sniNames FROM forward_rules WHERE id = ?", [second]))[0];
    assert.equal(row.sniNames, JSON.stringify(["c.example.com"]));
    const owners = await query("SELECT name, ruleId FROM rule_sni_names ORDER BY name");
    assert.deepEqual(owners.map((item) => [item.name, Number(item.ruleId)]), [["a.example.com", first], ["c.example.com", second]]);
    // 规则删掉（标记待删）时名字立刻放掉。
    await db.markForwardRulePendingDelete(first);
    assert.deepEqual(await service.validateSniRuleNames({ inbound, names: "a.example.com" }), ["a.example.com"]);
  `);
});

test("白名单：规则的名字必须在内；改白名单不能把已有规则挤出去", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound({ allowedSni: "example.com" });
    const inbound = await db.getTlsInboundById(inboundId);
    await assert.rejects(service.validateSniRuleNames({ inbound, names: "evil.com" }), /不在这个入站的白名单内/);
    await makeSniRule(inboundId, ["shop.example.com"]);
    await assert.rejects(
      service.validateTlsInboundChange({ hostId: 10, inboundId, settings: service.normalizeTlsInboundInput({ allowedSni: ".other.com" }, inbound) }),
      /不再覆盖规则/,
    );
    // 收窄到仍然盖得住的范围可以。
    await service.validateTlsInboundChange({ hostId: 10, inboundId, settings: service.normalizeTlsInboundInput({ allowedSni: ".example.com" }, inbound) });
  `);
});

test("入站上有规则（暂停的也算）不能删；默认规则必须是这个入站上的管理员规则", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    const inbound = await db.getTlsInboundById(inboundId);
    await service.assertTlsInboundDeletable(inboundId);
    const userRule = await makeSniRule(inboundId, ["a.example.com"], { isEnabled: 0 });
    await assert.rejects(service.assertTlsInboundDeletable(inboundId), /还有 1 条规则/);
    const asDefault = (ruleId) => service.validateTlsInboundChange({
      hostId: 10, inboundId,
      settings: service.normalizeTlsInboundInput({ unknownSniAction: "default_rule", defaultRuleId: ruleId }, inbound),
    });
    await assert.rejects(asDefault(userRule), /管理员/);
    await assert.rejects(asDefault(999), /挂在这个入站上/);
    const adminRule = await makeSniRule(inboundId, ["admin.example.com"], { userId: 1 });
    await asDefault(adminRule);
    // 删主机时入站和名字一起清掉。
    await db.deleteHost(10);
    assert.equal((await query("SELECT COUNT(*) AS c FROM host_tls_inbounds"))[0].c, 0);
    assert.equal((await query("SELECT COUNT(*) AS c FROM rule_sni_names"))[0].c, 0);
  `);
});

test("SNI 规则不占端口额度，回环端口避开这台机器上已占用的端口", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    await makeSniRule(inboundId, ["a.example.com"]);
    assert.equal(await db.getUserPortCount(2), 0);
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, protocol, sourcePort, targetIp, targetPort, isEnabled, pendingDelete, isForwardGroupTemplate) VALUES (2, 2, 'p', 10, 'tcp', 30000, '8.8.8.8', 443, 1, 0, 0)");
    assert.equal(await db.getUserPortCount(2), 1);
    const reservation = await service.reserveSniBackendPort(10);
    assert.ok(reservation);
    assert.ok(reservation.port >= service.SNI_BACKEND_PORT_RANGE.start && reservation.port <= service.SNI_BACKEND_PORT_RANGE.end);
    assert.equal(await db.isPortUsedOnHost(10, reservation.port), false);
    reservation.release();
  `);
});

test("Agent 低于 2.2.224 或入站停用时不能挂规则 / 启用规则", () => {
  runInDatabase(String.raw`
    const inboundId = await makeInbound();
    await service.requireTlsInboundRunnable(await db.getTlsInboundById(inboundId));
    await exec("UPDATE hosts SET agentVersion = '2.2.223' WHERE id = 10");
    await assert.rejects(service.requireTlsInboundRunnable(await db.getTlsInboundById(inboundId)), /2\.2\.224.*需要升级 Agent/);
    await exec("UPDATE hosts SET agentVersion = '2.2.224' WHERE id = 10");
    await db.updateTlsInbound(inboundId, { isEnabled: false });
    await assert.rejects(service.requireTlsInboundRunnable(await db.getTlsInboundById(inboundId)), /已停用/);
  `);
});
