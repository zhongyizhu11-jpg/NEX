import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 机器掉线了，库里那些「正在跑」的行也要跟着改。
 *
 * 心跳超时只改 hosts.isOnline。forward_rules.isRunning 和 tunnels.isRunning 是
 * Agent 上一次上报时写下的结论 —— 机器没了，没人再来改它。于是一台已经掉线几个
 * 小时的机器，它的转发在面板上仍然是绿的，鼠标移上去写着**「Agent 已确认规则
 * 运行」**：不是含糊的「状态未知」，是一句言之凿凿的假话，而这一页正是人出事时
 * 第一个打开的地方。
 *
 * 清成「等待 Agent 上报」而不是「错误」：机器回来时下一次心跳就会重新写上
 * isRunning，中间这段确实只是不知道。掉线本身另有状态点和 Telegram 通知在说。
 */
test("SQLite 主机掉线后，它的转发与隧道不再自称运行中", () => {
  runInDatabase(String.raw`
    const { resolveForwardRuleVisualStatus } = await import(url("client/src/lib/forwardRuleStatus.ts"));

    const staleSeconds = Math.floor((Date.now() - 6 * 60 * 60 * 1000) / 1000);
    const freshSeconds = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [10, "掉线的机器", "203.0.113.10", "tok10", 1, 1, staleSeconds],
    );
    await exec(
      'INSERT INTO hosts (id, name, ip, "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [11, "还活着的机器", "203.0.113.11", "tok11", 1, 1, freshSeconds],
    );
    const addRule = (id, hostId) => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, hostId, "转发" + id, 8080 + id, "198.51.100.1", 80, 1, 1, 1],
    );
    await addRule(1, 10);
    await addRule(2, 11);
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", "listenPort", "userId", "isEnabled", "isRunning")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [1, "经过掉线机器的链路", 10, 11, 9000, 1, 1, 1],
    );

    const ruleRunning = async (id) => Number(
      (await query('SELECT "isRunning" FROM forward_rules WHERE id = ?', [id]))[0].isRunning,
    );
    const tunnelRunning = async (id) => Number(
      (await query('SELECT "isRunning" FROM tunnels WHERE id = ?', [id]))[0].isRunning,
    );

    /**
     * 走真正的掉线处理入口，而不是直接调那个清理函数。
     *
     * 清理函数本来就在（地址变更那条路一直在用），这一处的 Bug 从来不是「没有
     * 这个能力」，而是**掉线时没人调它**。绕过入口去测，等于把唯一出问题的那一
     * 环测掉了。
     */
    const notifier = await import(url("server/hostStatusNotifier.ts"));
    await notifier.sweepOfflineHostsAndNotify();

    assert.equal(
      Number((await query('SELECT "isOnline" FROM hosts WHERE id = ?', [10]))[0].isOnline),
      0,
      "心跳超时的机器该被判离线",
    );
    assert.equal(
      Number((await query('SELECT "isOnline" FROM hosts WHERE id = ?', [11]))[0].isOnline),
      1,
      "心跳还新鲜的机器不该被顺手判离线",
    );

    assert.equal(
      await ruleRunning(1),
      0,
      "机器掉线几个小时了，它的转发还在库里写着运行中 —— 面板会照着它说「Agent 已确认规则运行」",
    );
    assert.equal(await tunnelRunning(1), 0, "经过掉线机器的链路同样不可能还在跑");
    assert.equal(await ruleRunning(2), 1, "另一台机器还活着，不该被顺手清掉");

    /** 清掉之后面板说的那句话必须跟着变。 */
    const before = resolveForwardRuleVisualStatus({
      ruleEnabled: true, ruleRunning: true, groupEnabled: true, groupConfigStatus: "available",
    });
    assert.equal(before.title, "Agent 已确认规则运行");
    const after = resolveForwardRuleVisualStatus({
      ruleEnabled: true, ruleRunning: false, groupEnabled: true, groupConfigStatus: "available",
    });
    assert.equal(after.state, "pending", "清成待确认，而不是报错 —— 机器回来下一次心跳就会重新写上");
    assert.notEqual(after.title, before.title);
  `, { name: "offline-runtime" });
});
