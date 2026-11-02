import assert from "node:assert/strict";
import test from "node:test";
import { notifyHostDeleted, notifyRuleDeleted, onHostDeleted, onRuleDeleted } from "./entityCleanup";
import { runInDatabase } from "./testing/runInDatabase";

test("cleanup listeners get valid ids and one failing listener does not stop the others", () => {
  const seen: number[] = [];
  const offA = onHostDeleted(() => { throw new Error("boom"); });
  const offB = onHostDeleted((id) => seen.push(id));
  const offC = onRuleDeleted((id) => seen.push(-id));
  const originalDebug = console.debug;
  console.debug = () => {};
  try {
    notifyHostDeleted(5);
    notifyHostDeleted("x");
    notifyHostDeleted(0);
    notifyRuleDeleted("7");
  } finally {
    console.debug = originalDebug;
    offA(); offB(); offC();
  }
  assert.deepEqual(seen, [5, -7]);
});

test("deleting a host or finalizing a rule delete clears the in-memory state keyed by it", () => {
  runInDatabase(String.raw`
    const cleanup = await import(url("server/entityCleanup.ts"));
    const hosts = await import(url("server/repositories/hostRepository.ts"));
    const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
    const deletedHosts = [];
    const deletedRules = [];
    cleanup.onHostDeleted((id) => deletedHosts.push(id));
    cleanup.onRuleDeleted((id) => deletedRules.push(id));
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (3, 'a', '198.51.100.3', 'tok3', 1)");
    await exec('INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete") VALUES (9, 3, ?, ?, ?, ?, ?, ?, 1, 0, 1)', ["r", "iptables", "tcp", 40009, "198.51.100.9", 80]);
    await rules.finalizeForwardRuleDelete(9);
    assert.deepEqual(deletedRules, [9]);
    await hosts.deleteHost(3);
    assert.deepEqual(deletedHosts, [3]);
  `, { name: "entity-cleanup", quiet: true });
});
