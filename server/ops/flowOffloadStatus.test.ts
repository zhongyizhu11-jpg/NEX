import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_FLOW_OFFLOAD_MIN_VERSION,
  FLOW_OFFLOAD_REPORT_STALE_MS,
  flowOffloadDirectiveFor,
  flowOffloadStatusView,
  ingestFlowOffloadReport,
  parseFlowOffloadReport,
  resetFlowOffloadReportsForTest,
} from "./flowOffloadStatus";

const NOW = 1_800_000_000_000;

test("快速转发指令只发给够新的 Agent，开关默认关", () => {
  assert.equal(flowOffloadDirectiveFor({ agentVersion: "2.2.220", flowOffload: true }), undefined);
  assert.equal(flowOffloadDirectiveFor(null), undefined);
  assert.deepEqual(flowOffloadDirectiveFor({ agentVersion: AGENT_FLOW_OFFLOAD_MIN_VERSION }), { enabled: false });
  assert.deepEqual(flowOffloadDirectiveFor({ agentVersion: AGENT_FLOW_OFFLOAD_MIN_VERSION, flowOffload: true }), { enabled: true });
});

test("Agent 上报解析：嵌套的 accounting、截断、坏值", () => {
  assert.equal(parseFlowOffloadReport(null, NOW), undefined);
  const parsed = parseFlowOffloadReport({
    enabled: true,
    active: false,
    kernel: "5.10.0",
    devices: ["eth0", "nexwg1"],
    tcpPorts: 3,
    udpPorts: -1,
    accounting: { running: false, flows: 9, offloaded: "x", error: "订阅 conntrack 事件失败" },
  }, NOW);
  assert.deepEqual(parsed, {
    enabled: true,
    active: false,
    error: "订阅 conntrack 事件失败",
    kernel: "5.10.0",
    devices: ["eth0", "nexwg1"],
    tcpPorts: 3,
    udpPorts: 0,
    flows: 9,
    offloaded: 0,
    overflows: 0,
    at: NOW,
  });
});

test("主机设置页状态：关、旧 Agent、等上报、生效、出错、上报过期", () => {
  resetFlowOffloadReportsForTest();
  const host = { id: 7, agentVersion: AGENT_FLOW_OFFLOAD_MIN_VERSION, flowOffload: true };
  assert.equal(flowOffloadStatusView({ ...host, flowOffload: false }, NOW), null);
  assert.equal(flowOffloadStatusView({ ...host, agentVersion: "2.2.200" }, NOW)?.state, "agent-old");
  assert.equal(flowOffloadStatusView(host, NOW)?.state, "pending");

  ingestFlowOffloadReport(host, { enabled: true, active: true, accounting: { running: true, offloaded: 4 } }, NOW);
  assert.deepEqual(flowOffloadStatusView(host, NOW + 1000), { state: "active", message: "", offloaded: 4 });
  assert.equal(flowOffloadStatusView(host, NOW + FLOW_OFFLOAD_REPORT_STALE_MS + 1)?.state, "pending");

  ingestFlowOffloadReport(host, { enabled: true, active: false, error: "内核 5.10 太旧，要 6.1 起" }, NOW);
  assert.deepEqual(flowOffloadStatusView(host, NOW), { state: "error", message: "内核 5.10 太旧，要 6.1 起", offloaded: 0 });
  resetFlowOffloadReportsForTest();
});
