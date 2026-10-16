/*
  扩展模块 "unlock"（流媒体 / AI 解锁检测，Agent 2.2.226 起），Go 端是 agent/ext_unlock.go。
  指令：在等的检测 runs [{runId, family}]；上报：各次检测的结果。逻辑都在 unlock.ts。
  有检测在等时让 Agent 每 5 秒来一次，结果十几秒内回到界面上。
*/
import { registerAgentExtModule } from "./agentExt";
import { hostSupportsUnlock, ingestUnlockReport, pendingUnlockRunsForHost, unlockDirectiveFor } from "./unlock";

registerAgentExtModule({
  name: "unlock",
  directive: (host) => (hostSupportsUnlock(host) ? unlockDirectiveFor(Number(host.id)) : undefined),
  ingest: (host, report) => ingestUnlockReport(host, report),
  intervalSeconds: (host) => (pendingUnlockRunsForHost(Number(host.id)).length > 0 ? 5 : undefined),
});
