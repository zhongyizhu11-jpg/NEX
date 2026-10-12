import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRestartTargets,
  listenAddrNote,
  restartAllSummary,
  sanitizeScanItem,
  scanItemToRuleInput,
  type ScanItem,
} from "./hostOpsLogic";

test("restart-all skips offline hosts and old agents with a reason", () => {
  const { targets, skipped } = classifyRestartTargets([
    { id: 1, name: "香港-1", online: true, agentVersion: "2.2.216" },
    { id: 2, name: "东京-1", online: true, agentVersion: "2.2.215" },
    { id: 3, name: "洛杉矶", online: false, agentVersion: "2.3.0" },
  ]);
  assert.deepEqual(targets.map((host) => host.id), [1]);
  assert.deepEqual(skipped, [
    { hostId: 2, name: "东京-1", reason: "Agent 太旧" },
    { hostId: 3, name: "洛杉矶", reason: "离线" },
  ]);
});

test("restart-all summary reads like the owner expects", () => {
  const done = (hostId: number, failed = 0) => ({
    hostId, name: `h${hostId}`, status: "done" as const, restarted: ["forwardx-runtime"],
    failed: Array.from({ length: failed }, () => ({ name: "fxp:x", error: "e" })),
  });
  assert.equal(
    restartAllSummary([done(1), done(2), done(3), done(4), done(5)], [
      { hostId: 6, name: "东京-1", reason: "Agent 太旧" },
      { hostId: 7, name: "香港-2", reason: "离线" },
    ]),
    "已重启 5 台，跳过 2 台（东京-1：Agent 太旧；香港-2：离线）",
  );
  assert.equal(
    restartAllSummary([done(1, 1), { ...done(2), status: "pending" }, { ...done(3), status: "timeout" }], []),
    "还在等 1 台，已重启 1 台，其中 1 台有进程没起来，1 台没回应（h3）",
  );
});

const item = (patch: Partial<ScanItem>): ScanItem => ({
  key: "abc123", tool: "realm", protocol: "tcp", listenPort: 10001, target: "203.0.113.10:443", source: "/etc/realm/config.toml", importable: true, ...patch,
});

test("scan item converts into a rules.create input", () => {
  assert.deepEqual(scanItemToRuleInput(item({ protocol: "both" })), {
    input: { name: "导入 realm :10001", forwardType: "realm", protocol: "both", sourcePort: 10001, targetIp: "203.0.113.10", targetPort: 443 },
  });
  assert.deepEqual(scanItemToRuleInput(item({ tool: "iptables", target: "[2001:db8::5]:53", protocol: "udp" })), {
    input: { name: "导入 iptables :10001", forwardType: "iptables", protocol: "udp", sourcePort: 10001, targetIp: "2001:db8::5", targetPort: 53 },
  });
  assert.deepEqual(scanItemToRuleInput(item({ importable: false, reason: "有多个目标" })), { error: "有多个目标" });
  assert.deepEqual(scanItemToRuleInput(item({ tool: "x-ui" })), { error: "面板没有 x-ui 这种转发方式" });
  assert.deepEqual(scanItemToRuleInput(item({ target: "198.51.100.22" })), { error: "看不懂目标地址 198.51.100.22" });
});

test("agent scan items are sanitised before the panel trusts them", () => {
  assert.equal(sanitizeScanItem({ key: "../etc", tool: "realm" }), null);
  assert.equal(sanitizeScanItem(null), null);
  const cleaned = sanitizeScanItem({ key: "ABCDEF01", tool: "gost", protocol: "sctp", listenPort: 70000, importable: "yes", source: 5 });
  assert.deepEqual(cleaned, {
    key: "ABCDEF01", tool: "gost", protocol: undefined, listenAddr: undefined, listenPort: undefined, target: undefined,
    source: "", unit: undefined, unitActive: false, importable: false, reason: undefined,
  });
  assert.equal(listenAddrNote(item({ listenAddr: "0.0.0.0" })), null);
  assert.equal(listenAddrNote(item({ listenAddr: "10.0.0.5" })), "原来只听 10.0.0.5，导入后会听所有地址");
});
