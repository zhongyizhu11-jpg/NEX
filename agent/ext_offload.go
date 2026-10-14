package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 扩展模块 offload：主机「内核快速转发」开关（flowtable_offload.go）。面板那头见
// server/ops/flowOffloadAgent.ts。指令 {"enabled": bool}；上报当前状态。
//
// 开关落一份到状态目录：机器重启后 nft 表没了，Agent 一起来就按上次的开关重建，不用等面板。
// 规则端口、网卡会变，开着时每 flowOffloadSyncInterval 重新同步一次（没变化不动 nft）。

const flowOffloadSyncInterval = 15 * time.Second

var flowOffloadStateFile = filepath.Join(agentStateDir, "flow_offload.enabled")

type flowOffloadDirective struct {
	Enabled bool `json:"enabled"`
}

type flowOffloadModule struct {
	manager *flowOffloadManager
	wake    chan struct{}
	once    sync.Once
}

var (
	flowOffloadSharedOnce    sync.Once
	flowOffloadSharedManager *flowOffloadManager
)

// sharedFlowOffloadManager 是进程里唯一的快速转发管理器（扩展模块和流量采集共用）。
func sharedFlowOffloadManager() *flowOffloadManager {
	flowOffloadSharedOnce.Do(func() {
		flowOffloadSharedManager = newFlowOffloadManager(
			systemFlowOffload{runner: firewallExecRunner{}},
			newConntrackAccountant(newSystemConntrackSource()),
		)
	})
	return flowOffloadSharedManager
}

var sharedFlowOffloadModule = &flowOffloadModule{wake: make(chan struct{}, 1)}

func init() {
	registerExtModule(sharedFlowOffloadModule)
}

func (m *flowOffloadModule) Name() string { return "offload" }

func (m *flowOffloadModule) Report(cfg Config) any {
	return sharedFlowOffloadManager().status()
}

func (m *flowOffloadModule) Apply(cfg Config, raw json.RawMessage) {
	var directive flowOffloadDirective
	if err := json.Unmarshal(raw, &directive); err != nil {
		return
	}
	manager := sharedFlowOffloadManager()
	if manager.isEnabled() == directive.Enabled && flowOffloadPersistedEnabled() == directive.Enabled {
		return
	}
	manager.setEnabled(directive.Enabled)
	persistFlowOffloadEnabled(directive.Enabled)
	logf("flow offload switched enabled=%v", directive.Enabled)
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func flowOffloadPersistedEnabled() bool {
	raw, err := os.ReadFile(flowOffloadStateFile)
	return err == nil && strings.TrimSpace(string(raw)) == "1"
}

func persistFlowOffloadEnabled(enabled bool) {
	if !enabled {
		_ = os.Remove(flowOffloadStateFile)
		return
	}
	_ = os.MkdirAll(filepath.Dir(flowOffloadStateFile), 0755)
	_ = os.WriteFile(flowOffloadStateFile, []byte("1\n"), 0644)
}

// startFlowOffloadLoop 在 Agent 启动时调用：接上上次留下的表、按持久化的开关同步，之后定时同步。
func startFlowOffloadLoop() {
	sharedFlowOffloadModule.once.Do(func() {
		manager := sharedFlowOffloadManager()
		manager.setEnabled(flowOffloadPersistedEnabled())
		manager.adoptExisting()
		go sharedFlowOffloadModule.loop(manager)
	})
}

func (m *flowOffloadModule) loop(manager *flowOffloadManager) {
	ticker := time.NewTicker(flowOffloadSyncInterval)
	defer ticker.Stop()
	lastErr := ""
	for {
		if manager.isEnabled() || manager.accountingActive() {
			manager.sync(readLocalRuleStates(), wireGuardPassthroughExitPorts())
			if status := manager.status(); status.Error != lastErr {
				if status.Error != "" {
					logf("flow offload: %s", status.Error)
				} else if status.Active {
					logf("flow offload active devices=%s tcpPorts=%d udpPorts=%d", strings.Join(status.Devices, ","), status.TCPPorts, status.UDPPorts)
				}
				lastErr = status.Error
			}
		}
		select {
		case <-ticker.C:
		case <-m.wake:
		}
	}
}
