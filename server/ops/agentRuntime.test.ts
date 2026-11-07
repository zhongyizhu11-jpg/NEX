import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PPROF_MAX_MINUTES,
  agentPprofDirectiveFor,
  agentPprofIntervalFor,
  agentPprofRequestedUntil,
  getAgentPprofReport,
  getAgentRuntimeStats,
  ingestAgentPprofReport,
  normalizeAgentRuntimeStats,
  recordAgentRuntimeStats,
  resetAgentRuntimeStateForTests,
  setAgentPprof,
} from "./agentRuntime";

test("心跳里的 agentRuntime：收下、规整，老 Agent 不带就什么也不记", () => {
  resetAgentRuntimeStateForTests();
  recordAgentRuntimeStats(7, undefined);
  assert.equal(getAgentRuntimeStats(7), null);
  recordAgentRuntimeStats(7, {
    rssBytes: 52_428_800,
    heapBytes: 12_000_000.7,
    goroutines: 311,
    gcCount: 42,
    gcPauseMaxUs: 180,
    gcPauseTotalMs: 9,
    udpSessions: { active: 12, cap: 32768, evicted: 3, rejected: -1 },
    cpuAes: true,
    pprof: { running: true, addr: "127.0.0.1:6060", until: 1_800_000_000 },
  }, 1_000);
  const stats = getAgentRuntimeStats(7);
  assert.ok(stats);
  assert.equal(stats.rssBytes, 52_428_800);
  assert.equal(stats.heapBytes, 12_000_000);
  assert.equal(stats.goroutines, 311);
  assert.deepEqual(stats.udpSessions, { active: 12, cap: 32768, evicted: 3, rejected: 0 });
  assert.equal(stats.cpuAes, true);
  assert.equal(stats.pprof?.addr, "127.0.0.1:6060");
  assert.equal(stats.updatedAt, 1_000);
});

test("剖析地址只认 127.0.0.1：别的地址不照着显示", () => {
  const stats = normalizeAgentRuntimeStats({ pprof: { running: true, addr: "0.0.0.0:6060" } });
  assert.equal(stats?.pprof?.addr, "");
  assert.equal(normalizeAgentRuntimeStats("nope"), null);
  assert.equal(normalizeAgentRuntimeStats([1, 2]), null);
  assert.equal(normalizeAgentRuntimeStats({ cpuAes: "yes" })?.cpuAes, null);
});

test("性能剖析：默认关；打开给截止时间、封顶；到点或关掉后指令是 enabled=false", () => {
  resetAgentRuntimeStateForTests();
  const host = { id: 9 };
  const now = 1_700_000_000_000;
  assert.deepEqual(agentPprofDirectiveFor(host, now), { enabled: false, until: 0 });
  assert.equal(agentPprofIntervalFor(host, now), undefined);

  const until = setAgentPprof(9, 30, now);
  assert.equal(until, Math.floor(now / 1000) + 30 * 60);
  assert.deepEqual(agentPprofDirectiveFor(host, now), { enabled: true, until });
  assert.equal(agentPprofIntervalFor(host, now), 60);

  const capped = setAgentPprof(9, AGENT_PPROF_MAX_MINUTES * 10, now);
  assert.equal(capped, Math.floor(now / 1000) + AGENT_PPROF_MAX_MINUTES * 60);

  // 到点以后不再下发开着
  assert.equal(agentPprofRequestedUntil(9, (capped + 1) * 1000), 0);
  assert.deepEqual(agentPprofDirectiveFor(host, (capped + 1) * 1000), { enabled: false, until: 0 });

  setAgentPprof(9, 15, now);
  assert.equal(setAgentPprof(9, 0, now), 0);
  assert.deepEqual(agentPprofDirectiveFor(host, now), { enabled: false, until: 0 });
});

test("扩展通道里 Agent 报的剖析状态记下来", () => {
  resetAgentRuntimeStateForTests();
  ingestAgentPprofReport({ id: 3 }, { running: true, addr: "127.0.0.1:41234", until: 1_800_000_000 }, 5);
  assert.deepEqual(getAgentPprofReport(3), { running: true, addr: "127.0.0.1:41234", until: 1_800_000_000, error: "", reportedAt: 5 });
  ingestAgentPprofReport({ id: 3 }, null, 6);
  assert.equal(getAgentPprofReport(3)?.reportedAt, 5);
});
