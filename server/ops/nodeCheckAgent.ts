/*
  扩展模块 "nodecheck"（网速测试 / 经节点的出口检测，Agent 2.2.241 起），Go 端是 agent/ext_nodecheck.go。
  指令：在等的检查 runs [{runId, kind, family, via?, targets?}]；上报：各次检查的进度和结果。逻辑都在 nodeCheck.ts。
  有检查在等时让 Agent 5 秒来一次（测速时 Agent 自己每秒多来一轮送曲线）。
*/
import { registerAgentExtModule } from "./agentExt";
import { hostSupportsNodeCheck, ingestNodeCheckReport, nodeCheckDirectiveFor, pendingNodeCheckRunsForHost } from "./nodeCheck";

registerAgentExtModule({
  name: "nodecheck",
  directive: (host) => (hostSupportsNodeCheck(host) ? nodeCheckDirectiveFor(Number(host.id)) : undefined),
  ingest: (host, report) => ingestNodeCheckReport(host, report),
  intervalSeconds: (host) => (pendingNodeCheckRunsForHost(Number(host.id)).length > 0 ? 5 : undefined),
});
