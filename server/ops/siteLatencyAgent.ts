/*
  概览「出口质量」的 Agent 扩展模块，名字 "sitelatency"，Go 端是 agent/ext_sitelatency.go（Agent 2.2.237 起）。
  指令：站点、间隔、面板已有到哪（since）；上报：since 之后的样本。逻辑都在 siteLatency.ts。
*/
import { registerAgentExtModule } from "./agentExt";
import { ingestSiteLatencyReport, siteLatencyDirectiveFor } from "./siteLatency";

registerAgentExtModule({
  name: "sitelatency",
  directive: (host) => siteLatencyDirectiveFor(host),
  ingest: (host, report) => { ingestSiteLatencyReport(host, report); },
  // 不改扩展通道的间隔：样本两分钟一个，默认 60 秒一轮来取已经够了。
});
