package main

// Agent 扩展通道（2.2.216 起），面板那头见 server/ops/agentExt.ts。
//
// 第五套主题那批功能（地区规则、IP 封禁、在线 IP、安全巡检、经其他主机连面板、全部重启、
// 导入现有配置）不改心跳，而是各自注册成一个扩展模块：
//
//   每隔 interval 秒 POST /api/agent/ext，body = {"modules": {名字: Report() 的结果}}；
//   回复 {"interval": 秒, "modules": {名字: 指令}}，逐个交给模块的 Apply。
//
// 每个功能一份 ext_<功能>.go，在 init() 里 registerExtModule。模块之间互不影响：
// 一个模块 panic 只记日志，这一轮其他模块照常。

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

type extModule interface {
	Name() string
	// Report 返回这一轮要上报的内容；nil 表示这轮没什么可报。
	Report(cfg Config) any
	// Apply 收面板给这台主机的指令（原样的 JSON）。没有指令的一轮不会调用。
	Apply(cfg Config, directive json.RawMessage)
}

const (
	extDefaultInterval = 60 * time.Second
	extMinInterval     = 5 * time.Second
	extErrorBackoff    = 2 * time.Minute
	extNotFoundBackoff = 10 * time.Minute
)

var (
	extModulesMu sync.RWMutex
	extModules   = map[string]extModule{}
	extWakeCh    = make(chan struct{}, 1)
)

func registerExtModule(m extModule) {
	extModulesMu.Lock()
	defer extModulesMu.Unlock()
	extModules[m.Name()] = m
}

func extModuleList() []extModule {
	extModulesMu.RLock()
	defer extModulesMu.RUnlock()
	names := make([]string, 0, len(extModules))
	for name := range extModules {
		names = append(names, name)
	}
	sort.Strings(names)
	list := make([]extModule, 0, len(names))
	for _, name := range names {
		list = append(list, extModules[name])
	}
	return list
}

// wakeAgentExt 让扩展通道提前跑一轮（面板通过 SSE 发 agent-ext 事件时调用）。
func wakeAgentExt() {
	select {
	case extWakeCh <- struct{}{}:
	default:
	}
}

type extResponse struct {
	Interval int                        `json:"interval"`
	Modules  map[string]json.RawMessage `json:"modules"`
}

func extSafeReport(cfg Config, m extModule) (report any) {
	defer func() {
		if r := recover(); r != nil {
			logf("ext module %s report panic: %v", m.Name(), r)
			report = nil
		}
	}()
	return m.Report(cfg)
}

func extSafeApply(cfg Config, m extModule, directive json.RawMessage) {
	defer func() {
		if r := recover(); r != nil {
			logf("ext module %s apply panic: %v", m.Name(), r)
		}
	}()
	m.Apply(cfg, directive)
}

func runAgentExtRound(cfg Config) (time.Duration, error) {
	modules := extModuleList()
	if len(modules) == 0 {
		return extDefaultInterval, nil
	}
	reports := map[string]any{}
	for _, m := range modules {
		if report := extSafeReport(cfg, m); report != nil {
			reports[m.Name()] = report
		}
	}
	var resp extResponse
	if err := postWithClient(agentSyncHTTPClient, cfg, "/api/agent/ext", map[string]any{"modules": reports}, &resp); err != nil {
		return extErrorBackoff, err
	}
	for _, m := range modules {
		if directive, ok := resp.Modules[m.Name()]; ok && len(directive) > 0 && string(directive) != "null" {
			extSafeApply(cfg, m, directive)
		}
	}
	interval := time.Duration(resp.Interval) * time.Second
	if interval <= 0 {
		interval = extDefaultInterval
	}
	if interval < extMinInterval {
		interval = extMinInterval
	}
	return interval, nil
}

func agentExtLoop(cfg Config) {
	// 和心跳错开一点，开机那几秒先让注册、心跳、事件流跑起来。
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
		case <-extWakeCh:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		next, err := runAgentExtRound(cfg)
		if err != nil {
			if extErrorLooksLikeMissingRoute(err) {
				next = extNotFoundBackoff
			}
			if shouldLogAgentReport("ext-round-error", agentReportLogInterval) {
				logf("ext round failed (next in %s): %v", next, err)
			}
		}
		timer.Reset(next)
	}
}

func extErrorLooksLikeMissingRoute(err error) bool {
	if err == nil {
		return false
	}
	var statusErr interface{ StatusCode() int }
	if errors.As(err, &statusErr) && statusErr.StatusCode() == 404 {
		return true
	}
	msg := fmt.Sprint(err)
	return len(msg) > 0 && (containsFold(msg, "404") || containsFold(msg, "not found"))
}

func containsFold(s, sub string) bool {
	if len(sub) > len(s) {
		return false
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		match := true
		for j := 0; j < len(sub); j++ {
			a, b := s[i+j], sub[j]
			if 'A' <= a && a <= 'Z' {
				a += 'a' - 'A'
			}
			if 'A' <= b && b <= 'Z' {
				b += 'a' - 'A'
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
