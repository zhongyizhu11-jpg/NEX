import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("per-IP-only refresh preserves ordinary running rules while retaining tunnel refresh behavior", () => {
  runInDatabase(String.raw`
    const { refreshUserForwardEndpoints } = await import(url("server/routers/helpers.ts"));
    await exec('INSERT INTO users (id, username, password, role, "canAddRules") VALUES (1, ?, ?, ?, 1)', ['owner', 'x', 'admin']);
    await exec('INSERT INTO hosts (id, name, ip, "userId") VALUES (1, ?, ?, 1)', ['entry', '198.51.100.1']);
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "isRunning") VALUES (1, ?, 1, 1, ?, 19000, 1, 1, 1)', ['tunnel', 'tls']);
    for (const [id, type, tunnelId] of [[1, 'iptables', null], [2, 'nftables', null], [3, 'realm', null], [4, 'socat', null], [5, 'gost', null], [6, 'nginx', null], [7, 'gost', 1]]) {
      await exec('INSERT INTO forward_rules (id, name, "hostId", "userId", "sourcePort", "targetIp", "targetPort", "forwardType", protocol, "tunnelId", "isEnabled", "isRunning", "pendingDelete") VALUES (?, ?, 1, 1, ?, ?, 443, ?, ?, ?, 1, 1, 0)', [id, 'rule-' + id, 22000 + id, '203.0.113.10', type, 'tcp', tunnelId]);
    }
    await refreshUserForwardEndpoints(1, 'test-per-IP-change', { preserveOrdinaryRuntime: true });
    const running = (value) => value === true || value === 1 || value === '1';
    for (const rule of await query('SELECT id, "isRunning" FROM forward_rules ORDER BY id')) {
      assert.equal(running(rule.isRunning), Number(rule.id) !== 7, 'incorrect runtime reset for rule ' + rule.id);
    }
    await refreshUserForwardEndpoints(1, 'test-other-limit-change');
    for (const rule of await query('SELECT "isRunning" FROM forward_rules')) assert.equal(running(rule.isRunning), false);
  `, { name: "port-limits" });
});
