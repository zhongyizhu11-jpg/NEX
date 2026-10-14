import assert from "node:assert/strict";
import test from "node:test";
import { describeHostFlowOffload } from "./hostFlowOffload";

test("describeHostFlowOffload", () => {
  assert.equal(describeHostFlowOffload(null), "");
  assert.equal(describeHostFlowOffload({ state: "pending", message: "等主机上报" }), "等主机上报");
  assert.equal(describeHostFlowOffload({ state: "active", offloaded: 0 }), "生效中");
  assert.equal(describeHostFlowOffload({ state: "active", offloaded: 12 }), "生效中，12 条连接走快速路径");
  assert.equal(describeHostFlowOffload({ state: "agent-old", message: "主机 Agent 要升到 2.2.221 起才会生效" }), "主机 Agent 要升到 2.2.221 起才会生效");
  assert.equal(describeHostFlowOffload({ state: "error", message: "内核 5.10 太旧，要 6.1 起" }), "内核 5.10 太旧，要 6.1 起");
  assert.equal(describeHostFlowOffload({ state: "error" }), "没有生效");
});
