import assert from "node:assert/strict";
import test from "node:test";
import {
  getRestartAllStatus,
  getScan,
  getStop,
  ingestOpsReportForTest,
  opsDirectiveFor,
  rememberImportedRule,
  resetHostOpsStateForTest,
  setImportedRuleEnabler,
  startRestartAllRequest,
  startScan,
  startStopOriginal,
} from "./hostOpsAgent";

const host = (id: number) => ({ id, name: `h${id}`, agentVersion: "2.2.216" });

test("restart-all directive goes out until the host reports that request id", async () => {
  resetHostOpsStateForTest();
  const requestId = startRestartAllRequest({
    userId: 1,
    targets: [{ id: 1, name: "香港-1" }, { id: 2, name: "东京-1" }],
    skipped: [{ hostId: 3, name: "洛杉矶", reason: "离线" }],
  });
  assert.deepEqual(opsDirectiveFor(1), { restartAll: { requestId } });
  assert.equal(opsDirectiveFor(9), undefined);

  // 别的 requestId 的回报不算。
  await ingestOpsReportForTest(host(1), { restartAll: [{ requestId: "ra-other", status: "done", restarted: [], failed: [] }] });
  assert.deepEqual(opsDirectiveFor(1), { restartAll: { requestId } });
  // running 不算完成。
  await ingestOpsReportForTest(host(1), { restartAll: [{ requestId, status: "running" }] });
  assert.ok(opsDirectiveFor(1));

  await ingestOpsReportForTest(host(1), { restartAll: [{ requestId, status: "done", restarted: ["forwardx-runtime", "fxp:exit"], failed: [] }] });
  assert.equal(opsDirectiveFor(1), undefined);
  let status = getRestartAllStatus(requestId)!;
  assert.equal(status.finished, false);
  assert.equal(status.summary, "还在等 1 台，已重启 1 台，跳过 1 台（洛杉矶：离线）");

  await ingestOpsReportForTest(host(2), { restartAll: [{ requestId, status: "done", restarted: [], failed: [{ name: "fxp:a", error: "x" }] }] });
  status = getRestartAllStatus(requestId)!;
  assert.equal(status.finished, true);
  assert.equal(status.summary, "已重启 2 台，其中 1 台有进程没起来，跳过 1 台（洛杉矶：离线）");
});

test("scan results are sanitised and stop actions enable the imported rule", async () => {
  resetHostOpsStateForTest();
  const scanId = startScan(5);
  assert.deepEqual(opsDirectiveFor(5), { scan: { scanId } });
  await ingestOpsReportForTest(host(5), {
    scans: [{ scanId, status: "done", items: [
      { key: "aa11", tool: "realm", protocol: "tcp", listenPort: 10001, target: "203.0.113.10:443", source: "/etc/realm/config.toml", unit: "realm", importable: true },
      { key: "bad key", tool: "realm" },
    ] }],
  });
  const scan = getScan(5, scanId)!;
  assert.equal(scan.status, "done");
  assert.equal(scan.items.length, 1);
  assert.equal(opsDirectiveFor(5), undefined);
  assert.equal(getScan(6, scanId), null, "other hosts cannot read this scan");

  const enabled: number[] = [];
  setImportedRuleEnabler(async (_actor, ruleId) => { enabled.push(ruleId); });
  rememberImportedRule(5, "aa11", 42);
  const actionId = startStopOriginal({ hostId: 5, key: "aa11", ruleId: 42, label: "realm（realm）", actor: { id: 1, role: "admin" } });
  assert.equal(startStopOriginal({ hostId: 5, key: "aa11", ruleId: 42, label: "x", actor: { id: 1, role: "admin" } }), actionId, "same pending stop is reused");
  assert.deepEqual(opsDirectiveFor(5), { stops: [{ actionId, key: "aa11" }] });

  // 另一台主机报同一个 actionId：不认。
  await ingestOpsReportForTest(host(6), { stops: [{ actionId, status: "done", ok: true }] });
  assert.equal(getStop(5, actionId)!.status, "pending");

  await ingestOpsReportForTest(host(5), { stops: [{ actionId, status: "done", ok: true, message: "已停掉并禁用 realm" }] });
  const stop = getStop(5, actionId)!;
  assert.equal(stop.status, "done");
  assert.equal(stop.ok, true);
  assert.equal(stop.ruleEnabled, true);
  assert.deepEqual(enabled, [42]);
  assert.equal("actor" in stop, false, "actor is not exposed");
  assert.equal(opsDirectiveFor(5), undefined);
});

test("a failed stop leaves the rule disabled", async () => {
  resetHostOpsStateForTest();
  const enabled: number[] = [];
  setImportedRuleEnabler(async (_actor, ruleId) => { enabled.push(ruleId); });
  const actionId = startStopOriginal({ hostId: 7, key: "bb22", ruleId: 43, label: "socat", actor: { id: 1, role: "admin" } });
  await ingestOpsReportForTest(host(7), { stops: [{ actionId, status: "done", ok: false, error: "这一项已经不在了" }] });
  const stop = getStop(7, actionId)!;
  assert.equal(stop.ok, false);
  assert.equal(stop.error, "这一项已经不在了");
  assert.deepEqual(enabled, []);
});
