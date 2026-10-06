import assert from "node:assert/strict";
import test from "node:test";
import {
  capLookingGlassOutput,
  completeLookingGlassAgentTask,
  enqueueLookingGlassAgentTask,
  IPERF3_CLIENT_DEFAULT_SECONDS,
  IPERF3_CLIENT_DEFAULT_STREAMS,
  IPERF3_CLIENT_MAX_SECONDS,
  IPERF3_CLIENT_MAX_STREAMS,
  IPERF3_CLIENT_MIN_SECONDS,
  IPERF3_CLIENT_TIMEOUT_GRACE_MS,
  LOOKING_GLASS_OUTPUT_MAX_BYTES,
  getLookingGlassAgentTaskStatus,
  IPERF3_CLIENT_UDP_MAX_MBPS,
  normalizeIperf3ClientOptions,
  pruneLookingGlassAgentTaskStates,
  takeLookingGlassAgentTasks,
} from "./lookingGlassAgentTasks";

test("timed-out Looking Glass tasks leave the queue and are eventually removed", async () => {
  const hostId = 987654;
  const { task } = enqueueLookingGlassAgentTask(hostId, {
    method: "ping",
    target: "example.com",
    resolvedAddress: "192.0.2.1",
    resolvedAddresses: ["192.0.2.1"],
    family: 4,
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = getLookingGlassAgentTaskStatus(hostId, task.taskId);
  assert.equal(status?.status, "timeout");
  assert.deepEqual(takeLookingGlassAgentTasks(hostId), []);

  const updatedAt = new Date(status!.updatedAt).getTime();
  assert.equal(pruneLookingGlassAgentTaskStates(updatedAt + 16 * 60 * 1000), 1);
  assert.equal(getLookingGlassAgentTaskStatus(hostId, task.taskId), null);
});

test("Looking Glass output reported by an Agent is capped before it is kept", () => {
  assert.equal(capLookingGlassOutput("short"), "short");
  const huge = "a".repeat(LOOKING_GLASS_OUTPUT_MAX_BYTES * 4);
  const capped = capLookingGlassOutput(huge);
  assert.ok(Buffer.byteLength(capped, "utf8") < LOOKING_GLASS_OUTPUT_MAX_BYTES + 256);
  assert.match(capped, /已截断/);
  // 多字节字符被截在中间时不能留下半个字符。
  assert.doesNotMatch(capLookingGlassOutput("中".repeat(LOOKING_GLASS_OUTPUT_MAX_BYTES)), /\uFFFD/);

  const hostId = 987655;
  const { task } = enqueueLookingGlassAgentTask(hostId, {
    method: "ping",
    target: "example.com",
    resolvedAddress: "192.0.2.1",
    resolvedAddresses: ["192.0.2.1"],
    family: 4,
  }, 60_000);
  takeLookingGlassAgentTasks(hostId);
  assert.equal(completeLookingGlassAgentTask(hostId, { taskId: task.taskId, output: huge, exitCode: 0 } as any), true);
  const status = getLookingGlassAgentTaskStatus(hostId, task.taskId);
  assert.ok(Buffer.byteLength(String(status?.output || ""), "utf8") < LOOKING_GLASS_OUTPUT_MAX_BYTES + 256);
});

test("iperf3 客户端参数收敛到边界内，任务时限跟着时长走", () => {
  const defaults = normalizeIperf3ClientOptions({});
  assert.equal(defaults.streams, IPERF3_CLIENT_DEFAULT_STREAMS);
  assert.equal(defaults.seconds, IPERF3_CLIENT_DEFAULT_SECONDS);
  assert.equal(defaults.reverse, false);
  assert.equal(defaults.timeoutMs, IPERF3_CLIENT_DEFAULT_SECONDS * 1000 + IPERF3_CLIENT_TIMEOUT_GRACE_MS);

  const clamped = normalizeIperf3ClientOptions({ streams: 500, seconds: 3600, reverse: true });
  assert.equal(clamped.streams, IPERF3_CLIENT_MAX_STREAMS);
  assert.equal(clamped.seconds, IPERF3_CLIENT_MAX_SECONDS);
  assert.equal(clamped.reverse, true);
  assert.equal(clamped.timeoutMs, IPERF3_CLIENT_MAX_SECONDS * 1000 + IPERF3_CLIENT_TIMEOUT_GRACE_MS);

  const low = normalizeIperf3ClientOptions({ streams: 0, seconds: 1, reverse: "yes" });
  assert.equal(low.streams, 1);
  assert.equal(low.seconds, IPERF3_CLIENT_MIN_SECONDS);
  assert.equal(low.reverse, false);
  assert.equal(low.udp, false);
  assert.equal(low.udpMbps, 0);

  // UDP 模式：每条流的速率封顶，0 = 不限；没开 UDP 时速率不带过去。
  const udp = normalizeIperf3ClientOptions({ udp: true, udpMbps: 2500 });
  assert.equal(udp.udp, true);
  assert.equal(udp.udpMbps, 2500);
  assert.equal(normalizeIperf3ClientOptions({ udp: true, udpMbps: 9_999_999 }).udpMbps, IPERF3_CLIENT_UDP_MAX_MBPS);
  assert.equal(normalizeIperf3ClientOptions({ udp: true }).udpMbps, 0);
  assert.equal(normalizeIperf3ClientOptions({ udp: "true", udpMbps: 100 }).udp, false);
  assert.equal(normalizeIperf3ClientOptions({ udp: false, udpMbps: 100 }).udpMbps, 0);

  // 任务里带着这些参数走到 Agent 那一侧。
  const hostId = 987656;
  const { task } = enqueueLookingGlassAgentTask(hostId, {
    method: "iperf3-client",
    target: "203.0.113.9",
    resolvedAddress: "203.0.113.9",
    resolvedAddresses: ["203.0.113.9"],
    family: 4,
    port: 5201,
    ...clamped,
  }, clamped.timeoutMs);
  const [taken] = takeLookingGlassAgentTasks(hostId);
  assert.equal(taken.taskId, task.taskId);
  assert.equal(taken.method, "iperf3-client");
  assert.equal(taken.reverse, true);
  assert.equal(taken.streams, IPERF3_CLIENT_MAX_STREAMS);
  assert.equal(taken.seconds, IPERF3_CLIENT_MAX_SECONDS);
});
