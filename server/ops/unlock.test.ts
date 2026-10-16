import assert from "node:assert/strict";
import test from "node:test";
import {
  ingestUnlockReport,
  pendingUnlockRunsForHost,
  pickScheduledUnlockHosts,
  resetUnlockStateForTest,
  setUnlockRecorderForTest,
  startUnlockCheck,
  unlockDirectiveFor,
  type UnlockRunRecord,
} from "./unlock";
import { handleAgentExtRound } from "./agentExt";
import "./unlockAgent";

const host = (id: number, agentVersion = "2.2.226", isOnline: unknown = true) => ({ id, name: `h${id}`, agentVersion, isOnline });

test("旧 Agent、离线主机不能检测：提示升级到 2.2.226", () => {
  resetUnlockStateForTest();
  assert.throws(() => startUnlockCheck(host(1, "2.2.224"), { family: "auto" }), /需要升级 Agent 到 2\.2\.225/);
  assert.throws(() => startUnlockCheck(host(1, ""), { family: "auto" }), /需要升级 Agent/);
  assert.throws(() => startUnlockCheck(host(1, "2.2.226", false), { family: "auto" }), /主机离线/);
  assert.equal(pendingUnlockRunsForHost(1).length, 0);
  assert.ok(startUnlockCheck(host(1, "v2.2.230"), { family: "auto" }).runId);
});

test("同一台主机同一个 family 只排一次；指令带上所有在等的检测", () => {
  resetUnlockStateForTest();
  const a = startUnlockCheck(host(2), { family: "auto" });
  const again = startUnlockCheck(host(2), { family: "auto" });
  const v6 = startUnlockCheck(host(2), { family: "ipv6" });
  const bogus = startUnlockCheck(host(2), { family: "ipx" });
  assert.equal(again.runId, a.runId);
  assert.equal(again.reused, true);
  assert.equal(bogus.runId, a.runId, "认不出的 family 当 auto");
  assert.match(a.runId, /^ul-[a-z0-9-]+$/);
  assert.deepEqual(unlockDirectiveFor(2), { runs: [{ runId: a.runId, family: "auto" }, { runId: v6.runId, family: "ipv6" }] });
  assert.equal(unlockDirectiveFor(3), undefined);
});

test("上报校验：只收排给这台主机的 runId，结果清洗后落库，收到 done 就不再下发", async () => {
  resetUnlockStateForTest();
  const recorded: UnlockRunRecord[] = [];
  setUnlockRecorderForTest(async (record) => { recorded.push(record); });
  const { runId } = startUnlockCheck(host(5), { family: "ipv4", requestedBy: 9 });
  const results = [
    { service: "netflix", status: "partial", region: "sg", detail: "仅自制剧" },
    { service: "made-up", status: "ok" },
    { service: "claude", status: "weird" },
  ];
  // 别的主机报这个 runId、编的 runId、格式不对的，都不收。
  await ingestUnlockReport(host(6), { runs: [{ runId, status: "done", results }] });
  await ingestUnlockReport(host(5), { runs: [{ runId: "ul-not-pending", status: "done", results }, { runId: "DROP TABLE", status: "done" }] });
  await ingestUnlockReport(host(5), { runs: "nope" });
  await ingestUnlockReport(host(5), null);
  assert.equal(recorded.length, 0);
  // running 只记开始时间。
  await ingestUnlockReport(host(5), { runs: [{ runId, status: "running" }] });
  assert.ok(pendingUnlockRunsForHost(5)[0].startedAt);
  assert.equal(recorded.length, 0);

  await ingestUnlockReport(host(5), { runs: [{ runId, status: "done", finishedAt: 1, results }] });
  assert.equal(recorded.length, 1);
  const record = recorded[0];
  assert.equal(record.hostId, 5);
  assert.equal(record.family, "ipv4");
  assert.equal(record.trigger, "manual");
  assert.equal(record.requestedBy, 9);
  assert.ok(Math.abs(record.checkedAt - Date.now() / 1000) < 5, "Agent 时钟离谱时用面板时间");
  assert.deepEqual(record.results, [
    { service: "netflix", status: "partial", region: "SG", detail: "仅自制剧", ms: null },
    { service: "claude", status: "unknown", region: null, detail: "", ms: null },
  ]);
  assert.equal(unlockDirectiveFor(5), undefined);
  // 同一个 done 再报一次（Agent 会连着报 15 分钟）不会再落库。
  await ingestUnlockReport(host(5), { runs: [{ runId, status: "done", results }] });
  assert.equal(recorded.length, 1);
  resetUnlockStateForTest();
});

test("走扩展通道：有在等的检测时下发指令、让 Agent 5 秒来一次", async () => {
  resetUnlockStateForTest();
  const recorded: UnlockRunRecord[] = [];
  setUnlockRecorderForTest(async (record) => { recorded.push(record); });
  const idle = await handleAgentExtRound(host(8), { modules: {} });
  assert.equal(idle.modules.unlock, undefined);
  const { runId } = startUnlockCheck(host(8), { family: "auto" });
  const busy = await handleAgentExtRound(host(8), { modules: {} });
  assert.deepEqual(busy.modules.unlock, { runs: [{ runId, family: "auto" }] });
  assert.equal(busy.interval, 5);
  // 旧 Agent 收不到这个模块的指令。
  const old = await handleAgentExtRound(host(8, "2.2.224"), { modules: {} });
  assert.equal(old.modules.unlock, undefined);
  await handleAgentExtRound(host(8), { modules: { unlock: { runs: [{ runId, status: "done", results: [{ service: "gemini", status: "ok", region: "USA", detail: "可用" }] }] } } });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].results[0].region, "USA");
  resetUnlockStateForTest();
});

test("计划检测：只挑在线、Agent 够新、到期、没在等的主机，最久没测的先来", () => {
  resetUnlockStateForTest();
  const now = 10_000_000;
  const hosts = [host(1), host(2), host(3, "2.2.200"), host(4, "2.2.226", false), host(5), host(6)];
  const last = new Map([[1, now - 3600], [2, now - 2 * 86400], [5, now - 90_000]]);
  startUnlockCheck(host(6), { family: "ipv6" });
  assert.deepEqual(pickScheduledUnlockHosts(hosts, last, "daily", now).map((h) => h.id), [2, 5]);
  assert.deepEqual(pickScheduledUnlockHosts(hosts, last, "weekly", now).map((h) => h.id), []);
  assert.deepEqual(pickScheduledUnlockHosts(hosts, last, "off", now), []);
  assert.deepEqual(pickScheduledUnlockHosts(hosts, new Map(), "weekly", now, 2).map((h) => h.id), [1, 2]);
  resetUnlockStateForTest();
});
