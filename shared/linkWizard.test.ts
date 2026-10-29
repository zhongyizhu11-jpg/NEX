import assert from "node:assert/strict";
import test from "node:test";

import { LINK_WIZARD_GOALS, LINK_WIZARD_PLACES, linkWizardAdvice } from "./linkWizard";

test("每种组合都有一句建议", () => {
  for (const goal of LINK_WIZARD_GOALS) {
    for (const place of LINK_WIZARD_PLACES) {
      const advice = linkWizardAdvice(goal, place);
      assert.ok(advice.title && advice.explain, `${goal}/${place}`);
    }
  }
});

test("稳定优先：入口 → 转发组，中转 → 隧道中转主备，出口 → 出口组主备，几条路 → 线路组", () => {
  assert.deepEqual(linkWizardAdvice("stable", "entry").action, { type: "group", mode: "failover" });
  assert.deepEqual(linkWizardAdvice("stable", "relay").action, { type: "tunnel", relayMode: "hot_standby", needsForwardX: true });
  assert.deepEqual(linkWizardAdvice("stable", "exit").action, { type: "group", mode: "exit", exitStrategy: "fallback" });
  assert.deepEqual(linkWizardAdvice("stable", "path").action, { type: "rule" });
  assert.equal(linkWizardAdvice("stable", "one").action, null);
});

test("多人一起快：出口组按权重；单条连接也要快：拆的只能是中间那段，一律 NEX 隧道", () => {
  assert.deepEqual(linkWizardAdvice("throughput", "exit").action, { type: "group", mode: "exit", exitStrategy: "least_load" });
  assert.deepEqual(linkWizardAdvice("throughput", "entry").action, { type: "group", mode: "entry" });
  for (const place of LINK_WIZARD_PLACES) {
    const action = linkWizardAdvice("single", place).action;
    assert.equal(action?.type, "tunnel", place);
    assert.equal(action?.type === "tunnel" && action.needsForwardX, true, place);
  }
  assert.equal((linkWizardAdvice("single", "one").action as any).relayMode, "chain");
});
