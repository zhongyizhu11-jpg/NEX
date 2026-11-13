import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_VERSION, FXP_RUNTIME_VERSION } from "../shared/versions";
import { agentDistributionLabel, classifyHeartbeatAgentDistribution, normalizeAgentDistribution } from "../shared/agentDistribution";
import { agentUpgradeTargetDistributionFor, isAgentUpgradeCompleted, isHostAgentUpgradeUnnecessary } from "./agentRouteUtils";
import {
  FORWARDX_AGENT_MIGRATION_RETRY_MS,
  markForwardxAgentMigrationQueued,
  parseForwardxAgentMigrationSetting,
  resetForwardxAgentMigrationStateForTests,
  shouldQueueForwardxAgentMigration,
} from "./forwardxAgentMigration";

test("心跳认发行来源：报了就按报的；没报时带运行时能力的是老 NEX Agent，只带版本号的在迁移过来的面板上算原版", () => {
  assert.equal(classifyHeartbeatAgentDistribution({ agentDistribution: "nex", agentVersion: "2.2.256" }), "nex");
  assert.equal(classifyHeartbeatAgentDistribution({ agentDistribution: "NEX" }), "nex");
  assert.equal(classifyHeartbeatAgentDistribution({ agentDistribution: "forwardplus", agentVersion: "2.3.1" }), "forwardx", "别家的发行版也不是 NEX");
  assert.equal(classifyHeartbeatAgentDistribution({ agentVersion: "2.2.250", agentCapabilities: ["ssEgress2022"], runtimeVersion: "3.2.6-nex3" }), "nex");
  assert.equal(classifyHeartbeatAgentDistribution({ agentVersion: "2.2.250", runtimeVersion: "" }), "nex");
  assert.equal(classifyHeartbeatAgentDistribution({ agentVersion: "2.2.211", cpuUsage: 1 }, { unknownAsForwardx: true }), "forwardx");
  assert.equal(classifyHeartbeatAgentDistribution({ agentVersion: "2.2.211", cpuUsage: 1 }), null, "一直是 NEX 的面板：更老的 NEX Agent 不贴「原版」标签");
  assert.equal(classifyHeartbeatAgentDistribution({ cpuUsage: 1 }, { unknownAsForwardx: true }), null, "精简心跳认不出来，保留旧结论");
  assert.equal(classifyHeartbeatAgentDistribution(null), null);
  assert.equal(normalizeAgentDistribution(" forwardx "), "forwardx");
  assert.equal(normalizeAgentDistribution("other"), null);
  assert.equal(agentDistributionLabel("forwardx"), "原版 ForwardX");
  assert.equal(agentDistributionLabel(null), "NEX");
});

test("迁移升级的完成条件：目标发行来源是 nex 时，版本号够了也要等 Agent 报 nex", () => {
  const target = AGENT_VERSION;
  const fxpVersion = FXP_RUNTIME_VERSION;
  assert.equal(isAgentUpgradeCompleted({ agentVersion: "2.9.0", fxpVersion, agentDistribution: "forwardx", agentUpgradeTargetDistribution: "nex" }, target, target), false);
  assert.equal(isAgentUpgradeCompleted({ agentVersion: AGENT_VERSION, fxpVersion, agentDistribution: "nex", agentUpgradeTargetDistribution: "nex" }, target, target), true);
  assert.equal(isAgentUpgradeCompleted({ agentVersion: "2.2.250", fxpVersion, agentDistribution: "nex", agentUpgradeTargetDistribution: "nex" }, target, target), false, "版本不够照样不算");
  // 普通升级（没有目标发行来源）：和以前一样只看版本
  assert.equal(isAgentUpgradeCompleted({ agentVersion: AGENT_VERSION, fxpVersion, agentDistribution: "forwardx" }, target, target), true);
  // 原版 Agent 点「升级」不能被当成「已是最新」挡掉，要顺带换成 NEX
  assert.equal(isHostAgentUpgradeUnnecessary({ agentVersion: "2.9.0", fxpVersion, agentDistribution: "forwardx" }, target, target), false);
  assert.equal(isHostAgentUpgradeUnnecessary({ agentVersion: AGENT_VERSION, fxpVersion, agentDistribution: "nex" }, target, target), true);
  assert.equal(agentUpgradeTargetDistributionFor({ agentDistribution: "forwardx" }), "nex");
  assert.equal(agentUpgradeTargetDistributionFor({ agentDistribution: "nex" }), null);
  assert.equal(agentUpgradeTargetDistributionFor({}), null);
});

test("自动排队：只在迁移开关开着、原版 Agent、没在升级中时排；同一台至少隔一段时间再排", () => {
  resetForwardxAgentMigrationStateForTests();
  const base = { enabled: true, hostId: 10, agentDistribution: "forwardx", agentUpgradeRequested: false, now: 1_000_000 };
  assert.equal(shouldQueueForwardxAgentMigration(base), true);
  assert.equal(shouldQueueForwardxAgentMigration({ ...base, enabled: false }), false);
  assert.equal(shouldQueueForwardxAgentMigration({ ...base, agentDistribution: "nex" }), false);
  assert.equal(shouldQueueForwardxAgentMigration({ ...base, agentDistribution: null }), false, "还没认出来的不动");
  assert.equal(shouldQueueForwardxAgentMigration({ ...base, agentUpgradeRequested: true }), false);
  markForwardxAgentMigrationQueued(10, base.now);
  assert.equal(shouldQueueForwardxAgentMigration({ ...base, now: base.now + 60_000 }), false, "升级失败被清掉后不马上重排");
  assert.equal(shouldQueueForwardxAgentMigration({ ...base, now: base.now + FORWARDX_AGENT_MIGRATION_RETRY_MS }), true);
  assert.equal(shouldQueueForwardxAgentMigration({ ...base, hostId: 11 }), true, "按主机分开算");
  resetForwardxAgentMigrationStateForTests();

  assert.equal(parseForwardxAgentMigrationSetting(JSON.stringify({ enabled: true, migratedAt: 1 })), true);
  assert.equal(parseForwardxAgentMigrationSetting(JSON.stringify({ enabled: false })), false);
  assert.equal(parseForwardxAgentMigrationSetting("true"), true);
  assert.equal(parseForwardxAgentMigrationSetting(""), false);
  assert.equal(parseForwardxAgentMigrationSetting("{oops"), false);
});
