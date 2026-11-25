import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("confirmed Agent offline overrides fresh forwarding health and triggers DDNS failover", () => {
  runInDatabase(String.raw`
    const groups = await import(url("server/db.ts"));
    const hostStatus = await import(url("server/hostStatusNotifier.ts"));

    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      const placeholders = values.map(() => "?").join(", ");
      await exec(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + placeholders + ")",
        values,
      );
    };
    const nowSeconds = Math.floor(Date.now() / 1000);

    for (const [id, name, address, lastHeartbeat] of [
      [1, "primary", "198.51.100.10", nowSeconds - 151],
      [2, "standby", "198.51.100.20", nowSeconds],
    ]) {
      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
        [id, name, address, address, 1, 1, lastHeartbeat],
      );
    }

    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds", "recoverSeconds", "autoFailback"],
      [10, "failover", "host", "failover", "failover.example.test", "A", "0.0.0.0", 1, 1, 101, "198.51.100.10", 10, 120, 0],
    );
    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds", "recoverSeconds"],
      [20, "entry", "host", "entry", "entry.example.test", "A", "0.0.0.0", 1, 1, 201, "198.51.100.10,198.51.100.20", 10, 10],
    );
    for (const [id, groupId, hostId, priority] of [
      [101, 10, 1, 0],
      [102, 10, 2, 1],
      [201, 20, 1, 0],
      [202, 20, 2, 1],
    ]) {
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt", "healthySince"],
        [id, groupId, "host", hostId, priority, 1, "healthy", nowSeconds, nowSeconds - 20],
      );
    }
    await exec('UPDATE "forward_group_members" SET "failureSince" = ? WHERE "id" IN (101, 201)', [nowSeconds - 20]);
    await insert(
      "forward_rules",
      ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
      [100, 1, "template", "iptables", "tcp", 10, 1, 16000, "203.0.113.10", 80, 1, 1, 0],
    );
    for (const [id, hostId, memberId] of [[110, 1, 101], [120, 2, 102]]) {
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "gostMode", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [id, hostId, "managed child", "iptables", "tcp", "direct", 10, 100, memberId, 0, 16000, "203.0.113.10", 80, 1, 1, 1],
      );
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [id, hostId, 10, 0, "healthy", 0, nowSeconds],
      );
    }

    // 主机 2 连着面板（有快速存活状态）；主机 1 的快速存活刚判了离线 —— 评估里「没有这份状态 / 确认离线」
    // 都算离线（server/forwardGroups/liveness.ts），这里不登记它。
    (await import(url("server/agentFastLiveness.ts"))).registerPresenceCapableHost(2);
    const offlineAt = Date.now();
    await hostStatus.handlePresenceCapableHostOffline({
      kind: "confirmed-offline",
      hostId: 1,
      agentVersion: "2.2.186",
      transitionEpoch: 1,
      lastSeenAt: (nowSeconds - 20) * 1000,
      deadlineAt: offlineAt,
      offlineAt,
      lastOfflineAt: offlineAt,
      confirmedOffline: true,
      isCurrent: () => true,
    });
    const deadline = Date.now() + 2_000;
    let failoverState;
    let entryState;
    do {
      [failoverState] = await query(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      );
      [entryState] = await query(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 20',
      );
      if (Number(failoverState?.activeMemberId) === 102 && entryState?.lastDdnsValue === "198.51.100.20") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);

    assert.equal(Number((await query('SELECT "isOnline" FROM "hosts" WHERE "id" = 1'))[0]?.isOnline), 0);
    assert.equal(Number(failoverState?.activeMemberId), 102);
    assert.equal(failoverState?.lastDdnsValue, "198.51.100.20");
    assert.equal(Number(entryState?.activeMemberId), 202);
    assert.equal(entryState?.lastDdnsValue, "198.51.100.20");
  `, { name: "group-liveness" });
});

test("presence-capable hosts stay eligible during panel startup grace", () => {
  runInDatabase(String.raw`
    const groups = await import(url("server/db.ts"));
    const fastLiveness = await import(url("server/agentFastLiveness.ts"));
    const now = Math.floor(Date.now() / 1000);

    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [1, "primary", "198.51.100.10", "198.51.100.10", 1, 0, now - 300, "2.2.171"],
    );
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [2, "standby", "198.51.100.20", "198.51.100.20", 1, 1, now],
    );
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "isOnline", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [3, "never connected", "198.51.100.30", "198.51.100.30", 1, 0, now - 300, now - 300],
    );
    await exec(
      'INSERT INTO "forward_groups" ("id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [30, "startup grace", "host", "failover", "0.0.0.0", 1, 1, 301, "198.51.100.10", 0],
    );
    for (const [id, hostId, priority] of [[301, 1, 0], [302, 2, 1]]) {
      await exec(
        'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "isEnabled") VALUES (?, ?, ?, ?, ?, ?)',
        [id, 30, "host", hostId, priority, 1],
      );
    }
    await exec(
      'INSERT INTO "forward_groups" ("id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [31, "legacy no heartbeat", "host", "failover", "0.0.0.0", 1, 1, 311, "198.51.100.30", 0],
    );
    for (const [id, hostId, priority] of [[311, 3, 0], [312, 2, 1]]) {
      await exec(
        'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "isEnabled") VALUES (?, ?, ?, ?, ?, ?)',
        [id, 31, "host", hostId, priority, 1],
      );
    }

    assert.equal(await groups.primeForwardGroupHostLivenessDeadlines(), 1);
    assert.equal(fastLiveness.getPresenceCapableHostLivenessSnapshot(1)?.confirmedOffline, false);
    // 主机 2 库里没有版本号（预热不登记它），但它连着面板：第一次 presence 就登记上。
    assert.equal(fastLiveness.getPresenceCapableHostLivenessSnapshot(2), null);
    fastLiveness.registerPresenceCapableHost(2);
    // 主机 3 从没连过面板：没有快速存活状态，就是离线。
    assert.equal(fastLiveness.getPresenceCapableHostLivenessSnapshot(3), null);
    await groups.runForwardGroupFailover(30);

    const [state] = await query(
      'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 30',
    );
    assert.equal(Number(state?.activeMemberId), 301);
    assert.equal(state?.lastDdnsValue, "198.51.100.10");

    await groups.runForwardGroupFailover(31);
    const [legacyState] = await query(
      'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 31',
    );
    assert.equal(Number(legacyState?.activeMemberId), 312, "a host that never connected (no fast-liveness state) reads offline");
    assert.equal(legacyState?.lastDdnsValue, "198.51.100.20");
  `, { name: "group-startup-grace" });
});

/*
  没有快速存活状态的主机在评估里算离线。面板刚启动、预热（按库里的主机登记快速存活状态）还没做完的那几秒，
  所有成员都没有这份状态 —— 这时不能把解析换走，要等预热做完（就绪宽限里挂起，过几秒再评估）。
*/
test("before host liveness is primed, the readiness grace keeps the published record", () => {
  runInDatabase(String.raw`
    const groups = await import(url("server/db.ts"));
    const readiness = await import(url("server/forwardGroups/readiness.ts"));
    const now = Math.floor(Date.now() / 1000);
    for (const [id, address] of [[1, "198.51.100.10"], [2, "198.51.100.20"]]) {
      await exec(
        'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, "host-" + id, address, address, 1, 1, now, "2.2.264"],
      );
    }
    await exec(
      'INSERT INTO "forward_groups" ("id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [40, "unprimed", "host", "failover", "0.0.0.0", 1, 1, 401, "198.51.100.10", 0],
    );
    for (const [id, hostId, priority] of [[401, 1, 0], [402, 2, 1]]) {
      await exec(
        'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "isEnabled") VALUES (?, ?, ?, ?, ?, ?)',
        [id, 40, "host", hostId, priority, 1],
      );
    }
    // 面板「就绪」了（调度器起来），预热还没做完
    readiness.setForwardGroupPanelReadyAtForTests(Date.now());
    await groups.runForwardGroupFailover(40);
    let [state] = await query('SELECT "activeMemberId", "lastDdnsValue", "lastMessage" FROM "forward_groups" WHERE "id" = 40');
    assert.equal(Number(state.activeMemberId), 401);
    assert.equal(state.lastDdnsValue, "198.51.100.10");
    assert.match(String(state.lastMessage), /主机在线状态还没加载完/);

    // 预热做完：两台都按库里的版本号登记（启动宽限里算在线），照常评估，活动成员不动
    assert.equal(await groups.primeForwardGroupHostLivenessDeadlines(), 2);
    await groups.runForwardGroupFailover(40);
    [state] = await query('SELECT "activeMemberId", "lastDdnsValue", "lastMessage" FROM "forward_groups" WHERE "id" = 40');
    assert.equal(Number(state.activeMemberId), 401);
    assert.doesNotMatch(String(state.lastMessage), /主机在线状态还没加载完/);
    readiness.setForwardGroupPanelReadyAtForTests(0);
  `, { name: "group-unprimed" });
});
