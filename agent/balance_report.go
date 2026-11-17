package main

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

/*
GOST 链路负载均衡的真实状态报给面板（2.2.262 起，面板 2.3.539；NEX 隧道由入口的 FXP 报，格式一样）。

GOST 链路有几台出口时，入口机上这条规则的端口后面是本机的故障转移代理（和线路组同一个 failoverProxy），它在
「每台出口一个本机 gost 端口」之间挑：新连接按分配方式分；连上了、出口还没回任何东西就被关掉（出口连不上目标）
当场换下一台重发；面板从出口机的探测知道哪台到目标不通（提示 Down），不改 gost 配置、不断正在走的连接。

这里每秒看一遍这些代理：每台出口在用 / 备用 / 连不上（target = 到目标不通，exit = 入口到出口不通）、现在挂着几条
连接、延迟（入口到出口的探测 + 面板给的出口到目标的延迟）。有变化 1 秒内报，没变化 10 秒报一次。
*/

const (
	agentBalanceReportPath     = "/api/agent/fxp-balance"
	agentBalanceReportInterval = 10 * time.Second
	agentBalanceMaxEvents      = 10
)

type agentBalanceExit struct {
	HostID   int     `json:"hostId,omitempty"`
	Host     string  `json:"host"`
	Port     int     `json:"port"`
	State    string  `json:"state"`
	Reason   string  `json:"reason,omitempty"`
	Share    float64 `json:"share"`
	Picks    int     `json:"picks"`
	MedianMs float64 `json:"medianMs,omitempty"`
	JitterMs float64 `json:"jitterMs,omitempty"`
	LossPct  float64 `json:"lossPct,omitempty"`
	Samples  int     `json:"samples,omitempty"`
}

type agentBalanceEvent struct {
	At     int64  `json:"at"`
	HostID int    `json:"hostId,omitempty"`
	Host   string `json:"host"`
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason,omitempty"`
}

type agentBalanceRule struct {
	TunnelID    int                 `json:"tunnelId"`
	RuleID      int                 `json:"ruleId"`
	Strategy    string              `json:"strategy"`
	TargetAware bool                `json:"targetAware"`
	Exits       []agentBalanceExit  `json:"exits"`
	Events      []agentBalanceEvent `json:"events,omitempty"`
}

// balanceSnapshot：这个代理此刻每台出口的状态。不是负载均衡链路的代理返回 ok=false。
func (p *failoverProxy) balanceSnapshot() (tunnelID int, strategy string, exits []agentBalanceExit, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	report := p.spec.BalanceReport
	if report == nil || len(report.HostIDs) != len(p.spec.Targets) || len(p.spec.Targets) < 2 {
		return 0, "", nil, false
	}
	exits = make([]agentBalanceExit, len(p.spec.Targets))
	total := 0
	for i, target := range p.spec.Targets {
		host, port := target.probeEndpoint()
		item := agentBalanceExit{HostID: report.HostIDs[i], Host: host, Port: port, State: "standby", Share: -1}
		healthy := p.healthyLocked(i)
		switch {
		case i < len(p.relayDown) && p.relayDown[i]:
			item.State, item.Reason = "down", "target"
		case !healthy:
			item.State, item.Reason = "down", "exit"
		}
		if i < len(p.conns) {
			item.Picks = len(p.conns[i])
			total += item.Picks
		}
		summary := p.statsLocked(i).summary()
		if latency := p.latencyMsLocked(i); latency > 0 {
			item.MedianMs = float64(latency + target.ExtraLatencyMs)
		} else if summary.hasLatency {
			item.MedianMs = float64(summary.latencyMs + target.ExtraLatencyMs)
		}
		item.JitterMs = float64(int64(summary.jitterMs*10+0.5)) / 10
		item.LossPct = float64(int64(summary.lossPct*10+0.5)) / 10
		item.Samples = summary.samples
		exits[i] = item
	}
	if p.spec.Strategy == "fallback" {
		if p.activeIndex >= 0 && p.activeIndex < len(exits) && exits[p.activeIndex].State != "down" {
			exits[p.activeIndex].State = "active"
		}
	} else {
		for i := range exits {
			if exits[i].State == "down" {
				continue
			}
			// 有连接挂着的是在用；一条连接都没有时，能用的都算在用（新连接会分给它们）
			if exits[i].Picks > 0 || total == 0 {
				exits[i].State = "active"
			}
		}
	}
	if total > 0 {
		for i := range exits {
			exits[i].Share = float64(int64(float64(exits[i].Picks)*1000/float64(total)+0.5)) / 1000
		}
	}
	return report.TunnelID, p.spec.Strategy, exits, true
}

type agentBalanceRuleState struct {
	lastStates map[int]string
	events     []agentBalanceEvent
}

var agentBalanceReporter = struct {
	mu      sync.Mutex
	rules   map[string]*agentBalanceRuleState
	dirty   bool
	dirtyAt time.Time
	last    time.Time
}{rules: map[string]*agentBalanceRuleState{}}

// collectAgentBalanceReports 每秒调一次；到点（有变化 1 秒后、或满 10 秒）返回要报的内容。
func collectAgentBalanceReports(now time.Time, force bool) ([]agentBalanceRule, bool) {
	failoverMu.Lock()
	proxies := make([]*failoverProxy, 0, len(failoverProxies))
	for _, proxy := range failoverProxies {
		proxies = append(proxies, proxy)
	}
	failoverMu.Unlock()
	rules := []agentBalanceRule{}
	for _, proxy := range proxies {
		tunnelID, strategy, exits, ok := proxy.balanceSnapshot()
		if !ok {
			continue
		}
		rules = append(rules, agentBalanceRule{TunnelID: tunnelID, RuleID: proxy.ruleID, Strategy: strategy, TargetAware: true, Exits: exits})
	}

	agentBalanceReporter.mu.Lock()
	defer agentBalanceReporter.mu.Unlock()
	live := map[string]bool{}
	for i := range rules {
		key := fmt.Sprintf("%d:%d", rules[i].TunnelID, rules[i].RuleID)
		live[key] = true
		state := agentBalanceReporter.rules[key]
		if state == nil {
			state = &agentBalanceRuleState{lastStates: map[int]string{}}
			agentBalanceReporter.rules[key] = state
			agentBalanceReporter.dirty = true
		}
		for index, exit := range rules[i].Exits {
			previous, seen := state.lastStates[index]
			if seen && previous != exit.State {
				state.events = append(state.events, agentBalanceEvent{At: now.UnixMilli(), HostID: exit.HostID, Host: exit.Host, From: previous, To: exit.State, Reason: exit.Reason})
				if len(state.events) > agentBalanceMaxEvents {
					state.events = state.events[len(state.events)-agentBalanceMaxEvents:]
				}
				agentBalanceReporter.dirty = true
			}
			state.lastStates[index] = exit.State
		}
		rules[i].Events = append([]agentBalanceEvent(nil), state.events...)
	}
	for key := range agentBalanceReporter.rules {
		if !live[key] {
			delete(agentBalanceReporter.rules, key)
		}
	}
	if len(rules) == 0 {
		return nil, false
	}
	if agentBalanceReporter.dirty && agentBalanceReporter.dirtyAt.IsZero() {
		agentBalanceReporter.dirtyAt = now
	}
	due := force || now.Sub(agentBalanceReporter.last) >= agentBalanceReportInterval ||
		(!agentBalanceReporter.dirtyAt.IsZero() && now.Sub(agentBalanceReporter.dirtyAt) >= time.Second)
	if !due {
		return nil, false
	}
	agentBalanceReporter.dirty = false
	agentBalanceReporter.dirtyAt = time.Time{}
	agentBalanceReporter.last = now
	sort.Slice(rules, func(i, j int) bool {
		if rules[i].TunnelID != rules[j].TunnelID {
			return rules[i].TunnelID < rules[j].TunnelID
		}
		return rules[i].RuleID < rules[j].RuleID
	})
	return rules, true
}

func balanceReportLoop(cfg Config) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for now := range ticker.C {
		rules, due := collectAgentBalanceReports(now, false)
		if !due {
			continue
		}
		payload := map[string]any{"source": "agent", "rules": rules, "reportedAt": now.UnixMilli()}
		if err := post(cfg, agentBalanceReportPath, payload, &map[string]any{}); err != nil {
			logf("balance report failed: %v", err)
		}
	}
}
