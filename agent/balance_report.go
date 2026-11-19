package main

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

/*
GOST 链路负载均衡的真实状态报给面板（2.2.262 起有这份上报，2.2.264 起面板才真的把出口组交给入口机的代理，
之前这里一直没东西可报；NEX 隧道由入口的 FXP 报，格式一样）。

出口组怎么挑、健康怎么判见 failover_exit_group.go。这里每秒看一遍这些代理，每台出口：
  - state / reason：在用 / 备用 / 连不上（exit = 入口探不通出口机，target = 出口到目标走不通：面板提示的，
    或者真实连接被关以后经出口复核确认的）；
  - picks：代理起来以后累计分给它多少条新连接 / 新 UDP 会话（2.2.263 及以前报的是「此刻挂着几条连接」）；
  - share：最近一分钟的新连接里分给它的比例（这一分钟没有新连接是 -1）；
  - 延迟：入口到出口的探测 + 面板给的出口到目标的延迟。
有变化 1 秒内报，没变化 10 秒报一次。
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

// balanceSnapshot：这个代理此刻每台出口的状态（picks 是累计数，share 由上报那边按最近一分钟算）。
// 不是出口组的代理返回 ok=false。
func (p *failoverProxy) balanceSnapshot() (tunnelID int, strategy string, exits []agentBalanceExit, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	report := p.spec.BalanceReport
	if report == nil || len(report.HostIDs) != len(p.spec.Targets) || len(p.spec.Targets) < 2 {
		return 0, "", nil, false
	}
	p.ensureHealthStateLocked()
	now := time.Now()
	exits = make([]agentBalanceExit, len(p.spec.Targets))
	for i, target := range p.spec.Targets {
		host, port := target.probeEndpoint()
		item := agentBalanceExit{HostID: report.HostIDs[i], Host: host, Port: port, State: "standby", Share: -1}
		switch {
		case p.relayDown[i] || (p.exitThroughFailed[i] && !p.targetHealth[i]):
			item.State, item.Reason = "down", "target"
		case !p.healthyLocked(i):
			item.State, item.Reason = "down", "exit"
		}
		item.Picks = int(p.pickCounts[i])
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
	// 在用的是谁：手动指定的那台能用时只有它；主备是正在走的那条；别的分法能用的都在轮转里。
	pinned := p.pinnedIndexAt(now)
	switch {
	case pinned >= 0 && exits[pinned].State != "down":
		exits[pinned].State = "active"
	case p.spec.Strategy == "fallback":
		if p.activeIndex >= 0 && p.activeIndex < len(exits) && exits[p.activeIndex].State != "down" {
			exits[p.activeIndex].State = "active"
		}
	default:
		for i := range exits {
			if exits[i].State != "down" {
				exits[i].State = "active"
			}
		}
	}
	return report.TunnelID, p.spec.Strategy, exits, true
}

// 「最近」是多久：share 按这段时间里新分出去的连接算。
const agentBalanceShareWindow = time.Minute

type agentBalancePickSample struct {
	at    time.Time
	picks []int
}

// recentShares 记下这一刻的累计数，返回最近一分钟里每台分到的比例（没有新连接、或者出口数变了返回 nil）。
func (state *agentBalanceRuleState) recentShares(now time.Time, picks []int) []float64 {
	/*
		从头算的三种情况：这条规则第一次见、出口数变了、累计数变小了（代理重建，计数从 0 起）。从头算时拿全 0 当
		基准 —— 代理刚起来，到现在为止分出去的都算「最近」。不这样的话，重建前的累计数会被当成基准，重建后
		头一分钟的比例全是错的（端到端测试里见过：三台各分了三成，报的却是 100% / 0 / 0）。
	*/
	restart := len(state.history) == 0 || len(state.history[0].picks) != len(picks)
	if !restart {
		last := state.history[len(state.history)-1].picks
		for i := range picks {
			if picks[i] < last[i] {
				restart = true
				break
			}
		}
	}
	if restart {
		state.history = []agentBalancePickSample{{at: now, picks: make([]int, len(picks))}}
	}
	state.history = append(state.history, agentBalancePickSample{at: now, picks: append([]int(nil), picks...)})
	// 留一份刚好够老的当基准，更老的丢掉。
	for len(state.history) > 1 && now.Sub(state.history[1].at) >= agentBalanceShareWindow {
		state.history = state.history[1:]
	}
	base := state.history[0].picks
	total := 0
	deltas := make([]int, len(picks))
	for i := range picks {
		if delta := picks[i] - base[i]; delta > 0 {
			deltas[i] = delta
			total += delta
		}
	}
	if total <= 0 {
		return nil
	}
	shares := make([]float64, len(picks))
	for i := range deltas {
		shares[i] = float64(int64(float64(deltas[i])*1000/float64(total)+0.5)) / 1000
	}
	return shares
}

type agentBalanceRuleState struct {
	lastStates map[int]string
	events     []agentBalanceEvent
	// 每秒记一次累计分配数，算「最近一分钟的比例」用。
	history []agentBalancePickSample
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
		picks := make([]int, len(rules[i].Exits))
		for index := range rules[i].Exits {
			picks[index] = rules[i].Exits[index].Picks
		}
		if shares := state.recentShares(now, picks); shares != nil {
			for index := range rules[i].Exits {
				rules[i].Exits[index].Share = shares[index]
			}
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
