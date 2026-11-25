import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 收回主机授权之后，用户自己搭在那台机器上的隧道也要停：
 *
 *   - 访问范围里不再把它算成可用（选不到、建不了规则、开不了规则）
 *   - 已有规则按「授权失效」停下，授权回来后自动恢复
 *   - 被整条授权 / 自己机器上的隧道不受影响
 */
test("revoking a host grant stops rules on the user's own tunnels that pass through it", () => {
  runInDatabase(String.raw`
    const linkAccess = await import(url("server/linkAccessView.ts"));
    const helpers = await import(url("server/routers/helpers.ts"));
    const { usersRouter } = await import(url("server/routers/users.ts"));
    const { RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON } = await import(url("server/ruleResourceAuthorization.ts"));
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => exec(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const state = async (id) => (await query('SELECT "isEnabled", "protocolBlockReason" FROM "forward_rules" WHERE "id" = ?', [id]))[0];
    const now = Math.floor(Date.now() / 1000);
    await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled"], [1, "admin", "x", "admin", 1, 1, 1]);
    await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled"], [2, "member", "x", "user", 1, 1, 1]);
    for (const [id, ownerId] of [[1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 1]]) {
      await insert("hosts", ["id", "name", "ip", "userId", "isOnline", "lastHeartbeat"], [id, "h" + id, "198.18.1." + id, ownerId, 1, now]);
    }
    for (const hostId of [1, 2, 3]) await insert("user_host_permissions", ["userId", "hostId"], [2, hostId]);
    const tunnelCols = ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"];
    // 40：自己搭的，出口在管理员授权的 2 号机上
    await insert("tunnels", tunnelCols, [40, "own-over-granted", 1, 2, "tls", 24040, 2, 1]);
    // 41：自己搭的，额外出口在 3 号机上
    await insert("tunnels", tunnelCols, [41, "own-extra-exit", 4, 5, "tls", 24041, 2, 1]);
    await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "isEnabled"], [410, 41, 1, 3, 24141, 1]);
    // 42：全在自己的机器上
    await insert("tunnels", tunnelCols, [42, "own-hosts", 4, 5, "tls", 24042, 2, 1]);
    // 43：管理员整条授权给他的隧道，走的机器他没有单独授权
    await insert("tunnels", tunnelCols, [43, "granted", 6, 2, "tls", 24043, 1, 1]);
    await insert("user_tunnel_permissions", ["userId", "tunnelId"], [2, 43]);
    const ruleCols = ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
    await insert("forward_rules", ruleCols, [140, 1, "on-40", "gost", "tcp", 40, 11040, "203.0.113.40", 80, 2, 1, 1]);
    await insert("forward_rules", ruleCols, [141, 4, "on-41", "gost", "tcp", 41, 11041, "203.0.113.41", 80, 2, 1, 1]);
    await insert("forward_rules", ruleCols, [142, 4, "on-42", "gost", "tcp", 42, 11042, "203.0.113.42", 80, 2, 1, 1]);
    await insert("forward_rules", ruleCols, [143, 6, "on-43", "gost", "tcp", 43, 11043, "203.0.113.43", 80, 2, 1, 1]);

    const member = { id: 2, role: "user" };
    linkAccess.clearLinkAccessScopeCache();
    const before = await linkAccess.getLinkAccessScope(member);
    for (const id of [40, 41, 42, 43]) assert.ok(before.useTunnelIds.has(id), "tunnel " + id + " starts usable");

    const adminUsers = usersRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
    await adminUsers.setHostPermissions({ userId: 2, hostIds: [1] });
    linkAccess.clearLinkAccessScopeCache();
    const after = await linkAccess.getLinkAccessScope(member);
    assert.equal(after.useTunnelIds.has(40), false, "an owned tunnel whose exit host was revoked must not stay usable");
    assert.equal(after.useTunnelIds.has(41), false, "extra exit hosts count too");
    assert.equal(after.useTunnelIds.has(42), true, "a tunnel on the user's own hosts is unaffected");
    assert.equal(after.useTunnelIds.has(43), true, "a tunnel granted as a whole does not depend on host grants");
    assert.equal(after.tunnelIds.has(40), true, "the tunnel itself stays visible so it can be edited or deleted");

    assert.equal(Number((await state(140)).isEnabled), 0);
    assert.equal((await state(140)).protocolBlockReason, RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON);
    assert.equal(Number((await state(141)).isEnabled), 0);
    assert.equal(Number((await state(142)).isEnabled), 1);
    assert.equal(Number((await state(143)).isEnabled), 1);

    await assert.rejects(() => helpers.requireTunnelUseOrTrafficBillingAccess({ user: member }, 40), /授权范围/);
    await helpers.requireTunnelUseOrTrafficBillingAccess({ user: member }, 42);
    const gated = await linkAccess.gateForwardRulesForRuntime([
      { id: 140, userId: 2, hostId: 1, tunnelId: 40, isEnabled: true },
      { id: 142, userId: 2, hostId: 4, tunnelId: 42, isEnabled: true },
    ]);
    assert.equal(gated[0].isEnabled, false, "runtime gate must stop the listener even before the row is updated");
    assert.equal(gated[1].isEnabled, true);

    await adminUsers.setHostPermissions({ userId: 2, hostIds: [1, 2, 3] });
    assert.equal(Number((await state(140)).isEnabled), 1, "restoring the grant resumes the rule");
    assert.equal((await state(140)).protocolBlockReason, null);
    assert.equal(Number((await state(141)).isEnabled), 1);
    await helpers.requireTunnelUseOrTrafficBillingAccess({ user: member }, 40);
  `, { name: "owned-tunnel-revoke" });
});
