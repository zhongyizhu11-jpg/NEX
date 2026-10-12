//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// 收包分摊（RPS / RFS）：VPS 的虚拟网卡通常只有一两个接收队列，收包的软中断全压在
// 一个核上，包量一大这个核先满，别的核闲着。RPS 让内核把收包处理按连接散到多个核，
// RFS 让每条连接的包落在处理它的那个核上。
//
// 只在多核、接收队列比核少的网卡上开；用户自己设过（rps_cpus 不是全 0）的不动。
// sysfs 里的值重启就没了，所以每次 Agent 启动都检查一遍。NEX_RPS=0 关掉。
const (
	rpsEnvName = "NEX_RPS"
	// rfsSockFlowEntries 是全局的连接表大小，内核文档建议 32768。
	rfsSockFlowEntries = 32768
)

type rpsPaths struct {
	netClass     string // /sys/class/net
	sockFlowPath string // /proc/sys/net/core/rps_sock_flow_entries
}

var defaultRPSPaths = rpsPaths{
	netClass:     "/sys/class/net",
	sockFlowPath: "/proc/sys/net/core/rps_sock_flow_entries",
}

func rpsEnabledByEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(rpsEnvName))) {
	case "0", "off", "false", "no", "disable", "disabled":
		return false
	}
	return true
}

// applyReceivePacketSteering 在启动时调用一次，失败只记日志。
func applyReceivePacketSteering() {
	if !rpsEnabledByEnv() {
		return
	}
	changed, err := applyRPSWith(defaultRPSPaths, runtime.NumCPU())
	if err != nil {
		logf("rps: %v", err)
	}
	if len(changed) > 0 {
		logf("rps: spread receive processing over %d CPUs on %s", runtime.NumCPU(), strings.Join(changed, ", "))
	}
}

// rpsCPUMask 是前 cpus 个 CPU 的 sysfs 掩码：十六进制，每 32 位用逗号隔开，高位在前。
func rpsCPUMask(cpus int) string {
	if cpus <= 0 {
		return "0"
	}
	words := (cpus + 31) / 32
	parts := make([]string, words)
	for i := 0; i < words; i++ {
		bits := cpus - i*32
		var word uint64
		if bits >= 32 {
			word = 0xffffffff
		} else {
			word = (uint64(1) << uint(bits)) - 1
		}
		parts[words-1-i] = fmt.Sprintf("%08x", word)
	}
	mask := strings.Join(parts, ",")
	// 最高一组去掉前导零，和内核自己打印的格式一致（写入时两种都认）。
	trimmed := strings.TrimLeft(mask, "0")
	if trimmed == "" || strings.HasPrefix(trimmed, ",") {
		return "0" + trimmed
	}
	return trimmed
}

// rpsMaskIsZero 判断 rps_cpus 里是不是全 0（没人设过）。
func rpsMaskIsZero(value string) bool {
	for _, r := range strings.TrimSpace(value) {
		if r != '0' && r != ',' {
			return false
		}
	}
	return true
}

// rpsEligibleInterface 只挑真实（含虚拟机的 virtio）网卡：有 device 链接，不是
// lo / docker / veth / bridge / WireGuard 这类软件接口。
func rpsEligibleInterface(netClass, name string) bool {
	if name == "lo" {
		return false
	}
	if _, err := os.Stat(filepath.Join(netClass, name, "device")); err != nil {
		return false
	}
	return true
}

func applyRPSWith(paths rpsPaths, cpus int) ([]string, error) {
	if cpus < 2 {
		return nil, nil
	}
	entries, err := os.ReadDir(paths.netClass)
	if err != nil {
		return nil, fmt.Errorf("list interfaces: %w", err)
	}
	mask := rpsCPUMask(cpus)
	var changed []string
	var firstErr error
	for _, entry := range entries {
		name := entry.Name()
		if !rpsEligibleInterface(paths.netClass, name) {
			continue
		}
		queues, _ := filepath.Glob(filepath.Join(paths.netClass, name, "queues", "rx-*"))
		if len(queues) == 0 || len(queues) >= cpus {
			// 硬件队列已经够多，网卡自己会分（RSS），不用 RPS。
			continue
		}
		flowPerQueue := rfsSockFlowEntries / len(queues)
		touched := false
		for _, queue := range queues {
			cpusPath := filepath.Join(queue, "rps_cpus")
			current, err := os.ReadFile(cpusPath)
			if err != nil || !rpsMaskIsZero(string(current)) {
				continue
			}
			if err := os.WriteFile(cpusPath, []byte(mask), 0o644); err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("write %s: %w", cpusPath, err)
				}
				continue
			}
			touched = true
			flowPath := filepath.Join(queue, "rps_flow_cnt")
			if value, err := os.ReadFile(flowPath); err == nil && strings.TrimSpace(string(value)) == "0" {
				_ = os.WriteFile(flowPath, []byte(strconv.Itoa(flowPerQueue)), 0o644)
			}
		}
		if touched {
			changed = append(changed, name)
		}
	}
	if len(changed) > 0 {
		if value, err := os.ReadFile(paths.sockFlowPath); err == nil && strings.TrimSpace(string(value)) == "0" {
			_ = os.WriteFile(paths.sockFlowPath, []byte(strconv.Itoa(rfsSockFlowEntries)), 0o644)
		}
	}
	return changed, firstErr
}
