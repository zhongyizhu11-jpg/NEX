import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseTarget, telegramKeywordCommand } from "./telegramBotMore";

test("回复的目标地址：IP:端口、域名:端口、[IPv6]:端口", () => {
  assert.deepEqual(parseTarget("1.2.3.4:443"), { host: "1.2.3.4", port: 443 });
  assert.deepEqual(parseTarget(" hk.example.com:8080 "), { host: "hk.example.com", port: 8080 });
  assert.deepEqual(parseTarget("[2001:db8::1]:53"), { host: "2001:db8::1", port: 53 });
  assert.equal(parseTarget("1.2.3.4"), null);
  assert.equal(parseTarget("1.2.3.4:70000"), null);
});

test("直接打「菜单」「链路」这类词也能打开功能，别的照旧交给智能查询", () => {
  assert.equal(telegramKeywordCommand("菜单"), "/menu");
  assert.equal(telegramKeywordCommand("链路。"), "/links");
  assert.equal(telegramKeywordCommand("续费"), "/buy");
  assert.equal(telegramKeywordCommand("查一下我的流量"), null);
});

test("机器人新按钮走面板接口：看链路、手动切出口、改规则目标；普通用户进不了管理页", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tg-more-"));
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "tg.db") } });
    await ensureDatabaseSchema();
    const exec = (sql: string, params: unknown[] = []) => runtime.executeRaw(sql, params);
    const now = new Date(Date.now() + 3600_000);
    await exec(`INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin'), (2, 'bob', 'x', 'user')`);
    for (const [id, name] of [[1, "入口"], [2, "jinx"], [3, "hep ix"]] as const) {
      await exec(`INSERT INTO hosts (id, name, ip, "userId", "isOnline", "lastHeartbeat", "agentVersion", "hostType") VALUES (?, ?, ?, 1, 1, ?, '2.2.261', 'slave')`, [id, name, `198.51.100.${id}`, now]);
    }
    await exec(`INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "forwardxVersion", "listenPort", "userId", secret, "loadBalanceEnabled", "loadBalanceStrategy", "isEnabled", "isRunning") VALUES (1, '华南-香港', 1, 2, 'forwardx', 'v1', 40001, 1, 's', 1, 'latency', 1, 1)`);
    await exec(`INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (1, 1, 3, 40002, 1)`);
    await exec(`INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (7, 1, 'r7', 'iptables', 'tcp', 30007, '203.0.113.7', 80, 1, 1, 1)`);

    const more = await import("./telegramBotMore");
    const db = await import("./db");
    const admin = await db.getUserById(1);
    const bob = await db.getUserById(2);
    const outputs: string[] = [];
    const io = {
      edit: async (text: string) => { outputs.push(text); },
      send: async (text: string) => { outputs.push(text); },
    };
    const run = (data: string, user: unknown) => more.handleTelegramMoreCallback({ data, chatId: 1, telegramId: 9, user: user as never, io });

    assert.equal(await run("fx:x:links:0", admin), true);
    assert.match(outputs.at(-1)!, /共 1 条/);
    await run("fx:x:link:1:0", admin);
    assert.match(outputs.at(-1)!, /jinx/);
    assert.match(outputs.at(-1)!, /hep ix/);

    await run("fx:x:pin:1:3:0", admin);
    assert.match(outputs.at(-1)!, /已手动指定/);
    assert.equal(Number((await db.getTunnelById(1) as { balancePinHostId?: number }).balancePinHostId), 3);
    await run("fx:x:pin:1:0:0", admin);
    assert.equal((await db.getTunnelById(1) as { balancePinHostId?: number | null }).balancePinHostId ?? null, null);

    await run("fx:x:rt:7:0", admin);
    assert.match(outputs.at(-1)!, /改规则 #7 的目标/);
    assert.equal(await more.handleTelegramMoreReply({ chatId: 1, telegramId: 9, user: admin as never, text: "203.0.113.99:8443", io }), true);
    const rule = await db.getForwardRuleById(7) as { targetIp: string; targetPort: number };
    assert.deepEqual([rule.targetIp, rule.targetPort], ["203.0.113.99", 8443]);
    assert.equal(await more.handleTelegramMoreReply({ chatId: 1, telegramId: 9, user: admin as never, text: "随便说点什么", io }), false, "回复一次就结束，下一条照常处理");

    await run("fx:x:sys", bob);
    assert.match(outputs.at(-1)!, /只有管理员/);
    await run("fx:x:pin:1:3:0", bob);
    assert.match(outputs.at(-1)!, /没成功/, "普通用户不是链路的主人：面板接口拒绝");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
