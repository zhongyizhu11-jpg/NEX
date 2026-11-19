package main

import "strings"

/*
转发组 / 入口组的外部观察（2.2.264 起）。

面板让这台机器替它去探「别的成员对外的入口地址和访客实际连的端口」，以及一个参照目标（看这台机器自己的
网络有没有问题）。探测本身走的还是原来的转发组探测（forwardGroupProbes，TCP 连接 / UDP / ping），
probeType = "peer"。和国内检测、入口自检不同的只有两点，都在这个文件里：

  - 结果不在这台机器上做「持续多久才算」的判断（applyForwardGroupHealthDecision 不管它）：面板要把几个观察点
    的原始结果合起来判，哪个成员不可用由面板定。这里只把每一轮的通 / 不通如实报上去。
  - 探测间隔按组的故障 / 恢复时间收紧（和国内检测一样，见 capForwardGroupHealthProbeInterval），上报带上
    healthStatus（通 = healthy，不通 = unhealthy）—— 上报闸门把带 healthStatus 的当健康结果：一变就报，
    不变也每分钟报一次全量，面板据此知道这个观察点还在看着。
*/

func isForwardGroupPeerProbeType(probeType string) bool {
	return strings.EqualFold(strings.TrimSpace(probeType), "peer")
}

func applyForwardGroupPeerProbeReport(task tcpingTask, reachable bool, payload map[string]any) {
	if task.Kind != "forwardGroup" || !isForwardGroupPeerProbeType(task.ProbeType) {
		return
	}
	if reachable {
		payload["healthStatus"] = "healthy"
	} else {
		payload["healthStatus"] = "unhealthy"
	}
}
