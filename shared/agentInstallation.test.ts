import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RETIRED_INSTALLATION_LIMIT,
  decideAgentInstallation,
  normalizeAgentInstallationId,
  parseRetiredInstallationIds,
  shortAgentInstallationId,
} from "./agentInstallation";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

test("安装实例 ID 只认 64 位十六进制", () => {
  assert.equal(normalizeAgentInstallationId(A.toUpperCase()), A);
  assert.equal(normalizeAgentInstallationId("abc"), "");
  assert.equal(normalizeAgentInstallationId("z".repeat(64)), "");
  assert.equal(normalizeAgentInstallationId(123), "");
  assert.equal(shortAgentInstallationId(B), "bbbbbbbb");
});

test("没绑定过的主机：旧 Agent 照旧放行，新 Agent 第一次登记", () => {
  assert.deepEqual(decideAgentInstallation({ current: "", retired: [] }, undefined), { kind: "accept" });
  assert.deepEqual(decideAgentInstallation({ current: "", retired: [] }, ""), { kind: "accept" });
  assert.deepEqual(decideAgentInstallation({ current: "", retired: [] }, A), { kind: "bind", next: { current: A, retired: [] } });
});

test("同一个实例照常；另一台机器的新实例接管，原实例进已接管列表", () => {
  assert.deepEqual(decideAgentInstallation({ current: A, retired: [] }, A), { kind: "accept" });
  assert.deepEqual(decideAgentInstallation({ current: A, retired: [] }, B), {
    kind: "takeover",
    previous: A,
    next: { current: B, retired: [A] },
  });
});

test("被接管下来的旧实例回「已被接管」，重启后也抢不回去", () => {
  // 状态机走一遍：A 在跑 → B 接管 → A 再来被拒 → C 再接管 → A、B 都被拒
  let state = { current: A, retired: [] as string[] };
  const takeover = decideAgentInstallation(state, B);
  assert.equal(takeover.kind, "takeover");
  if (takeover.kind !== "takeover") return;
  state = { current: takeover.next.current, retired: [...takeover.next.retired] };
  assert.deepEqual(decideAgentInstallation(state, A), { kind: "superseded" });
  assert.deepEqual(decideAgentInstallation(state, B), { kind: "accept" });
  const second = decideAgentInstallation(state, C);
  assert.equal(second.kind, "takeover");
  if (second.kind !== "takeover") return;
  state = { current: second.next.current, retired: [...second.next.retired] };
  assert.deepEqual(state.retired, [A, B]);
  assert.deepEqual(decideAgentInstallation(state, A), { kind: "superseded" });
  assert.deepEqual(decideAgentInstallation(state, B), { kind: "superseded" });
});

test("主机已绑定实例后，不带 ID 的旧 Agent 被拒（防止它和新机器抢）", () => {
  assert.deepEqual(decideAgentInstallation({ current: A, retired: [] }, undefined), { kind: "legacy-rejected" });
  assert.deepEqual(decideAgentInstallation({ current: A, retired: [] }, "not-an-id"), { kind: "legacy-rejected" });
});

test("已接管列表有上限，JSON 解析容错", () => {
  const ids = Array.from({ length: AGENT_RETIRED_INSTALLATION_LIMIT + 5 }, (_, index) => index.toString(16).padStart(64, "0"));
  assert.equal(parseRetiredInstallationIds(JSON.stringify(ids)).length, AGENT_RETIRED_INSTALLATION_LIMIT);
  assert.deepEqual(parseRetiredInstallationIds("{bad"), []);
  assert.deepEqual(parseRetiredInstallationIds(null), []);
  assert.deepEqual(parseRetiredInstallationIds(JSON.stringify([A, A, "x"])), [A]);
  const full = { current: ids[0], retired: ids.slice(1, AGENT_RETIRED_INSTALLATION_LIMIT + 1) };
  const decision = decideAgentInstallation(full, A);
  assert.equal(decision.kind, "takeover");
  if (decision.kind === "takeover") {
    assert.equal(decision.next.retired.length, AGENT_RETIRED_INSTALLATION_LIMIT);
    assert.equal(decision.next.retired.at(-1), ids[0]);
  }
});
