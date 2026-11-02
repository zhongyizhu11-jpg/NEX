import assert from "node:assert/strict";
import test from "node:test";

import { checklistKindOf, diagnosticsRouter, latencyFromTestRow, latencyFromTunnel } from "./routers/diagnostics";
import { lineDiagnosticsRouter } from "./routers/lineDiagnostics";
import { nodePoolsRouter } from "./routers/nodePools";
import { appRouter } from "./routers";

test("统一诊断入口：线路按规则算清单，其余照原样", () => {
  assert.equal(checklistKindOf("line"), "rule");
  assert.equal(checklistKindOf("rule"), "rule");
  assert.equal(checklistKindOf("tunnel"), "tunnel");
  assert.equal(checklistKindOf("forwardGroup"), "forwardGroup");
});

test("统一诊断入口：旧过程都在，新过程也在", () => {
  const procedures = Object.keys(diagnosticsRouter._def.procedures).sort();
  for (const name of ["start", "status", "faultBundle", "latencyStart", "latencyStatus", "speedStart", "speedStatus"]) {
    assert.ok(procedures.includes(name), `diagnostics.${name}`);
  }
});

test("延迟结果：规则 / 转发链的测试行和隧道上的 lastTest* 统一成一个样子", () => {
  const row = latencyFromTestRow("rule", 7, { status: "success", latencyMs: 42, message: "{}", updatedAt: new Date("2026-11-01T00:00:00Z") });
  assert.deepEqual(row, { kind: "rule", id: 7, status: "success", testing: false, latencyMs: 42, message: "{}", at: "2026-11-01T00:00:00.000Z" });
  const running = latencyFromTestRow("forwardGroup", 3, { status: "running", latencyMs: null, message: null, createdAt: "2026-11-01T00:00:00Z" });
  assert.equal(running.testing, true);
  assert.equal(running.latencyMs, null);
  assert.equal(running.at, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(latencyFromTestRow("line", 9, null), { kind: "line", id: 9, status: null, testing: false, latencyMs: null, message: null, at: null });
  const tunnel = latencyFromTunnel(5, { lastTestStatus: "failed", lastLatencyMs: null, lastTestMessage: "timeout", lastTestAt: 1_790_000_000 });
  assert.equal(tunnel.kind, "tunnel");
  assert.equal(tunnel.status, "failed");
  assert.equal(tunnel.message, "timeout");
  assert.equal(tunnel.at, new Date(1_790_000_000 * 1000).toISOString());
});

test("nodePools.* 是 lineDiagnostics 下那几个过程的正名：同一个过程，旧名字还在", () => {
  const legacy = lineDiagnosticsRouter._def.procedures as Record<string, unknown>;
  const alias = nodePoolsRouter._def.procedures as Record<string, unknown>;
  const pairs: Array<[string, string]> = [
    ["board", "poolBoard"],
    ["list", "nodePools"],
    ["save", "nodePoolSave"],
    ["suggestDomain", "nodePoolSuggestDomain"],
    ["rotate", "nodePoolRotate"],
    ["delete", "nodePoolDelete"],
    ["import", "nodePoolImport"],
  ];
  for (const [name, old] of pairs) {
    assert.ok(legacy[old], `lineDiagnostics.${old} 还在`);
    assert.equal(alias[name], legacy[old], `nodePools.${name} = lineDiagnostics.${old}`);
  }
  const app = appRouter._def.procedures as Record<string, unknown>;
  assert.ok(app["nodePools.list"], "挂在 appRouter 上");
  assert.ok(app["lineDiagnostics.nodePools"], "旧路径还在");
});
