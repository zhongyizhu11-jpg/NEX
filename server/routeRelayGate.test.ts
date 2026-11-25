import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("route-group relay rules only run while their parent rule runs", () => {
  runInDatabase(String.raw`
    const { gateForwardRulesForRuntime } = await import(url("server/linkAccessView.ts"));
    await exec('INSERT INTO "users" ("id", "username", "password", "role") VALUES (1, \'admin\', \'x\', \'admin\')');
    await exec('INSERT INTO "hosts" ("id", "name", "ip", "userId") VALUES (1, \'h\', \'198.51.100.1\', 1)');
    const cols = '"id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "routeParentRuleId"';
    await exec('INSERT INTO "forward_rules" (' + cols + ') VALUES (10, 1, \'parent-off\', \'iptables\', \'tcp\', 11000, \'203.0.113.1\', 80, 1, 0, NULL)');
    await exec('INSERT INTO "forward_rules" (' + cols + ') VALUES (11, 1, \'parent-on\', \'iptables\', \'tcp\', 11001, \'203.0.113.1\', 80, 1, 1, NULL)');
    const relayOfOff = { id: 20, userId: 1, hostId: 1, isEnabled: true, routeParentRuleId: 10 };
    const relayOfOn = { id: 21, userId: 1, hostId: 1, isEnabled: true, routeParentRuleId: 11 };
    const relayOfMissing = { id: 22, userId: 1, hostId: 1, isEnabled: true, routeParentRuleId: 999 };
    const plain = { id: 23, userId: 1, hostId: 1, isEnabled: true, routeParentRuleId: null };
    const gated = await gateForwardRulesForRuntime([relayOfOff, relayOfOn, relayOfMissing, plain]);
    const byId = new Map(gated.map((rule) => [rule.id, rule]));
    assert.equal(byId.get(20).isEnabled, false, "a relay whose parent was stopped must stop too");
    assert.equal(byId.get(21).isEnabled, true);
    assert.equal(byId.get(22).isEnabled, false, "a relay whose parent is gone must not run");
    assert.equal(byId.get(23).isEnabled, true);
  `, { name: "relay-gate" });
});
