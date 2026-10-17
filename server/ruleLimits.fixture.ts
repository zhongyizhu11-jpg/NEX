// Run by server/ruleLimits.test.ts in a child process against a throwaway SQLite database.
import assert from "node:assert/strict";
import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import * as db from "./db";
import { rulesRouter } from "./routers/rules";
import { applyRuleLimitsForRuntime, reconcileRuleLimits, recordRuleQuotaTraffic } from "./ruleLimits";
import { shouldAccountForwardRuleTraffic } from "./agentReportRoutes";
import { gateForwardRulesForRuntime } from "./linkAccessView";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
try {
  await ensureDatabaseSchema();
  // Simulate the pre-feature table, then migrate a live legacy rule in place.
  for (const column of ["rateLimitMbps", "trafficLimit", "trafficMode", "expiresAt", "ruleLimitReason", "quotaUsedIn", "quotaUsedOut", "adminManaged"]) {
    await runtime.executeRaw(`ALTER TABLE forward_rules DROP COLUMN "${column}"`);
  }
  await runtime.executeRaw(`INSERT INTO forward_rules (id,"hostId",name,"sourcePort","targetIp","targetPort","userId") VALUES (99,1,'legacy',23999,'192.0.2.99',443,1)`);
  await ensureDatabaseSchema();
  const legacy: any = await db.getForwardRuleById(99);
  assert.equal(legacy.isEnabled, true);
  assert.equal(legacy.rateLimitMbps, 0);
  assert.equal(legacy.trafficLimit, 0);
  assert.equal(legacy.trafficMode, "both");
  assert.equal(legacy.expiresAt, null);
  assert.equal(legacy.adminManaged, false);
  assert.equal(legacy.quotaUsedIn, null);
  await db.updateForwardRule(99, { pendingDelete: true } as any);

  const now = Math.floor(Date.now() / 1000);
  await runtime.executeRaw(`INSERT INTO users (id,username,password,name,role,"accountEnabled","canAddRules","manualCanAddRules","maxRules","maxPorts","balanceCents") VALUES (1,'admin','unused','Admin','admin',1,1,1,100,100,1000),(2,'user','unused','User','user',1,1,1,100,100,1000)`);
  await runtime.executeRaw(`INSERT INTO hosts (id,name,ip,ipv4,"userId","agentVersion","isOnline","lastHeartbeat") VALUES (1,'entry','192.0.2.1','192.0.2.1',1,'2.2.228',1,?),(2,'exit','192.0.2.2','192.0.2.2',1,'2.2.228',1,?)`, [now, now]);
  await runtime.executeRaw(`INSERT INTO forward_groups (id,name,"groupType","groupMode",domain,"targetIp","userId","isEnabled") VALUES (10,'group','host','port','','0.0.0.0',1,1)`);
  await runtime.executeRaw(`INSERT INTO forward_group_members (id,"groupId","memberType","hostId",priority,"isEnabled") VALUES (101,10,'host',1,0,1),(102,10,'host',2,1,1)`);
  await db.setUserForwardGroupPermissions(2, [10]);

  const caller = (id: number, role: "admin" | "user") => rulesRouter.createCaller({
    user: { id, role, username: `u${id}`, accountEnabled: true },
    req: { headers: {} }, res: { clearCookie() {} }, authSession: null, authFailureReason: null,
  } as any);
  const admin = caller(1, "admin");
  const customer = caller(2, "user");
  const grouped = { forwardGroupId: 10, name: "limited", forwardType: "iptables" as const, protocol: "both" as const, sourcePort: 24001, targetIp: "192.0.2.99", targetPort: 443 };
  const direct = { hostId: 1, name: "admin-direct", forwardType: "iptables" as const, protocol: "both" as const, sourcePort: 25001, targetIp: "192.0.2.98", targetPort: 443 };
  const expiresAt = new Date(Date.now() + 86_400_000);

  // An administrator creates a limited rule for the selected user.
  const { id } = await admin.create({ ...grouped, userId: 2, rateLimitMbps: 12, trafficLimit: 1000, trafficMode: "max", expiresAt });
  let saved: any = await db.getForwardRuleById(id);
  assert.equal(saved.userId, 2);
  assert.equal(saved.rateLimitMbps, 12);
  assert.equal(saved.trafficLimit, 1000);
  assert.equal(saved.trafficMode, "max");
  assert.equal(saved.adminManaged, true);
  assert.ok(Math.abs(new Date(saved.expiresAt).getTime() - expiresAt.getTime()) < 1000);
  assert.equal(saved.quotaUsedIn, 0, "the quota counter starts when the policy is set");

  // Ordinary rules keep the defaults and runtime identity.
  const normal = await admin.create({ ...direct });
  const defaults: any = await db.getForwardRuleById(normal.id);
  assert.equal(defaults.trafficLimit, 0);
  assert.equal(defaults.rateLimitMbps, 0);
  assert.equal(defaults.expiresAt, null);
  assert.equal(defaults.adminManaged, false);
  assert.equal((await applyRuleLimitsForRuntime([defaults]))[0], defaults, "unlimited rules keep their object identity");

  // Only administrators may set limits; expiry must be after creation.
  await assert.rejects(customer.create({ ...grouped, sourcePort: 24003, trafficLimit: 1 }), /只有管理员/);
  await assert.rejects(admin.create({ ...direct, sourcePort: 25002, expiresAt: new Date(Date.now() - 1000) }), /到期时间必须晚于现在/);
  await assert.rejects(admin.update({ id, expiresAt: new Date(new Date(saved.createdAt).getTime() - 1000) }), /到期时间/);
  assert.equal((await db.getForwardRuleById(id))!.trafficLimit, 1000);

  // Traffic accounting uses the same accepted batch, rolled up to the template.
  const children: any[] = await db.getForwardGroupChildRulesForTemplate(id);
  assert.equal(children.length, 2);
  const stat = (bytesIn: number, bytesOut: number, ruleId: number, hostId = 1) => ({ stat: { ruleId, hostId, bytesIn, bytesOut, connections: 1 }, userId: 2 });
  const recordTraffic = async (items: db.TrafficStatBatchItem[]) => runtime.withDatabaseTransaction(async () => {
    await db.insertTrafficStatsBatch(items);
    const contexts: any[] = await db.getForwardRuleTrafficContextsByIds(items.map((item) => Number(item.stat.ruleId)));
    const byId = new Map(contexts.map((context) => [Number(context.rule.id), context]));
    const accepted = items.filter((item) => {
      const context = byId.get(Number(item.stat.ruleId));
      return context && shouldAccountForwardRuleTraffic(context.rule, context.group);
    });
    await recordRuleQuotaTraffic(accepted, byId);
  });
  let gated = await applyRuleLimitsForRuntime(children);
  assert.ok(gated.every((child: any) => child.rateLimitMbps === 12 && child.isEnabled), "members inherit the template speed limit");
  await recordTraffic([stat(600, 50, children[0].id, 1), stat(300, 60, children[1].id, 2)]);
  await reconcileRuleLimits([id]);
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.quotaUsedIn, 900);
  assert.equal(saved.quotaUsedOut, 110);
  assert.equal(saved.ruleLimitReason, null, "max(900, 110) < 1000");
  await admin.update({ id, trafficMode: "both" });
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.ruleLimitReason, "traffic_limit", "900 + 110 >= 1000");
  assert.equal(saved.isEnabled, true, "the user's own switch is untouched");
  gated = await applyRuleLimitsForRuntime(children);
  assert.ok(gated.every((child: any) => !child.isEnabled && child.ruleLimitReason === "traffic_limit"));
  assert.ok((await gateForwardRulesForRuntime(children)).every((child: any) => !child.isEnabled));

  // The owner can see but not change administrator-managed rules.
  assert.equal((await customer.getById({ id }))!.trafficLimit, 1000);
  await assert.rejects(customer.update({ id, name: "still limited" }), /管理员管理/);
  await assert.rejects(customer.toggle({ id, isEnabled: false }), /管理员管理/);
  await assert.rejects(customer.delete({ id }), /管理员管理/);
  await assert.rejects(customer.resetTraffic({ scope: "rule", ruleId: id }), /管理员管理/);
  await assert.rejects(customer.resetTraffic({ scope: "all", ruleIds: [id] }), /管理员管理/);
  const own = await customer.create({ ...grouped, sourcePort: 24100 });
  await customer.resetTraffic({ scope: "all" }); // skips the managed rule
  assert.equal((await db.getForwardRuleById(id))!.quotaUsedIn, 900);
  await customer.update({ id: own.id, name: "self-service edited" });
  const batch = await customer.deleteBatch({ ids: [own.id, id] });
  assert.deepEqual(batch.deletedIds, [own.id]);
  assert.match(batch.failures[0].error, /管理员管理/);

  // Raising the limit restores the rule; an admin reset clears the quota counter.
  await admin.update({ id, trafficLimit: 2000 });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null);
  assert.ok((await applyRuleLimitsForRuntime(children)).every((child: any) => child.isEnabled));
  await admin.update({ id, trafficLimit: 1000 });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, "traffic_limit");
  await admin.resetTraffic({ scope: "rule", ruleId: id });
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.quotaUsedIn, 0);
  assert.equal(saved.quotaUsedOut, 0);
  assert.equal(saved.ruleLimitReason, null);

  // Expiry: checked fresh at runtime, stored by the reconcile sweep. A rule created yesterday
  // may be given an expiry that already passed (stop it now), but never one before its creation.
  await db.updateForwardRule(id, { createdAt: new Date(Date.now() - 86_400_000) } as any);
  await admin.update({ id, expiresAt: new Date(Date.now() - 60_000) });
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.ruleLimitReason, "expired");
  await admin.update({ id, expiresAt: null, trafficLimit: 0, rateLimitMbps: 0 });
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.ruleLimitReason, null);
  assert.equal(saved.adminManaged, true, "clearing the limits does not hand the rule back");
  await assert.rejects(customer.update({ id, name: "cleared limits" }), /管理员管理/);
  await db.updateForwardRule(id, { expiresAt: new Date(Date.now() - 1000) } as any);
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null, "not yet swept");
  assert.ok((await applyRuleLimitsForRuntime(children)).every((child: any) => !child.isEnabled), "runtime checks expiry fresh");
  await reconcileRuleLimits();
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, "expired");

  // A per-rule speed cap needs entry Agents that enforce it.
  await runtime.executeRaw(`UPDATE hosts SET "agentVersion"='2.2.186' WHERE id=1`);
  await assert.rejects(admin.update({ id, rateLimitMbps: 1 }), /升级 Agent/);
  assert.equal((await db.getForwardRuleById(id))!.rateLimitMbps, 0);
  await runtime.executeRaw(`UPDATE hosts SET "agentVersion"='2.2.228' WHERE id=1`);

  // Administrators' own rules obey their own quota; other admin rules are unaffected.
  const self = await admin.create({ ...direct, sourcePort: 25010, trafficLimit: 1000, trafficMode: "both" });
  const unrelated = await admin.create({ ...direct, sourcePort: 25011 });
  assert.equal((await db.getForwardRuleById(self.id))!.adminManaged, true);
  await recordTraffic([{ ...stat(600, 500, self.id), userId: 1 }]);
  await reconcileRuleLimits([self.id]);
  const selfRule: any = await db.getForwardRuleById(self.id);
  assert.equal(selfRule.quotaUsedIn, 600);
  assert.equal(selfRule.quotaUsedOut, 500);
  assert.equal(selfRule.ruleLimitReason, "traffic_limit");
  const runtimeRules = await gateForwardRulesForRuntime([selfRule, (await db.getForwardRuleById(unrelated.id))!]);
  assert.equal(runtimeRules[0].isEnabled, false, "admin access cannot bypass the rule quota");
  assert.equal(runtimeRules[1].isEnabled, true, "one capped rule must not disable unrelated rules");
  // Unmanaged rules do not start a quota counter at all.
  await recordTraffic([{ ...stat(10, 10, unrelated.id), userId: 1 }]);
  assert.equal((await db.getForwardRuleById(unrelated.id))!.quotaUsedIn, null);
} finally {
  await runtime.closeDatabase();
}
process.exit(0);
