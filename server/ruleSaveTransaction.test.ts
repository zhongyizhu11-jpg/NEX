import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  规则的创建 / 更新：数据库写入在一个事务里（server/routers/rules.crud.ts）。
  用 SQLite 触发器在写到一半时制造失败，看是不是什么都没留下。
*/
const setup = String.raw`
  const now = Math.floor(Date.now() / 1000);
  await exec("INSERT INTO users (id, username, password, role, canAddRules, manualCanAddRules, accountEnabled) VALUES (1, 'admin', 'hash', 'admin', 1, 1, 1)");
  for (const [id, name, ip, token] of [[1, "entry", "203.0.113.1", "tok1"], [2, "exit", "203.0.113.2", "tok2"]]) {
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
      [id, name, ip, ip, "slave", token, "2.2.204", now],
    );
  }
  await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "isRunning", secret) VALUES (10, ?, 1, 2, ?, ?, 1, 1, 1, ?)', ["t", "forwardx", 46795, "secret-a"]);
  const { rulesRouter } = await import(url("server/routers/rules.ts"));
  const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
  const caller = rulesRouter.createCaller(context);
  const count = async (sql, params = []) => Number((await query(sql, params))[0].n);
`;

test("a rule create that fails half-way leaves no rule row and frees its ports", () => {
  runInDatabase(String.raw`
    // 规则行写进去之后、把隧道标记成待下发时失败
    await exec('CREATE TRIGGER fail_tunnel_mark BEFORE UPDATE ON tunnels WHEN NEW."isRunning" = 0 BEGIN SELECT RAISE(ABORT, ' + "'injected failure'" + '); END');
    const input = {
      hostId: 1, name: "half", forwardType: "gost", protocol: "tcp", gostMode: "direct",
      tunnelId: 10, sourcePort: 40001, targetIp: "198.51.100.9", targetPort: 443,
    };
    const auditBefore = await count("SELECT COUNT(*) AS n FROM config_audit_events");
    await assert.rejects(() => caller.create(input), /injected failure/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_rules"), 0, "失败后不能留下半条规则");
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_rule_tunnel_exits"), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM config_audit_events"), auditBefore, "回滚了就不记审计");
    assert.equal(Number((await query("SELECT isRunning FROM tunnels WHERE id = 10"))[0].isRunning), 1);

    // 端口没被占着：去掉故障后同一个端口马上能建
    await exec("DROP TRIGGER fail_tunnel_mark");
    const created = await caller.create(input);
    assert.equal(created.sourcePort, 40001);
    const rows = await query('SELECT id, "sourcePort", "tunnelExitPort" FROM forward_rules');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].id), Number(created.id));
    assert.ok(Number(rows[0].tunnelExitPort) > 0);
    assert.equal(Number((await query("SELECT isRunning FROM tunnels WHERE id = 10"))[0].isRunning), 0);
  `, { name: "rule-create-tx", setup, quiet: true });
});

test("a direct rule create that succeeds returns the same shape as before", () => {
  runInDatabase(String.raw`
    const created = await caller.create({
      hostId: 1, name: "plain", forwardType: "iptables", protocol: "tcp", gostMode: "direct",
      sourcePort: 40010, targetIp: "198.51.100.10", targetPort: 80,
    });
    assert.deepEqual(Object.keys(created).sort(), ["autoBoundProxyNodeId", "autoBoundProxyNodeName", "id", "sourcePort"]);
    assert.equal(created.sourcePort, 40010);
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_rules WHERE id = ?", [created.id]), 1);
  `, { name: "rule-create-ok", setup, quiet: true });
});

test("a rule update that fails half-way leaves the stored rule unchanged", () => {
  runInDatabase(String.raw`
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (20, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1)',
      ["before", "iptables", "tcp", 40020, "198.51.100.20", 443],
    );
    // 一条遗留的出口映射：保存时要清掉它，清的时候失败
    await exec('INSERT INTO forward_rule_tunnel_exits (id, "ruleId", "tunnelId", "exitNodeId", "exitSeq", "exitHostId", "tunnelExitPort") VALUES (1, 20, 10, 1, 1, 2, 50000)');
    await exec("CREATE TRIGGER fail_exit_clear BEFORE DELETE ON forward_rule_tunnel_exits BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const auditBefore = await count("SELECT COUNT(*) AS n FROM config_audit_events");
    await assert.rejects(() => caller.update({ id: 20, name: "after", targetPort: 8443 }), /injected failure/);
    const [rule] = await query('SELECT name, "targetPort", "isRunning" FROM forward_rules WHERE id = 20');
    assert.equal(rule.name, "before", "规则行不能只改了一半");
    assert.equal(Number(rule.targetPort), 443);
    assert.equal(Number(rule.isRunning), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM config_audit_events"), auditBefore);

    await exec("DROP TRIGGER fail_exit_clear");
    const result = await caller.update({ id: 20, name: "after", targetPort: 8443 });
    assert.equal(result.success, true);
    assert.equal(result.reset, true);
    const [saved] = await query('SELECT name, "targetPort" FROM forward_rules WHERE id = 20');
    assert.equal(saved.name, "after");
    assert.equal(Number(saved.targetPort), 8443);
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_rule_tunnel_exits WHERE \"ruleId\" = 20"), 0);
  `, { name: "rule-update-tx", setup, quiet: true });
});
