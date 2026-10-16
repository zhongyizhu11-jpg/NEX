import assert from "node:assert/strict";
import test from "node:test";

import { decideAutoChange, evaluateProbeRound, nextDetectionState, type AutoChangeInput } from "./detection";

const base = new Date("2026-10-16T00:00:00Z");
const at = (seconds: number) => new Date(base.getTime() + seconds * 1000);

function round(partial: Partial<Parameters<typeof evaluateProbeRound>[0]>) {
  return evaluateProbeRound({
    targetCount: 3,
    results: [],
    window: new Set(),
    consecutiveFailures: 0,
    lastCheckAt: null,
    checkIntervalSeconds: 60,
    now: base,
    ...partial,
  });
}

test("一轮里所有目标都失败才算一轮失败；只坏一个不算", () => {
  const partial = round({ results: [{ index: 0, ok: false }, { index: 1, ok: false }] });
  assert.equal(partial.kind, "pending", "还有一个目标没报失败");
  const rest = round({ results: [{ index: 2, ok: false }], window: (partial as any).window });
  assert.equal(rest.kind, "failure-round");
  assert.equal((rest as any).consecutiveFailures, 1);
  const mixed = round({ results: [{ index: 0, ok: false }, { index: 1, ok: true }, { index: 2, ok: false }], consecutiveFailures: 3 });
  assert.equal(mixed.kind, "success");
  assert.equal((mixed as any).consecutiveFailures, 0, "任何一次成功都清零");
});

test("两轮记账至少隔检测间隔的 80%：Agent 周期更短时失败先攒着", () => {
  const all = [{ index: 0, ok: false }, { index: 1, ok: false }, { index: 2, ok: false }];
  const first = round({ results: all, now: at(0) });
  assert.equal(first.kind, "failure-round");
  const tooSoon = round({ results: all, consecutiveFailures: 1, lastCheckAt: at(0), now: at(20) });
  assert.equal(tooSoon.kind, "pending");
  const later = round({ results: all, consecutiveFailures: 1, lastCheckAt: at(0), now: at(50) });
  assert.equal(later.kind, "failure-round");
  assert.equal((later as any).consecutiveFailures, 2);
});

test("成功但计数本来就是 0、又没到间隔的，不写库", () => {
  const quiet = round({ results: [{ index: 0, ok: true }], lastCheckAt: at(0), now: at(10) });
  assert.equal(quiet.kind, "success");
  assert.equal((quiet as any).recorded, false);
  const reset = round({ results: [{ index: 0, ok: true }], consecutiveFailures: 2, lastCheckAt: at(0), now: at(10) });
  assert.equal((reset as any).recorded, true);
});

test("认不出的结果（目标序号越界）、没有目标时忽略", () => {
  assert.equal(round({ results: [{ index: 7, ok: false }] }).kind, "ignored");
  assert.equal(round({ targetCount: 0, results: [{ index: 0, ok: false }] }).kind, "ignored");
});

test("换 IP 流程自己的状态不被探测结果改掉", () => {
  assert.equal(nextDetectionState("idle", 0), "healthy");
  assert.equal(nextDetectionState("healthy", 2), "failing");
  assert.equal(nextDetectionState("failing", 0), "healthy");
  for (const sticky of ["changing", "cooldown", "uncertain", "error", "disabled"] as const) {
    assert.equal(nextDetectionState(sticky, 9), sticky);
  }
});

function decision(partial: Partial<AutoChangeInput>) {
  return decideAutoChange({
    enabled: true,
    autoEnabled: true,
    state: "failing",
    consecutiveFailures: 5,
    failureThreshold: 5,
    hostOnline: true,
    inFlight: false,
    hasAccount: true,
    cooldownMinutes: 30,
    maxChangesPerDay: 3,
    lastAttemptAt: null,
    attemptsLast24h: 0,
    now: at(0),
    ...partial,
  });
}

test("自动更换的条件：阈值、在线、冷却、每日上限、状态", () => {
  assert.deepEqual(decision({}), { ok: true });
  assert.equal((decision({ consecutiveFailures: 4 }) as any).code, "below-threshold");
  assert.equal((decision({ autoEnabled: false }) as any).code, "auto-off");
  assert.equal((decision({ hostOnline: false }) as any).code, "host-offline");
  assert.equal((decision({ inFlight: true }) as any).code, "in-flight");
  assert.equal((decision({ state: "uncertain" }) as any).code, "state");
  assert.equal((decision({ state: "error" }) as any).code, "state");
  assert.equal((decision({ hasAccount: false }) as any).code, "no-account");
  assert.equal((decision({ lastAttemptAt: at(-29 * 60) }) as any).code, "cooldown");
  assert.deepEqual(decision({ lastAttemptAt: at(-31 * 60) }), { ok: true });
  assert.equal((decision({ attemptsLast24h: 3 }) as any).code, "daily-cap");
});
