import assert from "node:assert/strict";
import test from "node:test";
import { hostDeleteNeedsOfflineConfirmation, offlineCleanupConfirmOptions } from "./hostDeletion";

test("only the offline-cleanup refusal asks for a second confirmation", () => {
  assert.equal(hostDeleteNeedsOfflineConfirmation({ data: { code: "PRECONDITION_FAILED" } }), true);
  assert.equal(hostDeleteNeedsOfflineConfirmation({ data: { code: "CONFLICT" } }), false, "an online host that is still cleaning up must not offer 'delete anyway'");
  assert.equal(hostDeleteNeedsOfflineConfirmation({ data: { code: "INTERNAL_SERVER_ERROR" } }), false);
  assert.equal(hostDeleteNeedsOfflineConfirmation(new Error("x")), false);
  assert.equal(hostDeleteNeedsOfflineConfirmation(null), false);
});

test("the confirmation names the host and is destructive", () => {
  const options = offlineCleanupConfirmOptions("东京 1", "主机离线，面板无法确认已删除的规则已经在机器上停止（2 条）");
  assert.equal(options.title, "「东京 1」离线，仍要删除？");
  assert.match(options.description, /2 条/);
  assert.equal(options.tone, "destructive");
  assert.equal(offlineCleanupConfirmOptions("", "x").title, "主机离线，仍要删除？");
});
