/*
  Agent 性能剖析的扩展模块，名字 "pprof"，Go 端是 agent/ext_pprof.go。
  指令：{enabled, until}（Unix 秒）；上报：{running, addr, until, error}。逻辑在 agentRuntime.ts。
*/
import { registerAgentExtModule } from "./agentExt";
import { agentPprofDirectiveFor, agentPprofIntervalFor, ingestAgentPprofReport } from "./agentRuntime";

registerAgentExtModule({
  name: "pprof",
  directive: (host) => agentPprofDirectiveFor(host),
  ingest: (host, report) => ingestAgentPprofReport(host, report),
  intervalSeconds: (host) => agentPprofIntervalFor(host),
});
