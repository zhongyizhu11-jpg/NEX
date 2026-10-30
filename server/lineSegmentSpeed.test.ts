import assert from "node:assert/strict";
import test from "node:test";

import { LANDING_NOT_OWNED_REASON, planLineSegments } from "../shared/lineDiagnostics";
import {
  getSegmentSpeedRun,
  resetSegmentSpeedRunsForTest,
  startSegmentSpeedRun,
  type SegmentEndpoints,
  type SegmentSpeedDeps,
} from "./lineSegmentSpeed";

function iperf3Output(sendMbps: number, recvMbps: number) {
  return [
    "[ ID] Interval           Transfer     Bitrate         Retr",
    `[SUM]   0.00-8.00   sec   400 MBytes   ${sendMbps} Mbits/sec   12             sender`,
    `[SUM]   0.00-8.04   sec   398 MBytes   ${recvMbps} Mbits/sec                  receiver`,
    "",
    "iperf Done.",
  ].join("\n");
}

const plan = planLineSegments({
  entry: { hostId: 1, name: "入口" },
  hops: [{ hostId: 2, name: "港-1" }, { hostId: 3, name: "日-1" }],
  landing: { name: "203.0.113.9:443" },
});
const endpoints: Array<SegmentEndpoints | null> = [
  { fromHostId: 1, toHostId: 2, toAddress: "hk.example.com" },
  { fromHostId: 2, toHostId: 3, toAddress: "198.51.100.3" },
  null,
];

function fakeDeps(overrides: Partial<SegmentSpeedDeps> = {}) {
  const log: string[] = [];
  const running = new Set<number>();
  const deps: SegmentSpeedDeps = {
    async startServer(hostId) {
      // 段与段一个一个来：开新服务端时不能还有别的开着。
      assert.equal(running.size, 0, "上一段的 iperf3 服务端还没停");
      running.add(hostId);
      log.push(`start ${hostId}`);
      return 40000 + hostId;
    },
    async stopServer(hostId) {
      running.delete(hostId);
      log.push(`stop ${hostId}`);
    },
    async runClient({ hostId, target, port, reverse }) {
      log.push(`client ${hostId}->${target}:${port}${reverse ? " -R" : ""}`);
      if (hostId === 1) return reverse ? iperf3Output(800, 790) : iperf3Output(905, 900);
      return reverse ? iperf3Output(300, 290) : iperf3Output(125, 120.5);
    },
    ...overrides,
  };
  return { deps, log };
}

test("分段测速：一段一段测，先正向再反向，测完停服务端；落地那段跳过；找出最慢的", async () => {
  resetSegmentSpeedRunsForTest();
  const { deps, log } = fakeDeps();
  const started = startSegmentSpeedRun({ ruleId: 7, pathKey: "p1", pathName: "A 主线路", userId: 5, allowPrivate: false, plan, endpoints, deps });
  assert.equal(started.view.status, "running");
  assert.deepEqual(started.view.segments.map((segment) => segment.status), ["running", "pending", "skipped"]);
  assert.equal(started.view.segments[2].error, LANDING_NOT_OWNED_REASON);
  // 同一条规则测着的时候不能再开一轮
  assert.throws(() => startSegmentSpeedRun({ ruleId: 7, pathKey: "p1", pathName: "A", userId: 5, allowPrivate: false, plan, endpoints, deps }), /正在分段测速/);
  await started.done;

  assert.deepEqual(log, [
    "start 2",
    "client 1->hk.example.com:40002",
    "client 1->hk.example.com:40002 -R",
    "stop 2",
    "start 3",
    "client 2->198.51.100.3:40003",
    "client 2->198.51.100.3:40003 -R",
    "stop 3",
  ]);
  const view = getSegmentSpeedRun(started.runId, { id: 5, role: "user" });
  assert.ok(view);
  assert.equal(view.status, "done");
  assert.deepEqual(view.segments.map((segment) => [segment.from.name, segment.to.name, segment.status, segment.mbps, segment.reverseMbps]), [
    ["入口", "港-1", "done", 900, 790],
    ["港-1", "日-1", "done", 120.5, 290],
    ["日-1", "203.0.113.9:443", "skipped", null, null],
  ]);
  assert.equal(view.slowest, 1);
  assert.ok(view.finishedAt);
  // 别人看不到，管理员看得到
  assert.equal(getSegmentSpeedRun(started.runId, { id: 6, role: "user" }), null);
  assert.ok(getSegmentSpeedRun(started.runId, { id: 1, role: "admin" }));
  assert.equal(getSegmentSpeedRun("nope", { id: 1, role: "admin" }), null);
});

test("分段测速：一段没装 iperf3 只算这一段出错，服务端照样停；反向失败不影响正向", async () => {
  resetSegmentSpeedRunsForTest();
  const { deps, log } = fakeDeps({
    async startServer(hostId) {
      log.push(`start ${hostId}`);
      if (hostId === 2) throw new Error("Agent 主机没装 iperf3，测不了速");
      return 5201;
    },
    async runClient({ reverse }) {
      if (reverse) throw new Error("timeout");
      return iperf3Output(50, 48);
    },
  });
  const started = startSegmentSpeedRun({ ruleId: 8, pathKey: "p1", pathName: "A", userId: 5, allowPrivate: false, plan, endpoints, deps });
  await started.done;
  const view = getSegmentSpeedRun(started.runId, { id: 5, role: "user" })!;
  assert.equal(view.status, "done");
  assert.equal(view.segments[0].status, "error");
  assert.match(String(view.segments[0].error), /没装 iperf3/);
  assert.equal(view.segments[1].status, "done");
  assert.equal(view.segments[1].mbps, 48);
  assert.equal(view.segments[1].reverseMbps, null);
  assert.equal(view.slowest, 1);
  assert.ok(log.includes("stop 3"));
});

test("分段测速：每段都失败整轮算 error；输出读不出带宽算这一段失败", async () => {
  resetSegmentSpeedRunsForTest();
  const { deps, log } = fakeDeps({ async runClient() { return "iperf3: error - unable to connect to server: Connection refused"; } });
  const started = startSegmentSpeedRun({ ruleId: 9, pathKey: "p1", pathName: "A", userId: 5, allowPrivate: false, plan, endpoints, deps });
  await started.done;
  const view = getSegmentSpeedRun(started.runId, { id: 5, role: "user" })!;
  assert.equal(view.status, "error");
  assert.match(String(view.error), /没有汇总带宽/);
  assert.equal(view.slowest, null);
  assert.deepEqual(log.filter((line) => line.startsWith("stop")), ["stop 2", "stop 3"]);
});

test("分段测速：直连路径（只有到落地那段）直接 done，全部跳过", async () => {
  resetSegmentSpeedRunsForTest();
  const direct = planLineSegments({ entry: { hostId: 1, name: "入口" }, hops: [], landing: { name: "x" } });
  const { deps, log } = fakeDeps();
  const started = startSegmentSpeedRun({ ruleId: 10, pathKey: "p1", pathName: "A", userId: 5, allowPrivate: false, plan: direct, endpoints: [null], deps });
  await started.done;
  const view = getSegmentSpeedRun(started.runId, { id: 5, role: "user" })!;
  assert.equal(view.status, "done");
  assert.deepEqual(view.segments.map((segment) => segment.status), ["skipped"]);
  assert.equal(log.length, 0);
  resetSegmentSpeedRunsForTest();
});
