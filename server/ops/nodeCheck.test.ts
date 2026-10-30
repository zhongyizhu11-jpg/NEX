import assert from "node:assert/strict";
import test from "node:test";
import {
  ingestNodeCheckReport,
  nodeCheckDirectiveFor,
  nodeCheckSpeedTokenHost,
  nodeCheckStatus,
  pendingNodeCheckRunsForHost,
  resetNodeCheckStateForTest,
  setSpeedTestRecorderForTest,
  startNodeCheck,
  type SpeedTestRecord,
} from "./nodeCheck";
import { handleAgentExtRound } from "./agentExt";
import "./nodeCheckAgent";

const host = (id: number, agentVersion = "2.2.241", isOnline: unknown = true) => ({ id, name: `h${id}`, agentVersion, isOnline });
const outbound = { type: "vless", server: "node.example", server_port: 443, uuid: "u" };

test("旧 Agent、离线主机不能测；出口检测只给经节点的", () => {
  resetNodeCheckStateForTest();
  assert.throws(() => startNodeCheck(host(1, "2.2.240"), { kind: "speed" }), /需要把这台机器的 Agent 升级到 2\.2\.241/);
  assert.throws(() => startNodeCheck(host(1, "2.2.241", false), { kind: "speed" }), /主机离线/);
  assert.throws(() => startNodeCheck(host(1), { kind: "exit" }), /只给经节点的/);
  assert.equal(pendingNodeCheckRunsForHost(1).length, 0);
  assert.ok(startNodeCheck(host(1, "v2.2.241"), { kind: "speed" }).runId);
});

test("同一个对象只排一次；指令带 via 和站点；测速在跑时进度带曲线", async () => {
  resetNodeCheckStateForTest();
  const direct = startNodeCheck(host(2), { kind: "speed" });
  const again = startNodeCheck(host(2), { kind: "speed" });
  startNodeCheck(host(2), { kind: "exit", nodeId: 7, nodeName: "SG解锁", outbound });
  assert.equal(again.runId, direct.runId);
  assert.equal(again.reused, true);
  assert.match(direct.runId, /^nc-[a-z0-9-]+$/);
  const directive = nodeCheckDirectiveFor(2)!;
  assert.equal(directive.runs.length, 2);
  assert.deepEqual({ ...directive.runs[0], panel: undefined }, { runId: direct.runId, kind: "speed", family: "auto", panel: undefined });
  // 测速都带一个一次性口令，Agent 连不上 Cloudflare 时拿它来面板测。
  assert.match(String(directive.runs[0].panel?.token || ""), /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(nodeCheckSpeedTokenHost(directive.runs[0].panel!.token), 2);
  assert.equal(nodeCheckSpeedTokenHost("nope"), null);
  assert.equal(directive.runs[1].kind, "exit");
  assert.deepEqual((directive.runs[1] as any).via, { outbound });
  assert.ok((directive.runs[1] as any).targets.some((target: any) => target.key === "google"));
  assert.equal(nodeCheckDirectiveFor(3), undefined);

  await ingestNodeCheckReport(host(2), { runs: [{ runId: direct.runId, kind: "speed", status: "running", phase: "download", startedAt: 1, speed: { samples: [{ t: 500, down: 12.5, up: 0 }] } }] });
  const status = await nodeCheckStatus({ kind: "speed", hostId: 2, nodeId: 0 });
  assert.equal(status.pending?.phase, "download");
  assert.deepEqual(status.pending?.samples, [{ t: 500, down: 12.5, up: 0 }]);
  assert.equal(status.latest, null);
});

test("上报校验：只收排给这台主机的 runId；done 落库并成为最近一次；error 也结束等待", async () => {
  resetNodeCheckStateForTest();
  const recorded: SpeedTestRecord[] = [];
  setSpeedTestRecorderForTest(async (record) => { recorded.push(record); });
  const { runId } = startNodeCheck(host(4), { kind: "speed", nodeId: 9, nodeName: "JP", outbound, requestedBy: 1 });
  // 别台机器报这个 runId 不收
  await ingestNodeCheckReport(host(5), { runs: [{ runId, kind: "speed", status: "done", speed: { downloadMbps: 1 } }] });
  assert.equal(pendingNodeCheckRunsForHost(4).length, 1);
  await ingestNodeCheckReport(host(4), { runs: [{ runId, kind: "speed", status: "done", finishedAt: Math.floor(Date.now() / 1000), speed: { latencyMs: 95.2, jitterMs: 1, downloadMbps: 192.7, uploadMbps: 24.7, colo: "sin", clientIp: "217.116.172.44", asn: "AS209699", samples: [{ t: 500, down: 180 }, { t: 1000, down: 195 }] } }] });
  assert.equal(pendingNodeCheckRunsForHost(4).length, 0);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].nodeId, 9);
  assert.equal(recorded[0].result.colo, "SIN");
  assert.equal(recorded[0].result.samples.length, 2);
  const status = await nodeCheckStatus({ kind: "speed", hostId: 0, nodeId: 9 });
  assert.equal(status.pending, null);
  assert.equal(status.latest?.speed?.downloadMbps, 192.7);
  assert.equal(status.latest?.error, "");

  const exit = startNodeCheck(host(4), { kind: "exit", nodeId: 9, outbound });
  await ingestNodeCheckReport(host(4), { runs: [{ runId: exit.runId, kind: "exit", status: "error", error: "这台机器没有 sing-box" }] });
  const exitStatus = await nodeCheckStatus({ kind: "exit", hostId: 0, nodeId: 9 });
  assert.equal(exitStatus.pending, null);
  assert.match(exitStatus.latest?.error || "", /sing-box/);
  assert.equal(recorded.length, 1, "出错的不落库");
  setSpeedTestRecorderForTest(null);
});

test("经节点的出口检测结果：站点样本和解锁都收进来", async () => {
  resetNodeCheckStateForTest();
  const { runId } = startNodeCheck(host(6), { kind: "exit", nodeId: 11, outbound });
  await ingestNodeCheckReport(host(6), { runs: [{ runId, kind: "exit", status: "done", exit: {
    sites: [{ key: "google", samples: [{ t: 1, ms: 42, n: 3, k: 3 }] }, { key: "openai", samples: [{ t: 1, ms: -1, f: "poisoned", n: 3 }] }],
    unlock: [{ service: "netflix", status: "ok", region: "SG", detail: "可用" }],
  } }] });
  const status = await nodeCheckStatus({ kind: "exit", hostId: 0, nodeId: 11 });
  assert.deepEqual(status.latest?.exit?.sites, [
    { key: "google", ms: 42, fail: null, tries: 3, ok: 3 },
    { key: "openai", ms: null, fail: "poisoned", tries: 3, ok: 0 },
  ]);
  assert.equal(status.latest?.exit?.unlock[0].region, "SG");
});

test("走扩展通道：有在等的检查时下发指令、让 Agent 5 秒来一次；旧 Agent 收不到", async () => {
  resetNodeCheckStateForTest();
  const idle = await handleAgentExtRound(host(8), { modules: {} });
  assert.equal(idle.modules.nodecheck, undefined);
  const { runId } = startNodeCheck(host(8), { kind: "speed" });
  const busy = await handleAgentExtRound(host(8), { modules: {} });
  const nodecheck = busy.modules.nodecheck as { runs: Record<string, unknown>[] };
  assert.deepEqual({ runs: nodecheck.runs.map((run) => ({ ...run, panel: undefined })) }, { runs: [{ runId, kind: "speed", family: "auto", panel: undefined }] });
  assert.equal(busy.interval, 5);
  const old = await handleAgentExtRound(host(8, "2.2.240"), { modules: {} });
  assert.equal(old.modules.nodecheck, undefined);
  resetNodeCheckStateForTest();
});
