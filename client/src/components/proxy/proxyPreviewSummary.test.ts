import assert from "node:assert/strict";
import test from "node:test";
import { summarizeProxyPreview } from "./proxyPreviewSummary";

test("没有 preview 时各段都是空的，待处理为 0", () => {
  const summary = summarizeProxyPreview(undefined);
  assert.deepEqual(summary.nodes, []);
  assert.deepEqual(summary.hiddenRules, []);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.pendingSubtitle, "都对上了");
});

test("按 kind 和 reason 分段，待处理只数要动手的那几种", () => {
  const summary = summarizeProxyPreview({
    nodes: [{ kind: "relay" }, { kind: "direct" }, { kind: "relay" }],
    skipped: [
      { reason: "hidden", ruleId: 1 },
      { reason: "unbound", ruleId: 2 },
      { reason: "unbound", ruleId: 3 },
      { reason: "unreachable", ruleId: 4 },
    ],
    warnings: [
      { reason: "target-mismatch", ruleId: 5 },
      { reason: "node-unused", nodeId: 9 },
      { reason: "host-never-online", nodeId: 10 },
    ],
  });
  assert.equal(summary.relayNodes.length, 2);
  assert.equal(summary.directNodes.length, 1);
  assert.deepEqual(summary.hiddenRules.map((item) => item.ruleId), [1]);
  assert.deepEqual(summary.unboundRules.map((item) => item.ruleId), [2, 3]);
  assert.deepEqual(summary.otherSkipped.map((item) => item.ruleId), [4]);
  assert.equal(summary.driftedRules.length, 1);
  assert.equal(summary.unusedNodes.length, 1);
  assert.equal(summary.hostOfflineNodes.length, 1);
  // 被隐藏的和「暂时不通」的不算待处理：前者是用户自己关的，后者通了会自动回来。
  assert.equal(summary.pendingCount, 5);
  assert.equal(summary.pendingSubtitle, "2 条差节点 · 1 条指向已变 · 1 个没进订阅 · 1 个机器没连上");
});
