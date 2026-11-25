import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * forwardGroups.list 对租户只读看得见的组，而不是整表读完再丢。
 *
 * 这是纯性能改动，返回必须和以前逐字节一样。这里把以前的算法（整表读、整表算可用性、
 * 再按可见范围过滤）原样抄在脚本里当基准，和新接口的返回直接比。场景里故意放了：
 * 看不见的组挂着隧道成员（决定主机在线从哪取）、转发链的入口组、看不见的普通组。
 */
test("租户的 forwardGroups.list 只读可见组，结果和整表算的一致", () => {
  runInDatabase(String.raw`
    let recording = false;
    let statements = [];
    if (runtime.getDatabaseKind() === "postgresql") {
      const pg = (await import("pg")).default;
      const originalQuery = pg.Client.prototype.query;
      pg.Client.prototype.query = function (config, ...rest) {
        if (recording) statements.push(String(typeof config === "string" ? config : config?.text));
        return originalQuery.call(this, config, ...rest);
      };
    } else {
      const Database = (await import("better-sqlite3")).default;
      const originalPrepare = Database.prototype.prepare;
      Database.prototype.prepare = function (sql) {
        if (recording) statements.push(String(sql));
        return originalPrepare.call(this, sql);
      };
    }

    const now = Math.floor(Date.now() / 1000);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'h', 'user')");
    for (const [id, online] of [[1, 1], [2, 1], [3, 0], [4, 1]]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [id, "h" + id, "10.0.0." + id, "10.0.0." + id, "slave", "tok" + id, online, now]);
    }
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", secret, "userId", "isEnabled", "isRunning") VALUES (1, ?, 1, 2, ?, 30000, ?, 1, 1, 1)', ["t", "tls", "s"]);
    const group = (id, mode, extra = {}) => exec(
      "INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, targetPort, userId, isEnabled, domain, entryGroupId, sortOrder) VALUES (?, ?, 'host', ?, '127.0.0.1', 80, 1, 1, ?, ?, ?)",
      [id, "g" + id, mode, extra.domain ?? "g" + id + ".example.com", extra.entryGroupId ?? null, extra.sortOrder ?? id],
    );
    const member = (id, groupId, fields) => exec(
      "INSERT INTO forward_group_members (id, groupId, memberType, hostId, tunnelId, priority, isEnabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [id, groupId, fields.tunnelId ? "tunnel" : "host", fields.hostId ?? null, fields.tunnelId ?? null, id],
    );
    // 1：租户可见的普通转发组（主机 1、3，3 离线）
    await group(1, "failover");
    await member(11, 1, { hostId: 1 });
    await member(12, 1, { hostId: 3 });
    // 2：租户可见的转发链，入口组是 3（可见范围会顺带把 3 算进来）
    await group(3, "entry");
    await member(31, 3, { hostId: 4 });
    await group(2, "chain", { entryGroupId: 3, domain: "" });
    await member(21, 2, { hostId: 2 });
    // 4：看不见、挂隧道成员 —— 它决定了「整表算」时主机在线从哪取
    await group(4, "failover");
    await member(41, 4, { tunnelId: 1 });
    // 5：看不见的普通组
    await group(5, "failover");
    await member(51, 5, { hostId: 2 });
    await exec("INSERT INTO user_forward_group_permissions (userId, forwardGroupId) VALUES (2, 1), (2, 2)");

    const db = await import(url("server/db.ts"));
    const { getLinkAccessScope, visibleForwardGroupMemberIds } = await import(url("server/linkAccessView.ts"));
    const { buildForwardGroupAvailabilitySummaryIndex, publicLinkAvailabilitySummary } = await import(url("server/linkAvailabilitySummary.ts"));
    const { forwardGroupsRouter } = await import(url("server/routers/forwardGroups.ts"));

    // 改动前的算法，一字不差。
    const legacyList = async (user) => {
      const [groups, accessScope] = await Promise.all([
        db.getForwardGroups(undefined, { includeRuntime: true }),
        getLinkAccessScope(user),
      ]);
      const index = await buildForwardGroupAvailabilitySummaryIndex(groups);
      const attach = (items, scope) => items.map((item) => ({
        ...item,
        availability: publicLinkAvailabilitySummary(
          index.groupAvailabilityById.get(Number(item.id)),
          visibleForwardGroupMemberIds(item, scope),
        ),
      }));
      if (!accessScope) return attach(groups, null);
      const visible = groups.filter((item) => accessScope.groupIds.has(Number(item.id)));
      return db.filterForwardGroupFieldsForUse(attach(visible, accessScope), accessScope);
    };
    const context = (user) => ({ user, req: { headers: {} }, res: { setHeader: () => {} } });
    const normalize = (value) => JSON.parse(JSON.stringify(value));

    for (const user of [{ id: 2, role: "user", username: "tenant" }, { id: 1, role: "admin", username: "admin" }]) {
      const expected = normalize(await legacyList(user));
      statements = []; recording = true;
      const actual = normalize(await forwardGroupsRouter.createCaller(context(user)).list());
      recording = false;
      assert.deepEqual(actual, expected, user.role + " 的返回和整表算的不一致");
      if (user.role === "user") {
        assert.deepEqual(actual.map((item) => Number(item.id)).sort(), [1, 2, 3], "测试前提：租户看得见 1、2 和链的入口组 3");
        assert.ok(actual.every((item) => item.availability && item.availability.status), "测试前提：每个组都算出了可用性");
        const groupReads = statements.filter((sql) => /from\s+"forward_groups"/i.test(sql) && !/join/i.test(sql));
        assert.ok(groupReads.length > 0 && groupReads.every((sql) => /where/i.test(sql)), "租户这条路不该整表读 forward_groups：\n" + groupReads.join("\n"));
      }
    }
    console.log("GROUP_LIST_SCOPE_OK");
  `, { name: "group-list-scope", env: { NODE_ENV: "test" } });
});
