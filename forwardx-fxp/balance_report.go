package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

/*
负载均衡的真实状态报给面板（2.2.145 起，面板 2.3.539）。

以前面板不知道入口的 FXP 实际把连接分给了谁，只能让每台出口的 Agent 另外测一遍目标，再按一套自己写的规则去
「猜」FXP 会怎么挑。两边判断的门槛、时机不一样，界面上就常常和实际不符：出口明明在用却写「不可达」、流量早就
切走了规则卡还写「经 主出口 · 超时」、「怎么走」说错（用户 2026-11「全部排查下……不要再这么多问题了」）。

现在由做决定的这一方直接报：每条有几台出口的规则，每台出口

  state     active（这段时间新连接分给了它，没有新连接时是「现在会挑它」）/ standby（能用、这会儿没分给它）/
            down（连不上目标，或出口本身连不上）/ unstable（抖动、丢包超了门槛）
  share     这段时间新连接里分给它的比例（没有新连接时 -1）
  medianMs / jitterMs / lossPct  入口经这台出口连目标的延迟、抖动、丢包（出口回报的结果和主动探测）

外加最近 10 次状态变化（几点、哪台、从什么变成什么）。

节奏：每秒在本机比一次各规则的状态，有变化 1 秒内报（同一面板合成一次请求）；没变化 10 秒报一次，面板据此
知道这份数据还新鲜。只报入口：中转、出口不挑出口。
*/

const (
	balanceReportPath      = "/api/agent/fxp-balance"
	balanceReportPoll      = time.Second
	balanceReportInterval  = 10 * time.Second
	balanceReportMaxEvents = 10
	balanceReportMaxRules  = 2000
)

type balanceExitReport struct {
	HostID   int     `json:"hostId,omitempty"`
	Host     string  `json:"host"`
	Port     int     `json:"port"`
	State    string  `json:"state"`
	Reason   string  `json:"reason,omitempty"`
	Share    float64 `json:"share"`
	Picks    uint64  `json:"picks"`
	MedianMs float64 `json:"medianMs,omitempty"`
	JitterMs float64 `json:"jitterMs,omitempty"`
	LossPct  float64 `json:"lossPct,omitempty"`
	Samples  int     `json:"samples,omitempty"`
}

type balanceEvent struct {
	At     int64  `json:"at"`
	HostID int    `json:"hostId,omitempty"`
	Host   string `json:"host"`
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason,omitempty"`
}

type balanceRuleReport struct {
	TunnelID    int                 `json:"tunnelId"`
	RuleID      int                 `json:"ruleId"`
	Strategy    string              `json:"strategy"`
	TargetAware bool                `json:"targetAware"`
	Exits       []balanceExitReport `json:"exits"`
	Events      []balanceEvent      `json:"events,omitempty"`
}

// balanceSnapshotLocked：这条规则此刻每台出口的状态（不含比例）。调用方持锁。
func (s *exitEndpointSelector) balanceSnapshotLocked(now time.Time) []balanceExitReport {
	exits := make([]balanceExitReport, len(s.endpoints))
	for i, endpoint := range s.endpoints {
		item := balanceExitReport{HostID: endpoint.HostID, Host: endpoint.Host, Port: endpoint.Port, State: "standby", Share: -1}
		if !s.states[i].isHealthy() {
			item.State, item.Reason = "down", "exit"
		}
		if s.endpointReportsTarget(i) {
			health := s.target.health[i]
			stats := health.stats()
			item.MedianMs = roundTenth(stats.median)
			item.JitterMs = roundTenth(stats.jitter)
			item.LossPct = roundTenth(stats.loss * 100)
			item.Samples = stats.samples
			if item.State != "down" {
				switch {
				case health.down:
					item.State, item.Reason = "down", "target"
				case health.unstable && s.target.detect.action != "ignore":
					item.State, item.Reason = "unstable", "target"
				}
			}
		}
		exits[i] = item
	}
	// 现在会挑谁（没有新连接时用它当 active）
	if s.strategy == "fallback" {
		// 主备：实际会挑的那台就是「在用」，哪怕它到目标不稳 / 刚恢复（前面的都连不上时就是它在扛，路线图 X1）。
		if index, ok := s.fallbackChoiceLocked(nil, now, false); ok && exits[index].State != "down" {
			exits[index].State = "active"
		}
		return exits
	}
	candidates, _ := s.candidatesLocked(nil, now, false)
	for _, index := range candidates {
		if exits[index].State == "standby" {
			exits[index].State = "active"
		}
	}
	return exits
}

func roundTenth(value float64) float64 {
	if value <= 0 {
		return 0
	}
	return float64(int64(value*10+0.5)) / 10
}

// countPickLocked：记一次「新连接给了这台」。调用方持锁。
func (s *exitEndpointSelector) countPickLocked(index int) {
	if index < 0 || index >= len(s.endpoints) {
		return
	}
	if len(s.picks) != len(s.endpoints) {
		s.picks = make([]uint64, len(s.endpoints))
	}
	s.picks[index]++
}

func (s *exitEndpointSelector) picksSnapshotLocked() []uint64 {
	out := make([]uint64, len(s.endpoints))
	copy(out, s.picks)
	return out
}

/* ───────────────────────── 上报 ───────────────────────── */

type balanceReportEntry struct {
	selector *exitEndpointSelector
	cfg      config
}

type balanceRuleState struct {
	lastStates map[string]string // 出口 host:port → 上次的状态
	lastPicks  map[string]uint64 // 出口 host:port → 上次报的累计次数
	events     []balanceEvent
}

var balanceReporter = struct {
	mu      sync.Mutex
	once    sync.Once
	entries map[*exitEndpointSelector]config
	refs    map[*exitEndpointSelector]int
	rules   map[string]*balanceRuleState // "tunnel:rule"
	dirty   bool
	dirtyAt time.Time
	last    time.Time
}{entries: map[*exitEndpointSelector]config{}, refs: map[*exitEndpointSelector]int{}, rules: map[string]*balanceRuleState{}}

// registerBalanceReport：入口的一条有几台出口的规则开始报状态，返回的函数撤销。
func registerBalanceReport(s *exitEndpointSelector, cfg config) func() {
	if s == nil || strings.TrimSpace(cfg.PanelURL) == "" || strings.TrimSpace(cfg.Token) == "" || cfg.RuleID <= 0 {
		return func() {}
	}
	// 同一条规则的 TCP 运行时和 UDP 运行时共用一个选择器，各登记一次：都撤了才不再报。
	balanceReporter.mu.Lock()
	balanceReporter.entries[s] = cfg
	balanceReporter.refs[s]++
	balanceReporter.dirty = true
	balanceReporter.mu.Unlock()
	startBalanceReporter()
	var once sync.Once
	return func() {
		once.Do(func() {
			balanceReporter.mu.Lock()
			if balanceReporter.refs[s]--; balanceReporter.refs[s] <= 0 {
				delete(balanceReporter.refs, s)
				delete(balanceReporter.entries, s)
			}
			balanceReporter.mu.Unlock()
		})
	}
}

func startBalanceReporter() {
	balanceReporter.once.Do(func() {
		go func() {
			ticker := time.NewTicker(balanceReportPoll)
			defer ticker.Stop()
			for now := range ticker.C {
				reports, due := collectBalanceReports(now, false)
				if due {
					postBalanceReports(reports)
				}
			}
		}()
	})
}

func balanceExitKey(item balanceExitReport) string {
	return fmt.Sprintf("%s:%d", item.Host, item.Port)
}

// collectBalanceReports 每秒调一次：比较状态、记下变化，到点（有变化或满 10 秒）时返回要报的内容。
// force 给测试用：不管到没到点都返回。
func collectBalanceReports(now time.Time, force bool) (map[balanceReportKey][]balanceRuleReport, bool) {
	balanceReporter.mu.Lock()
	entries := make([]balanceReportEntry, 0, len(balanceReporter.entries))
	for selector, cfg := range balanceReporter.entries {
		entries = append(entries, balanceReportEntry{selector: selector, cfg: cfg})
	}
	balanceReporter.mu.Unlock()

	type snap struct {
		entry balanceReportEntry
		exits []balanceExitReport
		picks []uint64
	}
	snaps := make([]snap, 0, len(entries))
	for _, entry := range entries {
		entry.selector.mu.Lock()
		exits := entry.selector.balanceSnapshotLocked(now)
		picks := entry.selector.picksSnapshotLocked()
		entry.selector.mu.Unlock()
		snaps = append(snaps, snap{entry: entry, exits: exits, picks: picks})
	}

	balanceReporter.mu.Lock()
	defer balanceReporter.mu.Unlock()
	for _, item := range snaps {
		key := fmt.Sprintf("%d:%d", item.entry.cfg.TunnelID, item.entry.cfg.RuleID)
		rule := balanceReporter.rules[key]
		if rule == nil {
			rule = &balanceRuleState{lastStates: map[string]string{}, lastPicks: map[string]uint64{}}
			balanceReporter.rules[key] = rule
			balanceReporter.dirty = true
		}
		for _, exit := range item.exits {
			exitKey := balanceExitKey(exit)
			previous, seen := rule.lastStates[exitKey]
			if seen && previous != exit.State {
				rule.events = append(rule.events, balanceEvent{At: now.UnixMilli(), HostID: exit.HostID, Host: exit.Host, From: previous, To: exit.State, Reason: exit.Reason})
				if len(rule.events) > balanceReportMaxEvents {
					rule.events = rule.events[len(rule.events)-balanceReportMaxEvents:]
				}
				balanceReporter.dirty = true
			}
			rule.lastStates[exitKey] = exit.State
		}
	}
	if balanceReporter.dirty && balanceReporter.dirtyAt.IsZero() {
		balanceReporter.dirtyAt = now
	}
	due := force || now.Sub(balanceReporter.last) >= balanceReportInterval ||
		(!balanceReporter.dirtyAt.IsZero() && now.Sub(balanceReporter.dirtyAt) >= balanceReportPoll)
	if !due {
		return nil, false
	}
	balanceReporter.dirty = false
	balanceReporter.dirtyAt = time.Time{}
	balanceReporter.last = now

	out := map[balanceReportKey][]balanceRuleReport{}
	count := 0
	for _, item := range snaps {
		if count >= balanceReportMaxRules {
			break
		}
		cfg := item.entry.cfg
		key := fmt.Sprintf("%d:%d", cfg.TunnelID, cfg.RuleID)
		rule := balanceReporter.rules[key]
		// 这段时间新连接分给了谁
		var total uint64
		deltas := make([]uint64, len(item.exits))
		for i, exit := range item.exits {
			exitKey := balanceExitKey(exit)
			if i < len(item.picks) {
				current := item.picks[i]
				if last, ok := rule.lastPicks[exitKey]; ok && current >= last {
					deltas[i] = current - last
				} else if !ok {
					deltas[i] = current
				}
				rule.lastPicks[exitKey] = current
			}
			total += deltas[i]
		}
		exits := append([]balanceExitReport(nil), item.exits...)
		if total > 0 {
			for i := range exits {
				exits[i].Picks = deltas[i]
				exits[i].Share = roundTenth(float64(deltas[i])*1000/float64(total)) / 1000
				// 真有新连接分给它的，就是在用；能用但一个都没分到的是备用
				if deltas[i] > 0 && exits[i].State == "standby" {
					exits[i].State = "active"
				} else if deltas[i] == 0 && exits[i].State == "active" {
					exits[i].State = "standby"
				}
			}
		}
		strategy := item.entry.selector.strategy
		out[balanceReportKey{panelURL: strings.TrimSpace(cfg.PanelURL), token: strings.TrimSpace(cfg.Token)}] = append(
			out[balanceReportKey{panelURL: strings.TrimSpace(cfg.PanelURL), token: strings.TrimSpace(cfg.Token)}],
			balanceRuleReport{
				TunnelID:    cfg.TunnelID,
				RuleID:      cfg.RuleID,
				Strategy:    strategy,
				TargetAware: item.entry.selector.targetAware(),
				Exits:       exits,
				Events:      append([]balanceEvent(nil), rule.events...),
			})
		count++
	}
	// 撤掉的规则不再留状态
	live := map[string]bool{}
	for _, item := range snaps {
		live[fmt.Sprintf("%d:%d", item.entry.cfg.TunnelID, item.entry.cfg.RuleID)] = true
	}
	for key := range balanceReporter.rules {
		if !live[key] {
			delete(balanceReporter.rules, key)
		}
	}
	return out, true
}

type balanceReportKey struct {
	panelURL, token string
}

func postBalanceReports(groups map[balanceReportKey][]balanceRuleReport) {
	for key, rules := range groups {
		sort.Slice(rules, func(i, j int) bool {
			if rules[i].TunnelID != rules[j].TunnelID {
				return rules[i].TunnelID < rules[j].TunnelID
			}
			return rules[i].RuleID < rules[j].RuleID
		})
		if err := postBalanceReport(key, rules); err != nil {
			logTrafficDiagnostic("balance-report", "balance report failed: %s", safeTrafficReportError(err, key.token))
		}
	}
}

func postBalanceReport(key balanceReportKey, rules []balanceRuleReport) error {
	payload := map[string]any{
		"rules":      rules,
		"reportedAt": time.Now().UnixMilli(),
	}
	env, err := encryptEnvelope(payload, key.token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	resp, err := postFXPEncryptedPanelRequest(trafficHTTPClient, key.panelURL, key.token, balanceReportPath, body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New("panel returned " + resp.Status)
	}
	return nil
}
