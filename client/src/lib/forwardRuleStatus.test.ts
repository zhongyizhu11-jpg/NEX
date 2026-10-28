import assert from "node:assert/strict";
import test from "node:test";
import { LINK_PROBE_FRESH_MS } from "@shared/linkProbePolicy";
import {
  preferLastKnownForwardRuleVisualStatus,
  resolveForwardRuleStopReason,
  resolveForwardRuleVisualStatus,
} from "./forwardRuleStatus";

const now = Date.UTC(2026, 6, 16, 12, 0, 0);
const base = {
  ruleEnabled: true,
  groupEnabled: true,
  groupConfigStatus: "available" as const,
  runtimeStatus: "degraded",
  runningCount: 1,
  expectedCount: 3,
};

test("recent successful reachability overrides incomplete child status", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    latestLatencyMs: 88,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "running");
  assert.match(result.title, /88ms/);
});

test("partial child reports are pending rather than a hard failure", () => {
  const result = resolveForwardRuleVisualStatus(base, now);
  assert.equal(result.state, "pending");
  assert.match(result.title, /1 \/ 3/);
});

test("a recent timeout remains an explicit failure", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    runtimeStatus: "running",
    latestLatencyMs: null,
    latestLatencyIsTimeout: true,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "error");
});

test("a timestamp without a latency value is not treated as reachable", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    runtimeStatus: "pending",
    latestLatencyMs: null,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "pending");
});

test("disabled rules remain disabled even with a successful probe", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    ruleEnabled: false,
    latestLatencyMs: 10,
    latestLatencyAt: now - 10_000,
  }, now);
  assert.equal(result.state, "disabled");
});

test("revoked resource access overrides cached running and probe state", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    ruleRunning: true,
    resourceAccessAllowed: false,
    runtimeStatus: "running",
    latestLatencyMs: 10,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 10_000,
  }, now);
  assert.deepEqual(result, { state: "error", title: "资源授权失效" });
});

test("revoked resource access remains explicit after the rule is stopped", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    ruleEnabled: false,
    resourceAccessAllowed: false,
  }, now);
  assert.deepEqual(result, { state: "error", title: "资源授权失效" });
});

test("an available link alone does not claim that an unconfirmed rule is running", () => {
  const result = resolveForwardRuleVisualStatus({
    ruleEnabled: true,
    ruleRunning: false,
    groupEnabled: true,
    groupConfigStatus: "available",
  }, now);
  assert.equal(result.state, "pending");
});

test("a probe remains authoritative through the five minute report boundary", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    latestLatencyMs: 41,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 5 * 60_000 - 10_000,
  }, now);
  assert.equal(result.state, "running");
});

test("a probe older than the shared freshness window falls back to runtime state", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    latestLatencyMs: 41,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - LINK_PROBE_FRESH_MS - 1,
  }, now);
  assert.equal(result.state, "pending");
});

test("an explicitly unavailable group overrides an older successful probe", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    groupConfigStatus: "unavailable",
    latestLatencyMs: 41,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "error");
});

test("a successful probe remains visible while group data is still loading", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    groupConfigStatus: "pending",
    runtimeStatus: "pending",
    latestLatencyMs: 41,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "running");
});

test("an explicitly disabled runtime overrides an older successful probe", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    runtimeStatus: "disabled",
    latestLatencyMs: null,
    latestLatencyIsTimeout: true,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "disabled");
});

test("a recent timeout overrides the direct rule running flag", () => {
  const result = resolveForwardRuleVisualStatus({
    ruleEnabled: true,
    ruleRunning: true,
    groupEnabled: true,
    groupConfigStatus: "available",
    latestLatencyMs: null,
    latestLatencyIsTimeout: true,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "error");
});

test("last confirmed state is used while a new status is pending", () => {
  const result = preferLastKnownForwardRuleVisualStatus(
    { state: "pending", title: "等待 Agent 上报运行状态" },
    { state: "running", title: "Agent 已确认规则运行" },
  );
  assert.equal(result.state, "running");
  assert.match(result.title, /上次状态/);
});

test("an explicit current result is never replaced by the cache", () => {
  const cases = [
    {
      current: { state: "error" as const, title: "转发资源配置不可用" },
      cached: { state: "running" as const, title: "旧状态" },
    },
    {
      current: { state: "disabled" as const, title: "规则已停用" },
      cached: { state: "running" as const, title: "旧状态" },
    },
    {
      current: { state: "running" as const, title: "Agent 已确认规则运行" },
      cached: { state: "error" as const, title: "旧故障" },
    },
  ];
  for (const { current, cached } of cases) {
    assert.deepEqual(preferLastKnownForwardRuleVisualStatus(current, cached), current);
  }
});

test("rules stopped by their own limit say why and that they resume on their own", () => {
  assert.equal(resolveForwardRuleStopReason({ isEnabled: true, ruleLimitReason: "expired" })?.label, "已到期");
  const quota = resolveForwardRuleStopReason({ isEnabled: true, ruleLimitReason: "traffic_limit" });
  assert.equal(quota?.label, "额度用尽");
  assert.equal(quota?.autoResume, true);
  // A rule the user switched off reports the manual stop, not the limit.
  assert.equal(resolveForwardRuleStopReason({ isEnabled: false, ruleLimitReason: "expired" })?.label, "已停用");
  assert.equal(resolveForwardRuleStopReason({ isEnabled: true, ruleLimitReason: null }), null);
});

test("路径上有机器掉线：哪怕几分钟前探测成功、入口机说自己在跑，也按掉线报红", () => {
  // 出口机没了，入口机照样报「监听在跑」，探测也没人去做 —— 原来这条规则会一直绿着。
  const fresh = new Date(now - 30_000);
  const offline = resolveForwardRuleVisualStatus({
    ...base,
    runtimeStatus: "running",
    ruleRunning: true,
    latestLatencyMs: 12,
    latestLatencyIsTimeout: false,
    latestLatencyAt: fresh,
    offlineHostNames: ["jinx(39.9y)"],
  }, now);
  assert.equal(offline.state, "error");
  assert.match(offline.title, /主机离线：jinx\(39\.9y\)/);
  // 没掉线的照旧：探测新鲜就按探测说。
  const online = resolveForwardRuleVisualStatus({
    ...base,
    runtimeStatus: "running",
    ruleRunning: true,
    latestLatencyMs: 12,
    latestLatencyAt: fresh,
    offlineHostNames: [],
  }, now);
  assert.equal(online.state, "running");
  // 停用优先于掉线：停着的规则不该因为机器掉线显示成出错。
  const disabled = resolveForwardRuleVisualStatus({ ...base, ruleEnabled: false, offlineHostNames: ["x"] }, now);
  assert.equal(disabled.state, "disabled");
});

test("规则页把路径上的机器在线状态喂给状态判定，过期的延迟灰掉", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../pages/Rules.tsx"), "utf8");
  assert.equal((source.match(/offlineHostNames: getRuleOfflineHostNames\(rule\)/g) || []).length, 2, "两处 resolveForwardRuleVisualStatus 都要带上掉线的机器");
  assert.match(source, /const getRuleOfflineHostNames = \(rule: any\): string\[\] => \{/);
  assert.match(source, /getTunnelHopIds\(tunnel\)\)[\s\S]{0,800}host\.isOnline === false/);
  // 主机列表要定时刷新，掉线才能在这一页上看到。
  assert.match(source, /trpc\.hosts\.options\.useQuery\(undefined, \{\s*\n\s*\/\/[^\n]*\n\s*refetchInterval: pollingInterval\("slow"\)/);
  // 过了新鲜期的探测：精简行的标签和表格的延迟列都不再画成绿色数字。
  assert.match(source, /probe\?\.latestLatencyAt && !isLinkProbeFresh\(probe\.latestLatencyAt\)/);
  assert.match(source, /if \(!isLinkProbeFresh\(t\.latestLatencyAt\)\) \{/);
});
