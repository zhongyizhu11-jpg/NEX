import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  转发组模板规则的建 / 转换：模板行和它在每台成员机上的子规则在一个事务里写
  （server/routers/rules.crud.ts，server/repositories/forwardGroupRepository.ts 的
  withForwardGroupsSyncTransaction）。

  用 SQLite 触发器在写到一半时制造失败（第一台成员机上的子规则已经写进去、第二台写的时候报错），
  看是不是什么都没留下；去掉故障后同一个请求要能原样成功（端口预留也放掉了）。
  端口转发组 10 的入口是主机 1、2；端口转发组 11 的入口是主机 3；主机 4 给普通规则用。
*/
const setup = String.raw`
  const now = Math.floor(Date.now() / 1000);
  await exec("INSERT INTO users (id, username, password, role, canAddRules, manualCanAddRules, accountEnabled) VALUES (1, 'admin', 'hash', 'admin', 1, 1, 1)");
  for (const id of [1, 2, 3, 4]) {
    const ip = "203.0.113." + id;
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
      [id, "host-" + id, ip, ip, "slave", "tok" + id, "2.2.249", now],
    );
  }
  for (const [groupId, name, hostIds] of [[10, "pf-a", [1, 2]], [11, "pf-b", [3]]]) {
    await exec(
      'INSERT INTO forward_groups (id, name, "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled") VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
      [groupId, name, "host", "port", "gost", "0.0.0.0"],
    );
    for (const [index, hostId] of hostIds.entries()) {
      await exec(
        'INSERT INTO forward_group_members (id, "groupId", "memberType", "hostId", priority, "isEnabled") VALUES (?, ?, ?, ?, ?, 1)',
        [groupId * 10 + index, groupId, "host", hostId, index],
      );
    }
  }
  const { rulesRouter } = await import(url("server/routers/rules.ts"));
  const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
  const caller = rulesRouter.createCaller(context);
  const count = async (sql, params = []) => Number((await query(sql, params))[0].n);
  const childrenOf = (templateId) => query(
    'SELECT id, "hostId", "sourcePort", "forwardGroupId", "pendingDelete" FROM forward_rules WHERE "forwardGroupRuleId" = ? ORDER BY "hostId"',
    [templateId],
  );
  // 某台主机上的子规则一写进去就失败：第一台成员机的子规则这时已经在同一个事务里写过了。
  const failChildOnHost = (hostId) => exec(
    'CREATE TRIGGER fail_child BEFORE INSERT ON forward_rules WHEN NEW."forwardGroupRuleId" IS NOT NULL AND NEW."hostId" = ' + Number(hostId)
      + " BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  const templateInput = {
    name: "pf", forwardType: "gost", protocol: "tcp", gostMode: "direct",
    forwardGroupId: 10, sourcePort: 41001, targetIp: "198.51.100.9", targetPort: 443,
  };
  const insertPlainRule = (id, port) => exec(
    'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (?, 4, ?, ?, ?, ?, ?, ?, 1, 1, 1)',
    [id, "plain", "gost", "tcp", port, "198.51.100.20", 8443],
  );
`;

test("建端口转发模板：模板和每台成员机上的子规则一起写进去", () => {
  runInDatabase(String.raw`
    const created = await caller.create(templateInput);
    assert.equal(created.sourcePort, 41001);
    const [template] = await query('SELECT "isForwardGroupTemplate", "forwardGroupId", "sourcePort" FROM forward_rules WHERE id = ?', [created.id]);
    assert.equal(Number(template.isForwardGroupTemplate), 1);
    assert.equal(Number(template.forwardGroupId), 10);
    const children = await childrenOf(created.id);
    assert.deepEqual(children.map((child) => [Number(child.hostId), Number(child.sourcePort), Number(child.pendingDelete)]), [[1, 41001, 0], [2, 41001, 0]]);
  `, { name: "fg-create-ok", setup, quiet: true });
});

test("建端口转发模板：第二台成员机的子规则写失败时，模板和第一台的子规则都不留下", () => {
  runInDatabase(String.raw`
    await failChildOnHost(2);
    const auditBefore = await count("SELECT COUNT(*) AS n FROM config_audit_events");
    await assert.rejects(() => caller.create(templateInput), /injected failure/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_rules"), 0, "失败后不能留下没有子规则的模板，也不能留下半组子规则");
    assert.equal(await count("SELECT COUNT(*) AS n FROM config_audit_events"), auditBefore, "回滚了就不记审计");

    // 入口端口没被占着：去掉故障后同一个端口马上能建
    await exec("DROP TRIGGER fail_child");
    const created = await caller.create(templateInput);
    assert.equal(created.sourcePort, 41001);
    assert.equal((await childrenOf(created.id)).length, 2);
  `, { name: "fg-create-tx", setup, quiet: true });
});

test("普通规则改成端口转发模板：子规则写失败时规则原样不动", () => {
  runInDatabase(String.raw`
    await insertPlainRule(50, 41050);
    await failChildOnHost(2);
    await assert.rejects(() => caller.update({ id: 50, forwardGroupId: 10 }), /injected failure/);
    const [rule] = await query('SELECT "hostId", "forwardGroupId", "isForwardGroupTemplate", "isRunning" FROM forward_rules WHERE id = 50');
    assert.equal(Number(rule.hostId), 4, "规则不能只改了一半");
    assert.equal(rule.forwardGroupId, null);
    assert.equal(Number(rule.isForwardGroupTemplate), 0);
    assert.equal(Number(rule.isRunning), 1, "原来那条转发还在跑");
    assert.equal(await count('SELECT COUNT(*) AS n FROM forward_rules WHERE "forwardGroupRuleId" = 50'), 0);

    await exec("DROP TRIGGER fail_child");
    const result = await caller.update({ id: 50, forwardGroupId: 10 });
    assert.equal(result.success, true);
    const [saved] = await query('SELECT "forwardGroupId", "isForwardGroupTemplate" FROM forward_rules WHERE id = 50');
    assert.equal(Number(saved.forwardGroupId), 10);
    assert.equal(Number(saved.isForwardGroupTemplate), 1);
    assert.deepEqual((await childrenOf(50)).map((child) => Number(child.hostId)), [1, 2]);
  `, { name: "fg-convert-to-template-tx", setup, quiet: true });
});

test("端口转发模板改回普通规则：标子规则待删时失败，模板和子规则都原样不动", () => {
  runInDatabase(String.raw`
    const created = await caller.create(templateInput);
    const before = await childrenOf(created.id);
    assert.equal(before.length, 2);
    await exec("CREATE TRIGGER fail_retire BEFORE UPDATE ON forward_rules WHEN NEW.\"pendingDelete\" = 1 AND OLD.\"pendingDelete\" = 0 BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await assert.rejects(() => caller.update({ id: created.id, forwardGroupId: null, hostId: 4 }), /injected failure/);
    const [template] = await query('SELECT "hostId", "forwardGroupId", "isForwardGroupTemplate" FROM forward_rules WHERE id = ?', [created.id]);
    assert.equal(Number(template.isForwardGroupTemplate), 1, "模板不能先变成普通规则、子规则却还挂着");
    assert.equal(Number(template.forwardGroupId), 10);
    assert.deepEqual((await childrenOf(created.id)).map((child) => Number(child.pendingDelete)), [0, 0]);

    await exec("DROP TRIGGER fail_retire");
    const result = await caller.update({ id: created.id, forwardGroupId: null, hostId: 4 });
    assert.equal(result.success, true);
    const [saved] = await query('SELECT "hostId", "forwardGroupId", "isForwardGroupTemplate" FROM forward_rules WHERE id = ?', [created.id]);
    assert.equal(Number(saved.hostId), 4);
    assert.equal(saved.forwardGroupId, null);
    assert.equal(Number(saved.isForwardGroupTemplate), 0);
    assert.deepEqual((await childrenOf(created.id)).map((child) => Number(child.pendingDelete)), [1, 1], "子规则都进了删除流程");
  `, { name: "fg-convert-to-plain-tx", setup, quiet: true });
});

test("端口转发模板换组：新组的子规则写失败时，模板留在旧组、旧组的子规则不动", () => {
  runInDatabase(String.raw`
    const created = await caller.create(templateInput);
    await failChildOnHost(3);
    await assert.rejects(() => caller.update({ id: created.id, forwardGroupId: 11 }), /injected failure/);
    const [template] = await query('SELECT "forwardGroupId" FROM forward_rules WHERE id = ?', [created.id]);
    assert.equal(Number(template.forwardGroupId), 10);
    assert.deepEqual((await childrenOf(created.id)).map((child) => [Number(child.hostId), Number(child.pendingDelete)]), [[1, 0], [2, 0]]);

    await exec("DROP TRIGGER fail_child");
    await caller.update({ id: created.id, forwardGroupId: 11 });
    const [moved] = await query('SELECT "forwardGroupId" FROM forward_rules WHERE id = ?', [created.id]);
    assert.equal(Number(moved.forwardGroupId), 11);
    const children = await childrenOf(created.id);
    assert.deepEqual(
      children.map((child) => [Number(child.hostId), Number(child.forwardGroupId), Number(child.pendingDelete)]),
      [[1, 10, 1], [2, 10, 1], [3, 11, 0]],
      "旧组的子规则进删除流程，新组的建出来",
    );
  `, { name: "fg-move-group-tx", setup, quiet: true });
});

test("隧道成员的转发组建模板：最后把隧道标成待下发时失败，子规则和出口端口都不留下", () => {
  runInDatabase(String.raw`
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "isRunning", secret) VALUES (30, ?, 1, 2, ?, ?, 1, 1, 1, ?)', ["t", "forwardx", 46795, "secret-a"]);
    await exec(
      'INSERT INTO forward_groups (id, name, "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled") VALUES (12, ?, ?, ?, ?, ?, 1, 1)',
      ["fo-tunnel", "tunnel", "failover", "gost", "0.0.0.0"],
    );
    await exec('INSERT INTO forward_group_members (id, "groupId", "memberType", "tunnelId", priority, "isEnabled") VALUES (120, 12, ?, 30, 0, 1)', ["tunnel"]);
    // 同步的最后一步：子规则都写好了，把成员隧道标成待下发
    await exec("CREATE TRIGGER fail_tunnel_mark BEFORE UPDATE ON tunnels WHEN NEW.\"isRunning\" = 0 BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const input = { ...templateInput, forwardGroupId: 12, sourcePort: 41012 };
    await assert.rejects(() => caller.create(input), /injected failure/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_rules"), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_rule_tunnel_exits"), 0);
    assert.equal(Number((await query("SELECT \"isRunning\" FROM tunnels WHERE id = 30"))[0].isRunning), 1);

    await exec("DROP TRIGGER fail_tunnel_mark");
    const created = await caller.create(input);
    const children = await query('SELECT "tunnelId", "tunnelExitPort", "sourcePort" FROM forward_rules WHERE "forwardGroupRuleId" = ?', [created.id]);
    assert.equal(children.length, 1);
    assert.equal(Number(children[0].tunnelId), 30);
    assert.ok(Number(children[0].tunnelExitPort) > 0, "隧道子规则分到了出口端口");
    assert.equal(Number((await query("SELECT \"isRunning\" FROM tunnels WHERE id = 30"))[0].isRunning), 0);
  `, { name: "fg-tunnel-create-tx", setup, quiet: true });
});

test("新建转发组：成员写失败时组行也不留下", () => {
  runInDatabase(String.raw`
    const groups = await import(url("server/repositories/forwardGroupRepository.ts"));
    await exec("CREATE TRIGGER fail_member BEFORE INSERT ON forward_group_members WHEN NEW.\"hostId\" = 2 BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const groupsBefore = await count("SELECT COUNT(*) AS n FROM forward_groups");
    const membersBefore = await count("SELECT COUNT(*) AS n FROM forward_group_members");
    const input = { name: "pf-new", groupType: "host", groupMode: "port", forwardType: "gost", userId: 1, isEnabled: true };
    const members = [{ memberType: "host", hostId: 1 }, { memberType: "host", hostId: 2 }];
    await assert.rejects(() => groups.createForwardGroup(input, members), /injected failure/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_groups"), groupsBefore, "不能留下缺成员的组");
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_group_members"), membersBefore);

    await exec("DROP TRIGGER fail_member");
    const id = await groups.createForwardGroup(input, members);
    assert.equal(await count('SELECT COUNT(*) AS n FROM forward_group_members WHERE "groupId" = ?', [id]), 2);
  `, { name: "fg-group-create-tx", setup, quiet: true });
});

/*
  最容易卡死的一条：模板换组。事务里要同时拿两个组的同步锁、在两个组里同步子规则，同步时给每台成员机
  查端口占用（isPortUsedOnHost → opsReservedPortsOnHost）。

  在事务正写着模板行的那一刻（SQLite 触发器调一个 JS 函数），从事务外发起一次「其他功能占用的端口」
  加载：它的查询排在 SQLite 连接锁后面，而锁在这个事务手里。以前事务里的端口检查会去等这次加载，
  两边互相等，面板的数据库访问从此全部卡住；现在事务里不等它，自己读一遍。
  测试子进程里没有别的定时器撑着事件循环，互等时 Node 会报「unsettled top-level await」直接退出（退出码 13），
  有别的东西撑着时则一直挂到 timeoutMs 被杀 —— 两种都让测试失败。
  另外两个请求同时互相换组（10→11、11→10）：两把组锁按 id 从小到大拿，不能互等。
*/
test("模板换组时事务外正好有一次端口加载在排队：不卡死；两个请求互相换组也不卡死", { timeout: 60_000 }, () => {
  runInDatabase(String.raw`
    const { AsyncResource } = await import("node:async_hooks");
    const ops = await import(url("server/ops/opsReservedPorts.ts"));
    ops.registerOpsReservedPortsLoader("test-loader", async () => {
      await query("SELECT 1 AS n");
      return [];
    });
    let outsideLoad = null;
    // 绑在事务外的上下文上：在触发器里调用时，跑起来的是一个事务外的请求。
    const startOutsideLoad = AsyncResource.bind(() => {
      ops.invalidateOpsReservedPorts();
      outsideLoad = ops.opsReservedPortsOnHost(3);
    });
    runtime.getSqlite().function("start_outside_load", () => {
      startOutsideLoad();
      return 1;
    });

    const created = await caller.create(templateInput);
    await exec('CREATE TRIGGER outside_load AFTER UPDATE OF "forwardGroupId" ON forward_rules WHEN NEW."isForwardGroupTemplate" = 1 AND OLD."forwardGroupId" <> NEW."forwardGroupId" BEGIN SELECT start_outside_load(); END');
    await caller.update({ id: created.id, forwardGroupId: 11 });
    assert.ok(outsideLoad, "触发器跑过，事务外的加载确实发起了");
    assert.deepEqual(await outsideLoad, []);
    assert.deepEqual((await childrenOf(created.id)).filter((child) => Number(child.pendingDelete) === 0).map((child) => Number(child.hostId)), [3]);
    await exec("DROP TRIGGER outside_load");

    // 两个模板同时互相换组
    const other = await caller.create({ ...templateInput, forwardGroupId: 10, sourcePort: 41002 });
    const results = await Promise.allSettled([
      caller.update({ id: created.id, forwardGroupId: 10 }),
      caller.update({ id: other.id, forwardGroupId: 11 }),
    ]);
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"], JSON.stringify(results.map((result) => result.reason?.message)));
    const rows = await query('SELECT id, "forwardGroupId" FROM forward_rules WHERE id IN (?, ?) ORDER BY id', [created.id, other.id]);
    assert.deepEqual(rows.map((row) => Number(row.forwardGroupId)), [10, 11]);
  `, { name: "fg-move-group-deadlock", setup, quiet: true, timeoutMs: 45_000 });
});

/*
  事务里排的定时器在提交之后才跑，AsyncLocalStorage 会把事务的上下文一起带过去（规则专属域名的
  防抖同步就是这样）。上下文在事务结束时要标成失效：否则定时器里还以为自己在事务里 —— MySQL / PG
  下拿着已经还回池里的连接查库，转发组同步这类「必须在事务外调用」的路径直接报错。
*/
test("事务里排的定时器提交后才跑：不再被当成在事务里", () => {
  runInDatabase(String.raw`
    let fired = null;
    await runtime.withDatabaseTransaction(async () => {
      assert.equal(runtime.isDatabaseTransactionActive(), true);
      fired = new Promise((resolve, reject) => setTimeout(() => {
        (async () => {
          const insideTimer = runtime.isDatabaseTransactionActive();
          let ranImmediately = false;
          await runtime.afterDatabaseCommit(() => { ranImmediately = true; });
          const groups = await import(url("server/repositories/forwardGroupRepository.ts"));
          // 只能在事务外调；上下文没失效的话这里会抛「must be acquired before starting a database transaction」
          await groups.syncForwardGroupRules(10);
          return { insideTimer, ranImmediately };
        })().then(resolve, reject);
      }, 20));
    });
    assert.deepEqual(await fired, { insideTimer: false, ranImmediately: true });
  `, { name: "tx-context-leak", setup, quiet: true });
});
