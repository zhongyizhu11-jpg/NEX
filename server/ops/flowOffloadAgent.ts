/*
  主机「内核快速转发」的 Agent 扩展模块 "offload"（Go 端 agent/ext_offload.go + flowtable_offload.go）。

  指令：{ enabled } —— 主机设置里的开关（hosts.flowOffload，只有管理员能改，默认关）。
  上报：Agent 那头的实际状态（是否生效、没生效的原因、内核版本、快速路径上的连接数……），
  只留在内存里给主机设置页显示，面板重启后等下一轮上报（最多一分钟）。
*/
import { registerAgentExtModule } from "./agentExt";
import { flowOffloadDirectiveFor, ingestFlowOffloadReport } from "./flowOffloadStatus";

registerAgentExtModule({
  name: "offload",
  directive(host) {
    return flowOffloadDirectiveFor(host as any);
  },
  ingest(host, report) {
    ingestFlowOffloadReport(host, report);
  },
});
