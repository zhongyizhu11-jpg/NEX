package main

// Distribution 是这个 Agent 二进制的发行来源。NEX 发的 Agent 固定是 "nex"；面板据此把原版
// ForwardX（poouo/Forwardx）发的 Agent 和 NEX 的 Agent 分开 —— 两边的版本号是同一条线往上数的，
// 只看版本号分不出来（见 shared/agentDistribution.ts）。
//
// 用 var 而不是 const：构建时可以用 -ldflags "-X main.Distribution=..." 覆盖（二开发行版改成自己的名字）。
var Distribution = "nex"

// addAgentDistributionReport 往心跳 / 注册 / 事件流的请求体里加发行来源。每次都带：面板以最新一次为准，
// 旧二进制被换掉之后下一次心跳就能看出来。
func addAgentDistributionReport(payload map[string]any) {
	payload["agentDistribution"] = Distribution
}
