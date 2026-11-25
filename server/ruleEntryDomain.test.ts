import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

import { normalizeRuleEntryDomainSuffixInput, ruleEntryDomainWebhookGroupId } from "./ruleEntryDomain";

/**
 * 规则专属域名：真的 sqlite、真的规则编辑 / 订阅绑定 / 设置接口、真的订阅路由，
 * DNS 这一层用 Webhook 服务商指到本机的一个假服务上（不出网），记下面板发出的每一次改动。
 *
 *   · 绑了订阅节点的规则拿到 r<ID>.<后缀>，A 记录指向入口机 1；
 *   · 规则换到入口在机器 2 的隧道：记录改指机器 2，订阅里的地址一个字不变；
 *   · 对话框里关掉「专属域名」：域名进待删表、订阅立刻退回入口地址（DNS 删失败也不等）；再打开重新发布；
 *   · 服务商报错：错误记在规则上，退避重试后恢复；
 *   · 解绑、删除（含规则行被真正删掉）：记录删掉；
 *   · 改后缀：旧域名删掉、新域名发布；关掉功能：记录全删，订阅退回 IP。
 */

type DnsCall = { action: string; domain: string; recordType: string; values: string[]; groupId: number };
type Outcome = Record<string, any>;

function run(): Outcome {
  const result = runInDatabase(String.raw`
    const http = (await import("node:http")).default;
    const express = (await import("express")).default;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const now = Math.floor(Date.now() / 1000);
    const target = "landing.forwardx.invalid";

    // 假的 DNS Webhook：记下每次调用；failing 为真时回 500。
    const dnsCalls = [];
    let failing = false;
    const dns = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (failing) { res.statusCode = 500; res.end("provider exploded"); return; }
        const payload = JSON.parse(body || "{}");
        dnsCalls.push({ action: payload.action, domain: payload.domain, recordType: payload.recordType, values: payload.values, groupId: payload.groupId });
        res.end("ok");
      });
    });
    await new Promise((resolve) => dns.listen(0, "127.0.0.1", resolve));
    const dnsUrl = "http://127.0.0.1:" + dns.address().port + "/dns";

    await exec("INSERT INTO users (id, username, password, role, canAddRules, manualCanAddRules, accountEnabled, allowProxySubscription, manualAllowProxySubscription) VALUES (1, 'admin', 'hash', 'admin', 1, 1, 1, 1, 1)");
    for (const [id, name, ip, token] of [[1, "Po0", "203.0.113.1", "tok1"], [2, "Po01", "203.0.113.2", "tok2"], [3, "Jinx", "203.0.113.3", "tok3"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, "2.2.204", now],
      );
    }
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", secret) VALUES (1, ?, 1, 3, ?, ?, 1, 1, ?)', ["A", "forwardx", 46795, "secret-a"]);
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", secret) VALUES (2, ?, 2, 3, ?, ?, 1, 1, ?)', ["B", "forwardx", 46796, "secret-b"]);
    const insertRule = (id, hostId, tunnelId, sourcePort, proxyNodeId, forwardType = "gost") => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "proxyNodeId", "proxyNodeVisible") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, 1)',
      [id, hostId, "rule-" + id, forwardType, "both", sourcePort, target, 19001, tunnelId, proxyNodeId],
    );
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, isEnabled) VALUES (1, 1, 'Land', 'vless', ?, 19001, 'node-uuid', 'tcp', 0, 1)", [target]);
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, rulePreset, isEnabled) VALUES (1, 1, 'phone', 'sub-token', 'base64', 'minimal', 1)");
    await insertRule(10, 1, 1, 40981, 1);            // 换隧道的那条
    await insertRule(12, 2, null, 40982, null, "iptables");  // 之后绑定、再解绑
    await insertRule(13, 1, null, 40983, 1, "iptables");     // 走界面删除
    await insertRule(14, 1, null, 40984, 1, "iptables");     // 规则行被真正删掉
    await insertRule(15, 1, null, 40985, null, "iptables");  // 没绑订阅：不该有域名
    await exec('UPDATE tunnels SET "isRunning" = 1');
    for (const [key, value] of [["ddnsEnabled", "true"], ["ddnsProvider", "webhook"], ["ddnsWebhookUrl", dnsUrl], ["ddnsWebhookMethod", "POST"], ["ruleEntryDomainSuffix", "node.example.com"]]) {
      await exec("INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value, now]);
    }

    const domain = await import(url("server/ruleEntryDomain.ts"));
    domain.configureRuleEntryDomainForTests({ retryBaseMs: 100, retryMaxMs: 300 });
    const idle = () => domain.waitForRuleEntryDomainIdle(15000);
    const subscriptions = await import(url("server/proxySubscriptionRoute.ts"));
    const app = express();
    app.use(subscriptions.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const subscription = async () => Buffer.from(await (await fetch(base + "/api/sub/sub-token")).text(), "base64").toString("utf8");
    const rows = async () => Object.fromEntries((await query('SELECT id, "hostId", "entryDomainEnabled", "entryDomain", "entryDomainValue", "entryDomainError", "entryDomainAt" FROM forward_rules ORDER BY id')).map((row) => [row.id, row]));
    const cleanups = () => query("SELECT domain, recordType, ruleId, attempts FROM rule_entry_domain_cleanups ORDER BY id");
    const takeCalls = () => dnsCalls.splice(0, dnsCalls.length);
    const snapshot = async () => ({ rows: await rows(), calls: takeCalls(), cleanups: await cleanups(), subscription: await subscription() });

    const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const { proxySubscriptionsRouter } = await import(url("server/routers/proxySubscriptions.ts"));
    const { systemRouter } = await import(url("server/_core/systemRouter.ts"));
    const rules = rulesRouter.createCaller(context);
    const subs = proxySubscriptionsRouter.createCaller(context);
    const system = systemRouter.createCaller(context);
    const out = {};

    // 1. 定时对账：已绑定的 10 / 13 / 14 拿到域名；15 没绑，不给。
    const initial = await domain.reconcileRuleEntryDomains("test-initial");
    await idle();
    out.initial = { result: initial, ...(await snapshot()) };

    // 2. 界面上绑定 12（入口在机器 2）：保存即同步。
    await subs.bindRule({ ruleId: 12, proxyNodeId: 1 });
    await idle();
    out.bind = await snapshot();

    // 3. 规则 10 从隧道 A 换到隧道 B（入口 Po0 → Po01）。
    const rule10Input = {
      id: 10, hostId: 1, name: "rule-10", forwardType: "gost", protocol: "both", gostMode: "direct", gostRelayHost: null, gostRelayPort: null,
      tunnelId: 2, forwardGroupId: null, sourcePort: 40981, isEnabled: true, targetIp: target, targetPort: 19001,
      telegramErrorNotifyEnabled: false, failoverEnabled: false, routeGroup: null,
    };
    out.update = await rules.update(rule10Input);
    await idle();
    out.switched = await snapshot();

    // 3b. 对话框里关掉规则 10 的「专属域名」，正赶上服务商不可用：域名先进待删表、列清空，
    //     订阅立刻退回入口地址，不等 DNS 删完；服务商恢复后对账补删；再打开开关就重新发布。
    failing = true;
    out.switchOff = await rules.update({ ...rule10Input, entryDomainEnabled: false });
    await idle();
    out.switchedOff = await snapshot();
    failing = false;
    await exec('UPDATE rule_entry_domain_cleanups SET "nextRetryAt" = NULL');
    out.switchedOffReconcile = await domain.reconcileRuleEntryDomains("test-switch-off");
    await idle();
    out.switchedOffCleaned = await snapshot();
    out.switchOn = await rules.update({ ...rule10Input, entryDomainEnabled: true });
    await idle();
    out.switchedOn = await snapshot();

    // 4. 服务商出错：机器 2 换了 IP，同步失败记在规则上；恢复后退避重试补上。
    failing = true;
    await exec('UPDATE hosts SET ip = ?, ipv4 = ? WHERE id = 2', ["198.51.100.2", "198.51.100.2"]);
    const hostAddress = await import(url("server/hostAddressRuntime.ts"));
    const db = await import(url("server/db.ts"));
    const host2 = await db.getHostById(2);
    await hostAddress.handleHostAddressChanged(2, host2, { ...host2, ip: "203.0.113.2", ipv4: "203.0.113.2" }, "test-address-changed");
    await idle();
    out.failed = await snapshot();
    failing = false;
    for (let i = 0; i < 100; i += 1) {
      await sleep(50);
      await idle();
      const current = await rows();
      if (!current[10].entryDomainError && !current[12].entryDomainError && current[10].entryDomainValue === "198.51.100.2") break;
    }
    out.retried = await snapshot();

    // 5. 解绑 12、界面删除 13。
    await subs.bindRule({ ruleId: 12, proxyNodeId: null });
    await idle();
    out.unbound = await snapshot();
    await rules.delete({ id: 13 });
    await idle();
    out.deleted = await snapshot();

    // 6. 规则 14 的行被直接删掉（Agent 确认停掉后的收尾），期间服务商暂时不可用：待删表兜住，之后补删。
    failing = true;
    await exec('UPDATE forward_rules SET "pendingDelete" = 1, "isEnabled" = 0 WHERE id = 14');
    await db.finalizeForwardRuleDelete(14);
    await idle();
    out.purgedWhileFailing = await snapshot();
    failing = false;
    await exec('UPDATE rule_entry_domain_cleanups SET "nextRetryAt" = NULL');
    out.purgeReconcile = await domain.reconcileRuleEntryDomains("test-purge");
    await idle();
    out.purged = await snapshot();

    // 7. 定时对账修漂移：绕过仓库直接改库（批量操作之类）隐藏了规则 10，对账把它撤掉；再显示回来又发布。
    await exec('UPDATE forward_rules SET "proxyNodeVisible" = 0 WHERE id = 10');
    await domain.reconcileRuleEntryDomains("test-drift");
    await idle();
    out.hidden = await snapshot();
    await exec('UPDATE forward_rules SET "proxyNodeVisible" = 1 WHERE id = 10');
    await domain.reconcileRuleEntryDomains("test-drift");
    await idle();
    out.shown = await snapshot();

    // 8. 改后缀：旧域名删掉、新域名发布。
    await system.updateSettings({ ddns: { ruleEntryDomainSuffix: "Edge.Example.NET." } });
    await idle();
    out.suffixChanged = { setting: (await query("SELECT value FROM system_settings WHERE key = 'ruleEntryDomainSuffix'"))[0]?.value, ...(await snapshot()) };

    // 9. 关掉功能：记录全删，订阅退回入口地址。
    await system.updateSettings({ ddns: { ruleEntryDomainSuffix: "" } });
    await idle();
    out.disabled = await snapshot();

    // 10. 后缀格式不对：设置接口直接报错。
    try {
      await system.updateSettings({ ddns: { ruleEntryDomainSuffix: "bad_label" } });
      out.badSuffix = "accepted";
    } catch (error) {
      out.badSuffix = String(error && error.message || error);
    }

    server.close();
    dns.close();
    console.log("OUTCOME " + JSON.stringify(out));
  `, { name: "rule-entry-domain", timeoutMs: 180_000 });
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = run();
const upserts = (calls: DnsCall[]) => calls.filter((call) => call.action === "replace");
const deletes = (calls: DnsCall[]) => calls.filter((call) => call.action === "delete");

test("纯函数：后缀规整（含国际化域名）、Webhook groupId 的取值空间", () => {
  assert.equal(normalizeRuleEntryDomainSuffixInput("  Node.Example.COM. "), "node.example.com");
  assert.equal(normalizeRuleEntryDomainSuffixInput("节点.example.com"), "xn--3px729a.example.com");
  assert.equal(normalizeRuleEntryDomainSuffixInput(""), "");
  assert.throws(() => normalizeRuleEntryDomainSuffixInput("bad_label"));
  // 转发组是正数、主机 DDNS 是 -hostId，规则域名落在 -10 亿以下，互不相撞。
  assert.equal(ruleEntryDomainWebhookGroupId(10), -1_000_000_010);
});

test("定时对账：绑了订阅的规则拿到 r<ID>.<后缀>，A 记录指向入口机", () => {
  const { rows, calls, subscription } = outcome.initial;
  assert.equal(rows[10].entryDomain, "r10.node.example.com");
  assert.equal(rows[10].entryDomainValue, "203.0.113.1");
  assert.ok(rows[10].entryDomainAt);
  assert.equal(rows[13].entryDomain, "r13.node.example.com");
  assert.equal(rows[14].entryDomain, "r14.node.example.com");
  assert.equal(rows[15].entryDomain, null, "没绑订阅的规则不该有域名");
  assert.equal(rows[12].entryDomain, null);
  assert.deepEqual(
    upserts(calls).find((call) => call.domain === "r10.node.example.com"),
    { action: "replace", domain: "r10.node.example.com", recordType: "A", values: ["203.0.113.1"], groupId: -1_000_000_010 },
  );
  assert.equal(upserts(calls).length, 3, JSON.stringify(calls));
  assert.ok(subscription.includes("@r10.node.example.com:40981"), subscription);
  assert.ok(!subscription.includes("@203.0.113.1:40981"), subscription);
});

test("界面上绑定订阅节点后立刻发布", () => {
  const { rows, calls, subscription } = outcome.bind;
  assert.equal(rows[12].entryDomain, "r12.node.example.com");
  assert.equal(rows[12].entryDomainValue, "203.0.113.2");
  assert.deepEqual(upserts(calls).map((call) => call.domain), ["r12.node.example.com"]);
  assert.ok(subscription.includes("@r12.node.example.com:40982"), subscription);
});

test("规则换到另一台入口的隧道：记录改指新入口，订阅地址不变", () => {
  assert.equal(outcome.update.success, true);
  const { rows, calls, subscription } = outcome.switched;
  assert.equal(Number(rows[10].hostId), 2);
  assert.equal(rows[10].entryDomain, "r10.node.example.com");
  assert.equal(rows[10].entryDomainValue, "203.0.113.2");
  assert.deepEqual(upserts(calls), [
    { action: "replace", domain: "r10.node.example.com", recordType: "A", values: ["203.0.113.2"], groupId: -1_000_000_010 },
  ]);
  assert.equal(deletes(calls).length, 0);
  assert.ok(subscription.includes("@r10.node.example.com:40981"), subscription);
  assert.ok(!subscription.includes("203.0.113.2:40981"), subscription);
});

test("对话框里关掉「专属域名」：域名进待删表、订阅立刻退回入口地址；再打开重新发布", () => {
  assert.equal(outcome.switchOff.success, true);
  const off = outcome.switchedOff;
  assert.equal(Number(off.rows[10].entryDomainEnabled), 0);
  // 服务商还没删成功，规则上的列已经清了、域名挂在待删表里。
  assert.equal(off.rows[10].entryDomain, null);
  assert.equal(off.rows[10].entryDomainValue, null);
  assert.equal(off.rows[10].entryDomainError, null);
  assert.deepEqual(off.cleanups.map((row: any) => [row.domain, row.recordType, Number(row.ruleId)]), [["r10.node.example.com", "A", 10]]);
  assert.ok(Number(off.cleanups[0].attempts) >= 1, JSON.stringify(off.cleanups));
  assert.equal(deletes(off.calls).length, 0, JSON.stringify(off.calls));
  // 订阅不等 DNS：立刻改回入口地址。
  assert.ok(off.subscription.includes("@203.0.113.2:40981"), off.subscription);
  assert.ok(!off.subscription.includes("r10.node.example.com"), off.subscription);
  // 别的规则不受影响。
  assert.equal(off.rows[12].entryDomain, "r12.node.example.com");
  assert.equal(off.rows[13].entryDomain, "r13.node.example.com");

  assert.equal(outcome.switchedOffReconcile.deleted, 1);
  const cleaned = outcome.switchedOffCleaned;
  assert.deepEqual(deletes(cleaned.calls), [
    { action: "delete", domain: "r10.node.example.com", recordType: "A", values: [], groupId: -1_000_000_010 },
  ]);
  assert.deepEqual(cleaned.cleanups, []);
  assert.equal(cleaned.rows[10].entryDomain, null);

  assert.equal(outcome.switchOn.success, true);
  const on = outcome.switchedOn;
  assert.equal(Number(on.rows[10].entryDomainEnabled), 1);
  assert.equal(on.rows[10].entryDomain, "r10.node.example.com");
  assert.equal(on.rows[10].entryDomainValue, "203.0.113.2");
  assert.deepEqual(upserts(on.calls), [
    { action: "replace", domain: "r10.node.example.com", recordType: "A", values: ["203.0.113.2"], groupId: -1_000_000_010 },
  ]);
  assert.deepEqual(on.cleanups, []);
  assert.ok(on.subscription.includes("@r10.node.example.com:40981"), on.subscription);
});

test("服务商出错：错误记在规则上、订阅照用域名；恢复后退避重试补上", () => {
  const failed = outcome.failed;
  assert.match(String(failed.rows[10].entryDomainError), /provider exploded/);
  assert.match(String(failed.rows[12].entryDomainError), /provider exploded/);
  // 发布成功过的值还在，订阅不因一次失败就退回 IP。
  assert.equal(failed.rows[10].entryDomainValue, "203.0.113.2");
  assert.ok(failed.subscription.includes("@r10.node.example.com:40981"), failed.subscription);
  // 机器 1 上的规则不受影响。
  assert.equal(failed.rows[13].entryDomainError, null);

  const retried = outcome.retried;
  assert.equal(retried.rows[10].entryDomainError, null);
  assert.equal(retried.rows[10].entryDomainValue, "198.51.100.2");
  assert.equal(retried.rows[12].entryDomainValue, "198.51.100.2");
  assert.ok(upserts(retried.calls).some((call) => call.domain === "r10.node.example.com" && call.values[0] === "198.51.100.2"));
});

test("解绑、界面删除：记录删掉、列清空", () => {
  const unbound = outcome.unbound;
  assert.deepEqual(deletes(unbound.calls), [
    { action: "delete", domain: "r12.node.example.com", recordType: "A", values: [], groupId: -1_000_000_012 },
  ]);
  assert.equal(unbound.rows[12].entryDomain, null);
  assert.equal(unbound.rows[12].entryDomainValue, null);
  assert.deepEqual(unbound.cleanups, []);
  assert.ok(!unbound.subscription.includes("r12.node.example.com"));

  const deleted = outcome.deleted;
  assert.deepEqual(deletes(deleted.calls).map((call) => call.domain), ["r13.node.example.com"]);
  assert.deepEqual(deleted.cleanups, []);
});

test("规则行被真正删掉时服务商不可用：待删表记下，之后对账补删", () => {
  const failing = outcome.purgedWhileFailing;
  assert.equal(failing.rows[14], undefined, "规则行应已删除");
  assert.equal(failing.cleanups.length, 1);
  assert.equal(failing.cleanups[0].domain, "r14.node.example.com");
  assert.equal(failing.cleanups[0].recordType, "A");
  assert.ok(Number(failing.cleanups[0].attempts) >= 1, JSON.stringify(failing.cleanups));

  assert.equal(outcome.purgeReconcile.deleted, 1);
  assert.deepEqual(deletes(outcome.purged.calls).map((call) => call.domain), ["r14.node.example.com"]);
  assert.deepEqual(outcome.purged.cleanups, []);
});

test("定时对账修漂移：绕过接口改了库也能撤掉 / 补上", () => {
  assert.deepEqual(deletes(outcome.hidden.calls).map((call) => call.domain), ["r10.node.example.com"]);
  assert.equal(outcome.hidden.rows[10].entryDomain, null);
  assert.deepEqual(upserts(outcome.shown.calls).map((call) => call.domain), ["r10.node.example.com"]);
  assert.equal(outcome.shown.rows[10].entryDomainValue, "198.51.100.2");
});

test("改后缀：旧域名删掉、新域名发布，订阅跟着换", () => {
  const changed = outcome.suffixChanged;
  assert.equal(changed.setting, "edge.example.net");
  assert.equal(changed.rows[10].entryDomain, "r10.edge.example.net");
  assert.deepEqual(deletes(changed.calls).map((call) => call.domain), ["r10.node.example.com"]);
  assert.deepEqual(upserts(changed.calls).map((call) => call.domain), ["r10.edge.example.net"]);
  assert.ok(changed.subscription.includes("@r10.edge.example.net:40981"), changed.subscription);
  assert.deepEqual(changed.cleanups, []);
});

test("关掉功能：记录全删，订阅退回入口地址", () => {
  const disabled = outcome.disabled;
  assert.deepEqual(deletes(disabled.calls).map((call) => call.domain), ["r10.edge.example.net"]);
  assert.equal(upserts(disabled.calls).length, 0);
  for (const row of Object.values(disabled.rows) as any[]) assert.equal(row.entryDomain, null, JSON.stringify(row));
  assert.deepEqual(disabled.cleanups, []);
  assert.ok(disabled.subscription.includes("@198.51.100.2:40981"), disabled.subscription);
  assert.ok(!disabled.subscription.includes("example.net"), disabled.subscription);
});

test("后缀格式不对：设置接口直接报错", () => {
  assert.match(String(outcome.badSuffix), /后缀格式不正确/);
});

test("升级旧库：forward_rules 补上开关和四列、待删表建出来，已有规则不受影响、开关缺省开着", () => {
  const result = runInDatabase(String.raw`
      // 退回到加这个功能之前的样子。
      for (const column of ["entryDomainEnabled", "entryDomain", "entryDomainValue", "entryDomainAt", "entryDomainError"]) {
        await exec('ALTER TABLE "forward_rules" DROP COLUMN "' + column + '"');
      }
      await exec('DROP TABLE "rule_entry_domain_cleanups"');
      await exec('INSERT INTO forward_rules (id, "hostId", name, "sourcePort", "targetIp", "targetPort", "userId") VALUES (1, 1, ?, 1000, ?, 80, 1)', ["legacy", "198.51.100.1"]);
      await schema.ensureDatabaseSchema();
      const postgres = runtime.getDatabaseKind() === "postgresql";
      const columns = postgres
        ? (await query("SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'forward_rules'")).map((row) => row.name)
        : (await query('PRAGMA table_info("forward_rules")')).map((row) => row.name);
      const tables = postgres
        ? (await query("SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'rule_entry_domain_cleanups'")).map((row) => row.name)
        : (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rule_entry_domain_cleanups'")).map((row) => row.name);
      const [rule] = await query('SELECT name, "entryDomainEnabled", "entryDomain", "entryDomainValue" FROM forward_rules WHERE id = 1');
      console.log("OUTCOME " + JSON.stringify({ columns, tables, rule }));
  `, { name: "rule-entry-domain-upgrade" });
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, result.stdout + result.stderr);
  const upgraded = JSON.parse(line!.slice("OUTCOME ".length));
  for (const column of ["entryDomainEnabled", "entryDomain", "entryDomainValue", "entryDomainAt", "entryDomainError"]) {
    assert.ok(upgraded.columns.includes(column), "forward_rules 缺列: " + column);
  }
  assert.deepEqual(upgraded.tables, ["rule_entry_domain_cleanups"]);
  // 老规则的开关补出来就是开着的：升级前后行为不变。
  assert.deepEqual({ ...upgraded.rule, entryDomainEnabled: Number(upgraded.rule.entryDomainEnabled) }, { name: "legacy", entryDomainEnabled: 1, entryDomain: null, entryDomainValue: null });
});
