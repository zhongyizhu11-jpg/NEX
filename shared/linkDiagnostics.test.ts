import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiagnosticsReport,
  diagnosticVerdict,
  formatDiagnosticsReportText,
  pickDiagnosticCause,
  type DiagnosticItem,
} from "./linkDiagnostics";

const base = { source: "panel" as const };
const items: DiagnosticItem[] = [
  { ...base, key: "target.dial", group: "target", title: "连得上目标", status: "fail", summary: "连接超时", hint: "检查目标防火墙" },
  { ...base, key: "config.enabled", group: "config", title: "规则已启用", status: "pass", summary: "已启用" },
  { ...base, key: "entry.listen", group: "entry", title: "端口在监听", status: "fail", summary: "没有程序在听", hint: "看 Agent 日志", hostName: "hk-1" },
  { ...base, key: "host:1", group: "host", title: "入口「hk-1」", status: "warn", summary: "Agent 版本旧" },
];

test("最可能的原因：按 配置 → 主机 → 入口 → 链路 → 目标 取第一项失败，没失败才看警告", () => {
  assert.equal(pickDiagnosticCause(items)?.key, "entry.listen");
  assert.equal(pickDiagnosticCause(items)?.hostName, "hk-1");
  assert.equal(pickDiagnosticCause(items.filter((item) => item.status !== "fail"))?.key, "host:1");
  assert.equal(pickDiagnosticCause(items.filter((item) => item.status === "pass")), null);
});

test("总评：失败优先；没失败有等待就是诊断中；跳过不算问题", () => {
  assert.equal(diagnosticVerdict(items), "fail");
  const pending: DiagnosticItem = { ...base, key: "agent:1:c1", group: "entry", title: "x", status: "pending", summary: "等待" };
  assert.equal(diagnosticVerdict([items[1], items[3], pending]), "pending");
  assert.equal(diagnosticVerdict([items[1], items[3]]), "warn");
  assert.equal(diagnosticVerdict([items[1], { ...items[1], key: "s", status: "skip" }]), "pass");
});

test("报告：计数、running、结论文案", () => {
  const report = buildDiagnosticsReport({ sessionId: "s", subject: { kind: "rule", id: 7, name: "游戏加速" }, startedAt: "2026-10-16T00:00:00Z", items });
  assert.deepEqual(report.counts, { pass: 1, warn: 1, fail: 2, skip: 0, pending: 0 });
  assert.equal(report.running, false);
  assert.equal(report.verdictText, "发现 2 项失败");
  assert.equal(report.cause?.key, "entry.listen");
});

test("复制给客服的文本：按组分段，带状态、建议和原始细节；需要升级的项写清楚", () => {
  const report = buildDiagnosticsReport({
    sessionId: "s",
    subject: { kind: "tunnel", id: 3, name: "港口" },
    startedAt: "2026-10-16T00:00:00Z",
    items: [
      ...items,
      { source: "agent", key: "agent:2:c1", group: "link", title: "防火墙放行", status: "skip", needsUpgrade: true, summary: "需要升级 Agent 到 2.2.225" },
      { ...base, key: "target.addr", group: "target", title: "目标地址", status: "pass", summary: "公网 IPv4", detail: "line1\nline2", latencyMs: 30 },
    ],
  });
  const text = formatDiagnosticsReportText(report);
  assert.match(text, /^NEX 链路诊断 · 隧道「港口」\(#3\)/);
  assert.match(text, /最可能的原因：端口在监听 —— 没有程序在听/);
  assert.ok(text.indexOf("【配置】") < text.indexOf("【主机】") && text.indexOf("【主机】") < text.indexOf("【目标】"));
  assert.match(text, /\[失败\] 端口在监听：没有程序在听\n    建议：看 Agent 日志/);
  assert.match(text, /\[需要升级 Agent\] 防火墙放行/);
  assert.match(text, /\[通过\] 目标地址：公网 IPv4（30 ms）\n    \| line1\n    \| line2/);
  assert.doesNotMatch(formatDiagnosticsReportText(report, { includeDetail: false }), /\| line1/);
});
