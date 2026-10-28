import assert from "node:assert/strict";
import test from "node:test";

import { LINK_PROBE_FRESH_MS } from "../shared/linkProbePolicy";
import { effectiveRuleStatusInfo } from "./telegramBot";
import { resolveForwardRuleVisualStatus } from "../client/src/lib/forwardRuleStatus";

/**
 * 同一条规则，面板和 Telegram 机器人必须给同一个答案。
 *
 * 机器人那一路原来只看「上一次探测超没超时」，不问那是三分钟前还是三天前的事 ——
 * 面板那边一直有新鲜期（6 分钟），机器人没有。于是一条正常跑着的规则：面板是绿的、
 * 写着「Agent 已确认规则运行」，机器人说「目标探测超时」。两个地方对同一件事给
 * 两个答案，比给错答案更让人不敢信 —— 人会两个都不敢信。
 *
 * 两边现在调同一个 isLinkProbeFresh。这一组按「面板说正常 / 面板说出事」两档，
 * 逐档核对机器人的结论跟不跟得上。
 */

const rule = { isEnabled: true, isRunning: true };
const emptyTraffic = { bytesIn: 0, bytesOut: 0, connections: 0 };

test("陈年的超时探测：两边都不该据此报错", () => {
  const now = Date.now();
  const latestLatencyAt = now - LINK_PROBE_FRESH_MS - 60_000;

  const panel = resolveForwardRuleVisualStatus({
    ruleEnabled: true,
    ruleRunning: true,
    groupEnabled: true,
    groupConfigStatus: "available",
    latestLatencyIsTimeout: true,
    latestLatencyMs: null,
    latestLatencyAt,
  }, now);
  const telegram = effectiveRuleStatusInfo(rule, {
    ...emptyTraffic,
    latestLatencyIsTimeout: true,
    latestLatencyMs: null,
    latestLatencyAt,
  });

  assert.equal(panel.state, "running");
  assert.equal(
    telegram.kind,
    "running",
    "面板说运行中，机器人拿三天前那次超时说「目标探测超时」—— 同一条规则两个答案",
  );
});

test("刚探到的超时：两边都要报出来", () => {
  const now = Date.now();
  const latestLatencyAt = now - 1_000;

  const panel = resolveForwardRuleVisualStatus({
    ruleEnabled: true,
    ruleRunning: true,
    groupEnabled: true,
    groupConfigStatus: "available",
    latestLatencyIsTimeout: true,
    latestLatencyMs: null,
    latestLatencyAt,
  }, now);
  const telegram = effectiveRuleStatusInfo(rule, {
    ...emptyTraffic,
    latestLatencyIsTimeout: true,
    latestLatencyMs: null,
    latestLatencyAt,
  });

  assert.equal(panel.state, "error", "刚探过的超时才是真的出事了");
  assert.equal(telegram.kind, "abnormal", "这一种机器人必须照报，不能被新鲜期一起挡掉");
});

test("陈年的延迟数字不该被当成「运行中（xx ms）」写出来", () => {
  const telegram = effectiveRuleStatusInfo(rule, {
    ...emptyTraffic,
    latestLatencyIsTimeout: false,
    latestLatencyMs: 30,
    latestLatencyAt: Date.now() - LINK_PROBE_FRESH_MS - 60_000,
  });
  assert.equal(telegram.kind, "running");
  assert.equal(
    telegram.label,
    "运行中",
    "三天前那个 30ms 现在说明不了任何事，跟在「运行中」后面等于拿旧数字当现况",
  );
});

test("完全没探测过时，两边都按 Agent 上报的运行状态说话", () => {
  const now = Date.now();
  const panel = resolveForwardRuleVisualStatus({
    ruleEnabled: true,
    ruleRunning: true,
    groupEnabled: true,
    groupConfigStatus: "available",
  }, now);
  const telegram = effectiveRuleStatusInfo(rule, emptyTraffic);
  assert.equal(panel.state, "running");
  assert.equal(telegram.kind, "running");
});

test("路径上的机器掉线：两边都要说「主机离线」，不能拿刚才还通的探测说运行中", () => {
  const now = Date.now();
  const latestLatencyAt = now - 30_000;

  const panel = resolveForwardRuleVisualStatus({
    ruleEnabled: true,
    ruleRunning: true,
    groupEnabled: true,
    groupConfigStatus: "available",
    latestLatencyIsTimeout: false,
    latestLatencyMs: 42,
    latestLatencyAt,
    offlineHostNames: ["中转-1"],
  }, now);
  const telegram = effectiveRuleStatusInfo(rule, {
    ...emptyTraffic,
    latestLatencyIsTimeout: false,
    latestLatencyMs: 42,
    latestLatencyAt,
  }, ["中转-1"]);

  assert.equal(panel.state, "error");
  assert.match(panel.title, /主机离线/);
  assert.equal(telegram.kind, "abnormal");
  assert.equal(telegram.label, "主机离线");
  assert.equal(telegram.detail, "中转-1");
});
