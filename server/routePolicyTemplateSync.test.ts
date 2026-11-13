import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROUTE_POLICY_RULE_FIELDS } from "../shared/routePolicyFields";

/**
 * 模板 → 子规则，逐列验：「调度字段清单」（shared/routePolicyFields）里的每一列，在模板上改了、组同步之后，
 * 子规则算出来的策略必须和模板算出来的一模一样。
 *
 * 2.3.522 的「切到备用 1 还是走主线路」是漏抄了两列；当时的测试只验了读法，读法没错。这一组走真实的组同步，
 * 清单里加了新列却没从模板带到子规则，这里会指名道姓地红。
 */

type StepResult = { field: string; same: boolean; template: unknown; child: unknown; childRunning: boolean };
type UpgradeResult = { groups: number; failed: number; skipped: boolean };
type Outcome = {
  steps: StepResult[];
  covered: string[];
  upgrade: { staleSame: boolean; first: UpgradeResult; repairedSame: boolean; stillRunning: boolean; second: UpgradeResult; third: UpgradeResult; untouched: boolean };
};

function runScenario(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-route-policy-template-sync-"));
  const databasePath = path.join(directory, "sync.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => exec(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const now = Math.floor(Date.now() / 1000);
    await insert("users", ["id", "username", "password", "role"], [1, "admin", "hash", "admin"]);
    const host = (id, name, ip, token) => insert(
      "hosts", ["id", "name", "ip", "ipv4", "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat"],
      [id, name, ip, ip, "slave", token, 1, 1, now],
    );
    await host(1, "入口机", "198.51.100.10", "tok1");
    await host(2, "中转 A", "198.51.100.20", "tok2");
    await host(3, "中转 B", "198.51.100.30", "tok3");
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [10, "端口组", "host", "port", "gost", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    const hopPaths = JSON.stringify([
      { key: "a", name: "主线路", hops: [2], dest: { ip: "203.0.113.10", port: 45855 }, weight: 50, probe: null, dial: null, tier: 0, lineKey: "a" },
      { key: "b", name: "备用 1", hops: [3], dest: { ip: "203.0.113.10", port: 45855 }, weight: 50, probe: null, dial: null, tier: 1, lineKey: "b" },
    ]);
    await insert("forward_rules", [
      "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
      "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "failoverStrategy",
      "routeMode", "routePaths", "routeDelivery", "failoverSeconds", "recoverSeconds", "autoFailback",
    ], [300, 1, "带中转", "gost", "tcp", 10, 1, 17000, "203.0.113.10", 45855, 1, 1, 0, 1, "fallback", "smart", hopPaths, "hot", 3, 300, 1]);

    const forwardGroups = await import(url("server/repositories/forwardGroupRepository.ts"));
    const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
    const { routeGroupOf } = await import(url("shared/routeGroup.ts"));
    await forwardGroups.syncForwardGroupRules(10);
    await exec('UPDATE forward_rules SET "isRunning" = 1 WHERE "forwardGroupRuleId" = 300');

    const schedule = JSON.stringify({ timezone: "UTC", windows: [{ days: [1, 2, 3], from: "18:00", to: "01:00", targetIndex: 1 }] });
    // 一列一列地改（累加）：每改一列同步一次，比模板和子规则各自算出来的策略
    const changes = [
      ["routeMode", "hybrid"],
      ["failoverSchedule", schedule],
      ["failoverPinnedIndex", 1],
      ["failoverPinnedUntil", new Date((now + 7200) * 1000)],
      ["failoverMinHoldSeconds", 77],
      ["failoverSeconds", 7],
      ["recoverSeconds", 33],
      ["autoFailback", false],
      ["routeFailureThreshold", 5],
      ["routeScoreMargin", 22],
      ["routeScoreHoldSeconds", 44],
      ["routePrewarmSeconds", 55],
      ["routeSwitchMode", "fast"],
      ["routeDelivery", "cold"],
      ["failoverPreferFastest", true],
      // 换成按权重分：分法（failoverStrategy）这时才算数
      ["routeMode", "weighted"],
      ["failoverStrategy", "round_robin"],
    ];
    const nowMs = Date.now();
    const steps = [];
    for (const [field, value] of changes) {
      await rules.updateForwardRule(300, { [field]: value });
      await forwardGroups.syncForwardGroupRules(10);
      const template = await rules.getForwardRuleById(300);
      const child = (await runtime.queryRaw('SELECT "id" FROM forward_rules WHERE "forwardGroupRuleId" = 300 AND "isForwardGroupTemplate" = 0 AND "pendingDelete" = 0'))[0];
      const childRule = await rules.getForwardRuleById(Number(child.id));
      const templatePolicy = routeGroupOf(template, { nowMs })?.policy ?? null;
      const childPolicy = routeGroupOf(childRule, { nowMs })?.policy ?? null;
      steps.push({ field, same: JSON.stringify(templatePolicy) === JSON.stringify(childPolicy), template: templatePolicy, child: childPolicy, childRunning: !!childRule.isRunning });
    }
    // —— 升级后自动补齐：把子规则的几列改回「老版本没带上」的样子，跑一次升级同步 ——
    const dbModule = await import(url("server/db.ts"));
    const childId = Number((await runtime.queryRaw('SELECT "id" FROM forward_rules WHERE "forwardGroupRuleId" = 300 AND "isForwardGroupTemplate" = 0 AND "pendingDelete" = 0'))[0].id);
    await exec('UPDATE forward_rules SET "failoverPinnedIndex" = NULL, "failoverPinnedUntil" = NULL, "failoverMinHoldSeconds" = 0, "isRunning" = 1 WHERE "id" = ?', [childId]);
    const policyOf = async (id) => routeGroupOf(await rules.getForwardRuleById(id), { nowMs })?.policy ?? null;
    const staleSame = JSON.stringify(await policyOf(300)) === JSON.stringify(await policyOf(childId));
    const first = await dbModule.syncForwardGroupRulesAfterUpgrade("9.9.9-test");
    const repairedSame = JSON.stringify(await policyOf(300)) === JSON.stringify(await policyOf(childId));
    const stillRunning = !!(await rules.getForwardRuleById(childId)).isRunning;
    const updatedAtBefore = String((await rules.getForwardRuleById(childId)).updatedAt);
    const second = await dbModule.syncForwardGroupRulesAfterUpgrade("9.9.9-test");
    // 隔开一秒多：updatedAt 按秒存，同一秒里改写了也看不出来（以前这条靠运气过）
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const third = await dbModule.syncForwardGroupRulesAfterUpgrade("9.9.10-test");
    const updatedAtAfter = String((await rules.getForwardRuleById(childId)).updatedAt);
    const upgrade = { staleSame, first, repairedSame, stillRunning, second, third, untouched: updatedAtBefore === updatedAtAfter };
    console.log("OUTCOME " + JSON.stringify({ steps, covered: Array.from(new Set(changes.map(([field]) => field))), upgrade }));
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    timeout: 180_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = runScenario();

test("这一组把「调度字段清单」里的每一列都改到了：清单加了新列，这里也要加一步", () => {
  const missing = ROUTE_POLICY_RULE_FIELDS.filter((field) => !outcome.covered.includes(field));
  assert.deepEqual(missing, []);
});

for (const step of outcome.steps) {
  test(`模板改了 ${step.field}，组同步之后子规则算出来的策略和模板一样`, () => {
    assert.equal(step.same, true, `模板：${JSON.stringify(step.template)}\n子规则：${JSON.stringify(step.child)}`);
  });
}

test("只改调度设置不重启成员机上的转发：每一步之后子规则都还在跑", () => {
  const restarted = outcome.steps.filter((step) => !step.childRunning).map((step) => step.field);
  assert.deepEqual(restarted, []);
});

test("升级后的第一次启动：老版本没带到子规则上的设置自动补齐，不重启转发；同一版本只跑一次，设置没变的再同步是空操作", () => {
  const { upgrade } = outcome;
  assert.equal(upgrade.staleSame, false, "前提：子规则被改回了没带上的样子");
  assert.deepEqual(upgrade.first, { groups: 1, failed: 0, skipped: false });
  assert.equal(upgrade.repairedSame, true, "升级同步之后子规则的策略和模板一样");
  assert.equal(upgrade.stillRunning, true, "只补调度设置，子规则原地热更新，不标成没在跑");
  assert.equal(upgrade.second.skipped, true, "同一个版本不再跑第二遍");
  assert.deepEqual(upgrade.third, { groups: 1, failed: 0, skipped: false }, "版本又变了就再跑一遍");
  assert.equal(upgrade.untouched, true, "设置没变的子规则，再同步不写库");
});
