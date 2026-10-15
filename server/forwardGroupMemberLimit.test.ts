import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FORWARD_GROUP_MEMBERS } from "../shared/forwardGroup";
import { normalizeForwardGroupMembers } from "./services/forwardGroupService";

function members(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    memberType: "host" as const,
    hostId: index + 1,
    tunnelId: null,
    isEnabled: true,
  }));
}

test("forward chain and entry/exit groups allow up to the shared member limit", () => {
  for (const groupMode of ["chain", "entry", "exit"] as const) {
    const minimum = groupMode === "chain" ? 2 : 1;
    assert.doesNotThrow(() => normalizeForwardGroupMembers(groupMode, "host", members(minimum)));
    assert.doesNotThrow(() => normalizeForwardGroupMembers(groupMode, "host", members(MAX_FORWARD_GROUP_MEMBERS)));
    assert.throws(
      () => normalizeForwardGroupMembers(groupMode, "host", members(MAX_FORWARD_GROUP_MEMBERS + 1)),
      /需要配置|requires/,
    );
  }
});

test("端口转发也能挂 1 到上限台入口主机（poouo/Forwardx#15：多台入口同时转发同一条规则）", () => {
  assert.doesNotThrow(() => normalizeForwardGroupMembers("port", "host", members(1)));
  const three = normalizeForwardGroupMembers("port", "host", members(3));
  assert.equal(three.length, 3);
  // 端口转发的成员没有「停用」一说：每台都监听
  assert.ok(three.every((member) => member.isEnabled === true && member.memberType === "host"));
  assert.doesNotThrow(() => normalizeForwardGroupMembers("port", "host", members(MAX_FORWARD_GROUP_MEMBERS)));
  assert.throws(() => normalizeForwardGroupMembers("port", "host", members(0)), /1-\d+ 台入口主机/);
  assert.throws(() => normalizeForwardGroupMembers("port", "host", members(MAX_FORWARD_GROUP_MEMBERS + 1)), /1-\d+ 台入口主机/);
});
