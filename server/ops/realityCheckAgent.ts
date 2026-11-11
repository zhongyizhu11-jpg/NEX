/*
  扩展模块 "realitycheck"（REALITY 伪装目标检查），Go 端是 agent/ext_realitycheck.go。
  指令：在等的检查 runs [{runId, targets}]；上报：各次检查的结果。逻辑都在 realityCheck.ts。
  有检查在等时让 Agent 每 5 秒来一次：表单那头的人正等着选目标。
*/
import { registerAgentExtModule } from "./agentExt";
import { ingestRealityCheckReport, pendingRealityChecksForHost, realityCheckDirectiveFor } from "./realityCheck";

registerAgentExtModule({
  name: "realitycheck",
  directive: (host) => realityCheckDirectiveFor(Number(host.id)),
  ingest: (host, report) => ingestRealityCheckReport(host, report),
  intervalSeconds: (host) => (pendingRealityChecksForHost(Number(host.id)).length > 0 ? 5 : undefined),
});
