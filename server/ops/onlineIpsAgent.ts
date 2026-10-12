/*
  在线 IP（#6）的 Agent 扩展模块，名字 "online"，Go 端是 agent/ext_online.go。
  指令：这台主机上要盯的端口（端口 → 规则 / 入站，是不是 DNAT）；上报：每个端口上的远端 IP。
  逻辑都在 onlineIps.ts。
*/
import { registerAgentExtModule } from "./agentExt";
import { ingestOnlineReport, onlineDirectiveFor, onlineIntervalSeconds } from "./onlineIps";

registerAgentExtModule({
  name: "online",
  directive: (host) => onlineDirectiveFor(host),
  ingest: (host, report) => ingestOnlineReport(host, report),
  intervalSeconds: () => onlineIntervalSeconds(),
});
