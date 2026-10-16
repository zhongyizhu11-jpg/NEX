import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildDiagnosticsReport, type DiagnosticItem } from "@shared/linkDiagnostics";
import { DiagnosticStatusPill, LinkDiagnosticsChecklist } from "./LinkDiagnosticsPanel";

const items: DiagnosticItem[] = [
  { source: "panel", key: "config.enabled", group: "config", title: "规则已启用", status: "pass", summary: "已启用" },
  { source: "panel", key: "host:1", group: "host", title: "入口「hk」", status: "pass", summary: "在线 · Agent 2.2.226" },
  { source: "agent", key: "agent:1:c1", group: "entry", title: "端口 443/tcp 在监听", status: "fail", summary: "没有程序在听 tcp 端口 443", hint: "看 Agent 日志", detail: "ss output" },
  { source: "agent", key: "agent:2:c1", group: "link", title: "防火墙放行", status: "skip", needsUpgrade: true, summary: "需要升级 Agent 到 2.2.226" },
  { source: "agent", key: "agent:1:c2", group: "target", title: "连得上 1.1.1.1:443", status: "pending", summary: "主机正在检查…" },
];

test("清单：总评、最可能的原因、分组标题和每行状态", () => {
  const report = buildDiagnosticsReport({ sessionId: "s", subject: { kind: "rule", id: 1, name: "r" }, startedAt: "", items });
  const html = renderToStaticMarkup(<LinkDiagnosticsChecklist report={report} expandedKeys={new Set()} onToggle={() => {}} />);
  assert.match(html, /发现 1 项失败，还有 1 项在等主机回报/);
  assert.match(html, /最可能的原因：/);
  assert.match(html, /端口 443\/tcp 在监听 —— 没有程序在听 tcp 端口 443/);
  for (const label of ["配置", "主机", "入口", "链路", "目标"]) assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.match(html, /data-status="fail"[^>]*>.*失败/);
  assert.match(html, /需要升级 Agent<\/span>/);
  assert.match(html, /data-status="pending"[^>]*>.*等待/);
  assert.doesNotMatch(html, /ss output/, "收起时不显示原始输出");
  const expanded = renderToStaticMarkup(<LinkDiagnosticsChecklist report={report} expandedKeys={new Set(["agent:1:c1"])} onToggle={() => {}} />);
  assert.match(expanded, /建议：看 Agent 日志/);
  assert.match(expanded, /<pre[^>]*>ss output<\/pre>/);
});

test("状态药丸：五种状态都有中文名", () => {
  for (const [status, label] of [["pass", "通过"], ["warn", "警告"], ["fail", "失败"], ["skip", "跳过"], ["pending", "等待"]] as const) {
    assert.match(renderToStaticMarkup(<DiagnosticStatusPill item={{ status }} />), new RegExp(label));
  }
});

test("规则、隧道、转发链三处诊断都带上一键诊断", () => {
  const pages = path.resolve(import.meta.dirname, "../pages");
  for (const [file, kind] of [["Rules.tsx", "rule"], ["Tunnels.tsx", "tunnel"], ["ForwardGroups.tsx", "forwardGroup"]]) {
    const source = fs.readFileSync(path.join(pages, file), "utf8");
    assert.match(source, new RegExp(`checklist=\\{\\{ kind: "${kind}"`), `${file} 传了 checklist`);
  }
});
