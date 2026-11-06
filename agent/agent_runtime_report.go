package main

import (
	"runtime"
	"sync"

	"golang.org/x/sys/cpu"
)

/*
心跳里的 agentRuntime：Agent 进程自己的运行状况，面板只存内存、主机详情「Agent 运行状态」里显示。

	rssBytes            常驻内存（/proc/self/statm；读不到不报）
	heapBytes           Go 堆上正在用的字节
	goroutines          协程数
	gcCount             累计 GC 轮数
	gcPauseMaxUs        上次心跳以来最长的一次 GC 停顿（微秒；没跑过 GC 为 0）
	gcPauseTotalMs      累计 GC 停顿
	udpSessions         进程内 UDP 中继（线路组、协议守护）的会话：active / cap / evicted / rejected，
	                    见 udp_session_budget.go
	cpuAes              这台机器的 CPU 有没有 AES + 无进位乘法指令。有就是 AES-256-GCM 快，FXP 隧道
	                    协商时本机偏好 AES；没有时 FXP 实测出 ChaCha20 更快，会报 ChaCha20 优先
	                    （forwardx-fxp/aead.go：两端各报偏好，握手里协商，老版本只会 AES-GCM）
	pprof               性能剖析开着时的监听地址和自动关闭时间（ext_pprof.go），关着不报

字段都是新加的、可选的：老面板不认识就忽略，新面板收到老 Agent（没有这个字段）就不显示这一节。
*/

var agentRuntimeGCMu sync.Mutex
var agentRuntimeLastNumGC uint32

func addAgentRuntimeReport(payload map[string]any) {
	payload["agentRuntime"] = agentRuntimeSnapshot()
}

func agentRuntimeSnapshot() map[string]any {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	report := map[string]any{
		"heapBytes":      ms.HeapAlloc,
		"goroutines":     runtime.NumGoroutine(),
		"gcCount":        ms.NumGC,
		"gcPauseMaxUs":   agentRuntimeGCPauseMaxSinceLast(&ms) / 1000,
		"gcPauseTotalMs": ms.PauseTotalNs / 1_000_000,
		"udpSessions":    udpRelaySessionSnapshot(),
		"cpuAes":         cpuHasAESGCM(),
	}
	if rss := processRSSBytes(); rss > 0 {
		report["rssBytes"] = rss
	}
	if status := agentPprofStatus(); status.Running {
		report["pprof"] = status
	}
	return report
}

// agentRuntimeGCPauseMaxSinceLast 是上次调用以来那几轮 GC 里最长的停顿（纳秒）。MemStats 只留
// 最近 256 轮，两次心跳之间超过 256 轮时只看得到最近的 256 轮。
func agentRuntimeGCPauseMaxSinceLast(ms *runtime.MemStats) uint64 {
	agentRuntimeGCMu.Lock()
	defer agentRuntimeGCMu.Unlock()
	last := agentRuntimeLastNumGC
	agentRuntimeLastNumGC = ms.NumGC
	newRounds := ms.NumGC - last
	if newRounds == 0 || ms.NumGC == 0 {
		return 0
	}
	if newRounds > uint32(len(ms.PauseNs)) {
		newRounds = uint32(len(ms.PauseNs))
	}
	var longest uint64
	for i := uint32(0); i < newRounds; i++ {
		// 第 n 轮（从 1 数）的停顿在 PauseNs[(n+255)%256]。
		idx := (ms.NumGC - i + uint32(len(ms.PauseNs)) - 1) % uint32(len(ms.PauseNs))
		if pause := ms.PauseNs[idx]; pause > longest {
			longest = pause
		}
	}
	return longest
}

// cpuHasAESGCM：CPU 有 AES 轮函数和无进位乘法（GHASH）指令，Go 的 AES-GCM 走硬件路径。
func cpuHasAESGCM() bool {
	switch runtime.GOARCH {
	case "amd64", "386":
		return cpu.X86.HasAES && cpu.X86.HasPCLMULQDQ
	case "arm64":
		return cpu.ARM64.HasAES && cpu.ARM64.HasPMULL
	case "s390x":
		return cpu.S390X.HasAES && cpu.S390X.HasAESGCM
	case "ppc64", "ppc64le":
		// POWER8 起都有 vcipher / vpmsumd，Go 的 AES-GCM 在这两个架构上一直走汇编。
		return true
	}
	return false
}
