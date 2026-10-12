/*
  安全巡检（#3）的 Agent 扩展模块，名字 "security"，Go 端是 agent/ext_security.go。
  指令：巡检间隔、面板管的端口（不算新端口）、待执行的处置动作、重建基线令牌；
  上报：巡检结果、发现、动作结果。逻辑都在 hostSecurity.ts。
*/
import { registerAgentExtModule } from "./agentExt";
import { ingestSecurityReport, securityDirectiveFor } from "./hostSecurity";

registerAgentExtModule({
  name: "security",
  directive: (host) => securityDirectiveFor(host),
  ingest: (host, report) => ingestSecurityReport(host, report),
});
