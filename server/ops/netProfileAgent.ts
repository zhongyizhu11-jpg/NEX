/*
  主机网络画像的 Agent 扩展模块，名字 "netprofile"，Go 端是 agent/ext_netprofile.go（Agent 2.2.226 起）。
  指令：检测间隔、面板已收到的检测时间、手动「重新检测」的 runId、要查的 DNSBL / MX / 出口探测地址；
  上报：正在测（running）或一次完整结果（result）。逻辑都在 netProfile.ts。
*/
import { registerAgentExtModule } from "./agentExt";
import { ingestNetProfileReport, netProfileDirectiveFor, netProfileIntervalFor } from "./netProfile";

registerAgentExtModule({
  name: "netprofile",
  directive: (host) => netProfileDirectiveFor(host),
  ingest: (host, report) => ingestNetProfileReport(host, report),
  intervalSeconds: (host) => netProfileIntervalFor(host),
});
