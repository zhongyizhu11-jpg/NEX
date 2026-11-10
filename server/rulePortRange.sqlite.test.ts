import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 端口段规则（shared/portRange.ts、server/rulePortRange.ts）在真库上的端口冲突、端口策略、
 * 套餐端口段、转发方式拦截、Agent 版本拦截、重新启用、批量预览。每个用例一个独立进程 + SQLite 库，
 * 搭法同 lifecycleAuditFixes.test.ts。
 */
function runScenario(name: string, body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `forwardx-port-range-${name}-`));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => runtime.executeRaw(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const one = async (sqlText, params = []) => (await runtime.queryRaw(sqlText, params))[0];
    const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
    const ruleCols = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "sourcePortEnd", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "pendingDelete", "isForwardGroupTemplate"];
    const hostCols = ["id", "name", "ip", "hostType", "userId", "isOnline", "agentVersion", "portRangeStart", "portRangeEnd"];
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      await insert("hosts", hostCols, [1, "edge", "198.51.100.1", "slave", 1, 1, "2.2.253", 20000, 29999]);
      await insert("hosts", hostCols, [2, "old-agent", "198.51.100.2", "slave", 1, 1, "2.2.252", null, null]);
      // 先加载 rules.ts 再加载 rules.crud（和 lifecycleAuditFixes.test.ts 同一个顺序：反过来会撞上路由模块的循环引用）。
      const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
      const crud = await import(moduleUrl("server/routers/rules.crud.ts"));
      const caller = rulesRouter.createCaller(context(admin));
      const base = { hostId: 1, forwardType: "nftables", protocol: "both", targetIp: "203.0.113.10" };
      ${body}
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "port-range.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
      timeout: 90_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("端口段规则：段与段、段与单端口、单端口与段的冲突都拦住，不挨着的段能建", () => {
  runScenario("conflicts", String.raw`
    const created = await crud.createDirectForwardRuleForActor(admin, { ...base, name: "game", sourcePort: 20000, sourcePortEnd: 20100, targetPort: 20000 });
    const row = await one('SELECT "sourcePort", "sourcePortEnd", "targetPort" FROM "forward_rules" WHERE "id" = ?', [created.id]);
    assert.deepEqual([Number(row.sourcePort), Number(row.sourcePortEnd), Number(row.targetPort)], [20000, 20100, 20000]);

    // 段与段重叠（只撞一头）。
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "overlap", sourcePort: 20100, sourcePortEnd: 20150, targetPort: 30100 }), /端口 20100 已被占用/);
    // 单端口落在段中间：isPortUsedOnHost 必须按整段算（别的功能查冲突也走它）。
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, forwardType: "gost", name: "inside", sourcePort: 20050, targetPort: 443 }), /20050/);
    assert.equal(await (await import(moduleUrl("server/db.ts"))).isPortUsedOnHost(1, 20050), true);
    assert.equal((await caller.checkPort({ hostId: 1, sourcePort: 20050, protocol: "tcp" })).used, true);
    // 段把已有的单端口包进去。
    await crud.createDirectForwardRuleForActor(admin, { ...base, name: "single", sourcePort: 21005, targetPort: 443 });
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "cover", sourcePort: 21000, sourcePortEnd: 21010, targetPort: 31000 }), /端口 21005 已被占用/);
    const rangeCheck = await caller.checkPort({ hostId: 1, sourcePort: 21000, sourcePortEnd: 21010, protocol: "both" });
    assert.equal(rangeCheck.used, true);
    assert.match(rangeCheck.reason, /21005/);
    // 紧挨着的段不算重叠；平移的目标段照样存目标起点。
    const next = await crud.createDirectForwardRuleForActor(admin, { ...base, name: "next", sourcePort: 20101, sourcePortEnd: 20200, targetPort: 30101, targetPortEnd: 30200 });
    assert.equal(Number((await one('SELECT "targetPort" FROM "forward_rules" WHERE "id" = ?', [next.id])).targetPort), 30101);
    // 随机分配不会挑到段里的端口。
    const db = await import(moduleUrl("server/db.ts"));
    const used = await db.getUsedPortsOnHost(1);
    for (const port of [20000, 20077, 20100, 20150, 20200]) assert.ok(used.has(port), "段里每个端口都算占用：" + port);
  `);
});

test("端口段规则：超长、目标段长度不一致、超出主机端口区间、超过 65535 都报错", () => {
  runScenario("shape-policy", String.raw`
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "huge", sourcePort: 20000, sourcePortEnd: 21000, targetPort: 20000 }), /最多 1000 个端口/);
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "len", sourcePort: 22000, sourcePortEnd: 22009, targetPort: 32000, targetPortEnd: 32020 }), /一样长/);
    // 主机端口区间 20000-29999：段的尾巴伸出去也不行。
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "tail", sourcePort: 29990, sourcePortEnd: 30010, targetPort: 29990 }), /30000 不在这台主机允许的范围内/);
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "target", sourcePort: 23000, sourcePortEnd: 23010, targetPort: 65530 }), /超出 65535/);
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "random", sourcePort: 0, sourcePortEnd: 100, targetPort: 80 }), /不能随机分配/);
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM "forward_rules"')).n), 0, "一条都不该建出来");
  `);
});

test("端口段规则：用户态转发、隧道、转发组、线路组被拦并说明原因；老 Agent 上不让建", () => {
  runScenario("unsupported", String.raw`
    // nginx 默认在协议设置里关着，会先被那一道拦下；这里看另外三种。
    for (const forwardType of ["gost", "realm", "socat"]) {
      await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, forwardType, name: forwardType, sourcePort: 24000, sourcePortEnd: 24010, targetPort: 24000 }), /只支持 iptables \/ nftables/);
    }
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "fo", sourcePort: 24000, sourcePortEnd: 24010, targetPort: 24000, failoverEnabled: true }), /线路组/);
    // 主备转发组（多入口 DDNS 切换）不支持端口段；「端口转发」资源可以（见下面 port 模式那个用例）。
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [5, "主备", "host", "failover", "nftables", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [51, 5, "host", 1, 0, 1]);
    await assert.rejects(() => caller.create({ ...base, hostId: undefined, forwardGroupId: 5, sourcePort: 24000, sourcePortEnd: 24010, targetPort: 24000 }), /转发组 \/ 转发链暂不支持端口段/);
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, hostId: 2, name: "old", sourcePort: 24000, sourcePortEnd: 24010, targetPort: 24000 }), /需要 Agent 2\.2\.253/);
    // iptables 也支持。
    await crud.createDirectForwardRuleForActor(admin, { ...base, forwardType: "iptables", name: "ipt", sourcePort: 24000, sourcePortEnd: 24010, targetPort: 34000 });
    // 已有的段规则改成 gost：说清楚为什么不行；先改回单端口就可以。
    const row = await one('SELECT "id" FROM "forward_rules" WHERE "name" = ?', ["ipt"]);
    await assert.rejects(() => caller.update({ id: Number(row.id), forwardType: "gost" }), /只支持 iptables \/ nftables/);
    await caller.update({ id: Number(row.id), forwardType: "gost", sourcePortEnd: null });
    const after = await one('SELECT "forwardType", "sourcePortEnd" FROM "forward_rules" WHERE "id" = ?', [row.id]);
    assert.equal(after.forwardType, "gost");
    assert.equal(after.sourcePortEnd, null);
  `);
});

test("端口段规则：改段长要整段重查（排除自己），停用期间被占的端口重新启用时拦住", () => {
  runScenario("update-toggle", String.raw`
    const a = await crud.createDirectForwardRuleForActor(admin, { ...base, name: "a", sourcePort: 25000, sourcePortEnd: 25010, targetPort: 25000 });
    await crud.createDirectForwardRuleForActor(admin, { ...base, name: "b", sourcePort: 25020, targetPort: 443 });
    // 自己原来占着的端口不算冲突。
    await caller.update({ id: Number(a.id), sourcePort: 25000, sourcePortEnd: 25015, targetPort: 25000 });
    assert.equal(Number((await one('SELECT "sourcePortEnd" FROM "forward_rules" WHERE "id" = ?', [a.id])).sourcePortEnd), 25015);
    await assert.rejects(() => caller.update({ id: Number(a.id), sourcePort: 25000, sourcePortEnd: 25030, targetPort: 25000 }), /端口 25020 已被占用/);
    // 停用 a，别人拿走段中间的一个端口，再启用 a 要报错。
    await crud.toggleForwardRuleForActor(admin, Number(a.id), false);
    await crud.createDirectForwardRuleForActor(admin, { ...base, forwardType: "gost", name: "c", sourcePort: 25005, targetPort: 443 });
    await assert.rejects(() => crud.toggleForwardRuleForActor(admin, Number(a.id), true), /25005/);
    assert.equal(Number((await one('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = ?', [a.id])).isEnabled), 0);
  `);
});

test("端口段规则：套餐端口段要整段在里面；端口额度按段长算", () => {
  runScenario("plan", String.raw`
    const { reserveRulePortRange } = await import(moduleUrl("server/rulePortRange.ts"));
    const { portPolicyFrom } = await import(moduleUrl("shared/portPolicy.ts"));
    const db = await import(moduleUrl("server/db.ts"));
    const host = await db.getHostById(1);
    const planRange = { start: 26000, end: 26050, ranges: [{ start: 26000, end: 26050 }] };
    const rule = { forwardType: "nftables", sourcePort: 26040, sourcePortEnd: 26060, targetPort: 26040, protocol: "tcp" };
    await assert.rejects(() => reserveRulePortRange({ actor: admin, ownerUserId: 1, host, rule, entryPolicy: portPolicyFrom(host), planRange }), /套餐端口必须在 26000-26050 区间内（端口段 26040-26060 里的 26051 不在）/);
    const ok = await reserveRulePortRange({ actor: admin, ownerUserId: 1, host, rule: { ...rule, sourcePortEnd: 26050 }, entryPolicy: portPolicyFrom(host), planRange });
    ok.release();

    await crud.createDirectForwardRuleForActor(admin, { ...base, name: "p", sourcePort: 26000, sourcePortEnd: 26009, targetPort: 26000 });
    await crud.createDirectForwardRuleForActor(admin, { ...base, forwardType: "gost", name: "s", sourcePort: 27000, targetPort: 443 });
    assert.equal(await db.getUserPortCount(1), 11, "10 口的段 + 1 个单端口");
  `);
});

test("批量添加：逐行给结论（格式错、批内重叠、和已有规则冲突、转发方式不支持段），确认后只建能建的", () => {
  runScenario("batch", String.raw`
    await crud.createDirectForwardRuleForActor(admin, { ...base, forwardType: "gost", name: "taken", sourcePort: 28005, targetPort: 443 });
    const text = [
      "# 注释行跳过",
      "28000 10.0.0.1:80 网页",
      "28001-28003 10.0.0.2:38001-38003 媒体",
      "28003 10.0.0.3:80",
      "28004-28006 10.0.0.4:28004",
      "abc 10.0.0.5:80",
      "28010-28012 [2001:db8::1]:28010",
      "",
    ].join("\n");
    const preview = (await caller.batchPreview({ hostId: 1, forwardType: "nftables", protocol: "both", text })).rows;
    assert.deepEqual(preview.map((row) => [row.line, row.ok]), [[2, true], [3, true], [4, false], [5, false], [6, false], [7, true]]);
    assert.match(preview[2].error, /和第 3 行的入口端口重叠/);
    assert.match(preview[3].error, /28005 已被占用/);
    assert.match(preview[4].error, /入口端口/);
    assert.equal(preview[1].sourcePortEnd, 28003);

    // gost 不支持段：段那几行被拦，单端口那行照常。
    const gost = (await caller.batchPreview({ hostId: 1, forwardType: "gost", protocol: "tcp", text: "28020 10.0.0.1:80\n28021-28022 10.0.0.1:80" })).rows;
    assert.deepEqual(gost.map((row) => row.ok), [true, false]);
    assert.match(gost[1].error, /只支持 iptables \/ nftables/);

    const result = await caller.batchCreate({ hostId: 1, forwardType: "nftables", protocol: "both", text });
    assert.equal(result.created, 3);
    assert.equal(result.failed, 3);
    assert.match(result.summary, /已添加 3 条，3 行没建成/);
    const media = await one('SELECT "name", "sourcePortEnd", "targetPort" FROM "forward_rules" WHERE "sourcePort" = 28001');
    assert.equal(media.name, "媒体");
    assert.equal(Number(media.sourcePortEnd), 28003);
    assert.equal(Number(media.targetPort), 38001);
    // 再提交一次：全部撞上自己刚建的，一条都不建。
    const again = await caller.batchCreate({ hostId: 1, forwardType: "nftables", protocol: "both", text });
    assert.equal(again.created, 0);
    assert.match(again.summary, /一条都没建成/);
  `);
});

test("端口转发资源（port 模式转发组）：模板能用端口段，每台成员主机上的子规则带着整段；转发链被拦", () => {
  runScenario("port-group", String.raw`
    await insert("hosts", hostCols, [3, "edge-2", "198.51.100.3", "slave", 1, 1, "2.2.253", null, null]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [10, "端口转发", "host", "port", "nftables", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 3, 1, 1]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [11, "链", "host", "chain", "gost", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [111, 11, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [112, 11, "host", 3, 1, 1]);
    // 第二台成员机上 20055 已被占：整段都得在每台入口上空着。
    await crud.createDirectForwardRuleForActor(admin, { ...base, hostId: 3, forwardType: "gost", name: "blocker", sourcePort: 20055, targetPort: 443 });
    const check = await caller.checkPort({ forwardGroupId: 10, sourcePort: 20000, sourcePortEnd: 20100, protocol: "both" });
    assert.equal(check.used, true);
    assert.match(check.reason, /edge-2.*20055/);
    await assert.rejects(() => caller.create({ ...base, hostId: undefined, forwardGroupId: 10, sourcePort: 20000, sourcePortEnd: 20100, targetPort: 20000 }), /20055/);

    const created = await caller.create({ ...base, hostId: undefined, forwardGroupId: 10, sourcePort: 21000, sourcePortEnd: 21010, targetPort: 31000 });
    const children = await runtime.queryRaw('SELECT "hostId", "sourcePort", "sourcePortEnd", "targetPort", "forwardType" FROM forward_rules WHERE "forwardGroupRuleId" = ? ORDER BY "hostId"', [created.id]);
    assert.deepEqual(children.map((row) => [Number(row.hostId), Number(row.sourcePort), Number(row.sourcePortEnd), Number(row.targetPort), row.forwardType]),
      [[1, 21000, 21010, 31000, "nftables"], [3, 21000, 21010, 31000, "nftables"]]);
    // 段里的端口在成员主机上算占用。
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, hostId: 3, forwardType: "gost", name: "x", sourcePort: 21005, targetPort: 443 }), /21005/);

    // 转发链（中转一跳跳拨下去）不支持端口段。
    await assert.rejects(() => caller.create({ ...base, hostId: undefined, forwardGroupId: 11, sourcePort: 22000, sourcePortEnd: 22010, targetPort: 22000 }), /转发链/);
  `);
});
