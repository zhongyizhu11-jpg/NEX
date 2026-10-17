import assert from "node:assert/strict";
import test from "node:test";

import {
  __test,
  ingestHostLogsReport,
  isValidHostLogSource,
  pollHostLogs,
  resetHostLogsStateForTest,
} from "./hostLogsAgent";

const host = { id: 3, name: "港-1", agentVersion: "2.2.229" };

test("来源只认白名单", () => {
  for (const ok of ["agent", "runtime", "tunnel", "nginx", "kernel", "fxp:fxp-exit-7301-0-36397.log"]) assert.equal(isValidHostLogSource(ok), true, ok);
  for (const bad of ["", "/etc/passwd", "fxp:../x.log", "fxp:agent-go.log", "journal", "fxp:fxp-a.log;rm"]) assert.equal(isValidHostLogSource(bad), false, bad);
});

test("开窗口 → 下发 → Agent 回报 → 拿到新行；结果回来之前不重复下发", () => {
  resetHostLogsStateForTest();
  const first = pollHostLogs(3, "agent", 0, Date.now());
  assert.equal(first.waiting, true);
  assert.equal(first.lines.length, 0);

  const directive = __test.directiveFor(host) as any;
  assert.equal(directive.requests.length, 1);
  assert.equal(directive.requests[0].source, "agent");
  assert.equal(directive.requests[0].cursor, "");
  // 还在路上：下一轮不再发
  assert.equal(__test.directiveFor(host), undefined);

  ingestHostLogsReport(host, {
    sources: ["agent", "kernel", "fxp:fxp-exit-1.log", "../evil"],
    results: [{ id: directive.requests[0].id, source: "agent", cursor: "120", lines: ["a", "b"] }],
  });
  const second = pollHostLogs(3, "agent", 0);
  assert.deepEqual(second.lines.map((line) => line.text), ["a", "b"]);
  assert.equal(second.nextSeq, 2);
  assert.deepEqual(second.sources, ["agent", "kernel", "fxp:fxp-exit-1.log"]);

  const next = __test.directiveFor(host) as any;
  assert.equal(next.requests[0].cursor, "120");
  ingestHostLogsReport(host, { results: [{ id: next.requests[0].id, source: "agent", cursor: "150", lines: ["c"], truncated: true }] });
  const third = pollHostLogs(3, "agent", 2);
  assert.deepEqual(third.lines.map((line) => line.text), ["—— 这段时间日志太多，中间省略了一部分 ——", "c"]);
});

test("没人看了就不再下发；别的主机、对不上 id 的结果不收", () => {
  resetHostLogsStateForTest();
  const longAgo = Date.now() - 60_000;
  pollHostLogs(3, "kernel", 0, longAgo);
  assert.equal(__test.directiveFor(host), undefined);

  pollHostLogs(3, "kernel", 0);
  const directive = __test.directiveFor(host) as any;
  ingestHostLogsReport({ id: 4 }, { results: [{ id: directive.requests[0].id, source: "kernel", cursor: "x", lines: ["other host"] }] });
  ingestHostLogsReport(host, { results: [{ id: "wrong", source: "kernel", cursor: "x", lines: ["forged"] }] });
  assert.equal(pollHostLogs(3, "kernel", 0).lines.length, 0);
});
