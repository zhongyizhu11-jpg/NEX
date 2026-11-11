import assert from "node:assert/strict";
import test from "node:test";

import {
  getRealityCheckRun,
  ingestRealityCheckReport,
  pendingRealityChecksForHost,
  realityCheckDirectiveFor,
  RealityCheckError,
  resetRealityCheckStateForTest,
  startRealityCheck,
} from "./realityCheck";
import {
  isRealityServerName,
  normalizeRealityDestCheckResults,
  realityDestCandidateTargets,
  realityDestCheckTargetOf,
  realityDestCheckVerdict,
  REALITY_DEST_CANDIDATE_LIST_VERSION,
  REALITY_DEST_CANDIDATES,
  REALITY_DEST_CHECK_AGENT_VERSION,
} from "../../shared/realityDestCheck";

/**
 * REALITY 伪装目标检查：表单里的握手域名 / 目标怎么变成检查目标、候选清单、Agent 报上来的结果怎么规整和下结论，
 * 以及面板这边排检查 → 下指令 → 收结果 → 按 runId 查的整条路（不经 HTTP，直接调模块）。
 */

const host = { id: 5, name: "东京落地", agentVersion: "2.2.253", isOnline: true };
const admin = { id: 1, role: "admin" };

test("表单 → 检查目标：握手目标留空按握手域名的 443；IP 不能当握手域名", () => {
  assert.deepEqual(realityDestCheckTargetOf("dl.google.com"), { ok: true, target: { dest: "dl.google.com:443", serverName: "dl.google.com" } });
  assert.deepEqual(realityDestCheckTargetOf("www.amd.com", "www.amd.com:8443"), { ok: true, target: { dest: "www.amd.com:8443", serverName: "www.amd.com" } });
  assert.equal(realityDestCheckTargetOf("1.2.3.4").ok, false);
  assert.equal(realityDestCheckTargetOf("dl.google.com", "dl.google.com:99999").ok, false);
  assert.equal(isRealityServerName("localhost"), false);
  assert.equal(isRealityServerName("www.example.com"), true);
});

test("候选清单 v2：同名域名的 443，没有 Microsoft 系目标", () => {
  assert.equal(REALITY_DEST_CANDIDATE_LIST_VERSION, "v2");
  const targets = realityDestCandidateTargets();
  assert.equal(targets.length, REALITY_DEST_CANDIDATES.length);
  for (const target of targets) {
    assert.equal(target.dest, `${target.serverName}:443`);
    assert.equal(isRealityServerName(target.serverName), true);
  }
  assert.equal(REALITY_DEST_CANDIDATES.some((name) => /microsoft|bing|azure|office|live\.com/.test(name)), false);
});

test("结果规整：可不可用面板自己算；结论写出缺了哪几样", () => {
  const [ok, noH2, unreachable, blocked] = normalizeRealityDestCheckResults([
    { dest: "a.com:443", serverName: "a.com", reachable: true, tls13: true, x25519: true, h2: true, certValid: true, feasible: true, latencyMs: 31 },
    { dest: "b.com:443", serverName: "b.com", reachable: true, tls13: true, x25519: true, h2: false, certValid: false, feasible: true },
    { dest: "c.com:443", serverName: "c.com", reachable: false, error: "dial" },
    { dest: "d.com:443", serverName: "d.com", error: "blocked", extra: "dropped" },
  ])!;
  assert.equal(ok.feasible, true);
  assert.equal(realityDestCheckVerdict(ok), "可用");
  // Agent 说 feasible，可 h2、证书都没有：面板不信。
  assert.equal(noH2.feasible, false);
  assert.equal(realityDestCheckVerdict(noH2), "不支持 h2、证书和握手域名对不上");
  assert.equal(realityDestCheckVerdict(unreachable), "落地机连不上这个目标");
  assert.match(realityDestCheckVerdict(blocked), /内网/);
  assert.equal("extra" in blocked, false);
  assert.equal(normalizeRealityDestCheckResults("nope"), null);
});

test("排检查：旧 Agent（低于 2.2.253）和离线主机直接报错；同一台主机同时只排一次", () => {
  resetRealityCheckStateForTest();
  assert.throws(() => startRealityCheck({ ...host, agentVersion: "2.2.252" }, { targets: realityDestCandidateTargets(), requestedBy: 1 }),
    (error: unknown) => error instanceof RealityCheckError && new RegExp(REALITY_DEST_CHECK_AGENT_VERSION.replace(/\./g, "\\.")).test(error.message));
  assert.throws(() => startRealityCheck({ ...host, isOnline: false }, { targets: realityDestCandidateTargets(), requestedBy: 1 }), RealityCheckError);
  assert.throws(() => startRealityCheck(host, { targets: [], requestedBy: 1 }), RealityCheckError);
  const first = startRealityCheck(host, { targets: [{ dest: "dl.google.com:443", serverName: "dl.google.com" }], requestedBy: 2 });
  const again = startRealityCheck(host, { targets: realityDestCandidateTargets(), requestedBy: 2 });
  assert.equal(first.reused, false);
  assert.equal(again.runId, first.runId);
  assert.equal(again.reused, true);
  assert.deepEqual(realityCheckDirectiveFor(host.id), { runs: [{ runId: first.runId, targets: [{ dest: "dl.google.com:443", serverName: "dl.google.com" }] }] });
  assert.equal(realityCheckDirectiveFor(99), undefined);
});

test("收结果：只认排给这台主机的那次；少报的目标按超时补上；只有排检查的人和管理员看得到", () => {
  resetRealityCheckStateForTest();
  const targets = [
    { dest: "www.amd.com:443", serverName: "www.amd.com" },
    { dest: "www.sony.com:443", serverName: "www.sony.com" },
  ];
  const { runId } = startRealityCheck(host, { targets, requestedBy: 2 });
  // 别的主机报这个 runId：不收。
  ingestRealityCheckReport({ id: 6 }, { runs: [{ runId, status: "done", results: [] }] });
  assert.equal(getRealityCheckRun(runId, admin)?.status, "queued");
  ingestRealityCheckReport({ id: host.id }, { runs: [{ runId, status: "running" }] });
  assert.equal(getRealityCheckRun(runId, admin)?.status, "running");
  ingestRealityCheckReport({ id: host.id }, {
    runs: [{
      runId,
      status: "done",
      results: [{ dest: "www.amd.com:443", serverName: "www.amd.com", reachable: true, tls13: true, x25519: true, h2: true, certValid: true, latencyMs: 40 }],
    }],
  });
  const run = getRealityCheckRun(runId, { id: 2, role: "user" });
  assert.equal(run?.status, "done");
  assert.equal(run?.results.length, 2);
  assert.equal(run?.results[0].feasible, true);
  assert.equal(run?.results[1].error, "timeout");
  assert.equal(getRealityCheckRun(runId, { id: 3, role: "user" }), null);
  assert.ok(getRealityCheckRun(runId, admin));
  // 收完就不再下指令，也不再算「在等」。
  assert.equal(realityCheckDirectiveFor(host.id), undefined);
  assert.equal(pendingRealityChecksForHost(host.id).length, 0);
  // 已经收过的结果不会被后来的上报改掉。
  ingestRealityCheckReport({ id: host.id }, { runs: [{ runId, status: "done", results: [] }] });
  assert.equal(getRealityCheckRun(runId, admin)?.results.length, 2);
});
