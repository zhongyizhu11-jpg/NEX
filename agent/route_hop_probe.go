package main

import (
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
线路组「中转后面的落地」的快速探测（2.2.258 起）。

入口机只连得到第一跳；中转用的是 gost 转发，落地断了 gost 照样接住入口的连接，入口自己的探测和真实拨号都看着
「通」。以前这一跳通不通只靠中转机的普通规则测延迟（一分钟一轮）+ 面板连续三次才算断，主落地挂了要两三分钟才
切到备用。

现在面板在下发的探测清单（ruleLatencyProbes）里给这类「下一跳」探测带上 routeHop：这台机器（gost 中转本机，
或隧道段的出口机）按线路组的节奏单独探它 —— 默认每 1.5 秒一次 TCP 连接，连续 N 次（线路组的「连续失败次数」）
不通就算断，连续 RecoverOks 次通了才算恢复；一翻转立刻报面板（/api/agent/route-hop-probes），面板马上推给
入口机切线路。不翻转时每 30 秒报一次全量，面板据此知道这条快速通道还活着（没活着就退回慢探测的结论）。
*/

type routeHopProbeSpec struct {
	IntervalMs    int `json:"intervalMs"`
	TimeoutMs     int `json:"timeoutMs"`
	FailThreshold int `json:"failThreshold"`
	RecoverOks    int `json:"recoverOks"`
}

const (
	routeHopProbeTick          = 250 * time.Millisecond
	routeHopProbeSnapshotEvery = 30 * time.Second
	routeHopProbeMaxParallel   = 16
)

type routeHopProbeState struct {
	key        string
	ruleID     int
	target     string
	spec       routeHopProbeSpec
	nextDue    time.Time
	running    bool
	fails      int
	oks        int
	down       bool
	known      bool
	latencyMs  float64
	lastResult time.Time
}

type routeHopProbeRunner struct {
	mu           sync.Mutex
	states       map[string]*routeHopProbeState
	changed      map[int]bool
	lastSnapshot time.Time
	sem          chan struct{}
	dial         func(network, address string, timeout time.Duration) (net.Conn, error)
	now          func() time.Time
}

func newRouteHopProbeRunner() *routeHopProbeRunner {
	return &routeHopProbeRunner{
		states:  map[string]*routeHopProbeState{},
		changed: map[int]bool{},
		sem:     make(chan struct{}, routeHopProbeMaxParallel),
		dial:    net.DialTimeout,
		now:     time.Now,
	}
}

func normalizeRouteHopProbeSpec(spec routeHopProbeSpec) routeHopProbeSpec {
	if spec.IntervalMs < 500 {
		spec.IntervalMs = 1500
	}
	if spec.IntervalMs > 30000 {
		spec.IntervalMs = 30000
	}
	if spec.TimeoutMs <= 0 {
		spec.TimeoutMs = 2000
	}
	if spec.TimeoutMs > 5000 {
		spec.TimeoutMs = 5000
	}
	if spec.FailThreshold < 1 {
		spec.FailThreshold = 2
	}
	if spec.FailThreshold > 10 {
		spec.FailThreshold = 10
	}
	if spec.RecoverOks < 1 {
		spec.RecoverOks = 3
	}
	if spec.RecoverOks > 20 {
		spec.RecoverOks = 20
	}
	return spec
}

func routeHopProbeKey(probe ruleLatencyProbe) string {
	return strconv.Itoa(probe.RuleID) + "|" + strings.ToLower(strings.TrimSpace(probe.TargetIP)) + "|" + strconv.Itoa(probe.TargetPort)
}

// sync 换上面板这一次给的清单：新出现的立刻探一次，消失的丢掉，目标没变的保留计数和状态。
func (r *routeHopProbeRunner) sync(probes []ruleLatencyProbe) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	seen := map[string]bool{}
	for _, probe := range probes {
		if probe.RouteHop == nil || probe.RuleID <= 0 || strings.TrimSpace(probe.TargetIP) == "" || probe.TargetPort <= 0 {
			continue
		}
		key := routeHopProbeKey(probe)
		seen[key] = true
		spec := normalizeRouteHopProbeSpec(*probe.RouteHop)
		state := r.states[key]
		if state == nil {
			state = &routeHopProbeState{
				key:     key,
				ruleID:  probe.RuleID,
				target:  net.JoinHostPort(strings.TrimSpace(probe.TargetIP), strconv.Itoa(probe.TargetPort)),
				nextDue: now,
			}
			r.states[key] = state
		}
		state.spec = spec
	}
	for key := range r.states {
		if !seen[key] {
			delete(r.states, key)
		}
	}
}

// due 挑出这一刻该探的（不重复探同一个）。
func (r *routeHopProbeRunner) due() []*routeHopProbeState {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	out := []*routeHopProbeState{}
	for _, state := range r.states {
		if state.running || now.Before(state.nextDue) {
			continue
		}
		state.running = true
		state.nextDue = now.Add(time.Duration(state.spec.IntervalMs) * time.Millisecond)
		out = append(out, state)
	}
	return out
}

func (r *routeHopProbeRunner) probe(state *routeHopProbeState) {
	r.mu.Lock()
	target := state.target
	timeout := time.Duration(state.spec.TimeoutMs) * time.Millisecond
	r.mu.Unlock()
	started := r.now()
	conn, err := r.dial("tcp", target, timeout)
	elapsed := r.now().Sub(started)
	if conn != nil {
		_ = conn.Close()
	}
	r.record(state, err == nil, float64(elapsed.Microseconds())/1000)
}

// record 记一次结果；翻转了记进 changed，下一次 flush 立刻报。
func (r *routeHopProbeRunner) record(state *routeHopProbeState, ok bool, latencyMs float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state.running = false
	state.lastResult = r.now()
	if ok {
		state.oks++
		state.fails = 0
		state.latencyMs = latencyMs
	} else {
		state.fails++
		state.oks = 0
	}
	if r.states[state.key] != state {
		return
	}
	switch {
	case !state.known && ok:
		// 第一次就通：直接算通，报一次让面板知道快速通道在跑。
		state.known = true
		state.down = false
		r.changed[state.ruleID] = true
	case ok && state.down && state.oks >= state.spec.RecoverOks:
		state.down = false
		state.known = true
		r.changed[state.ruleID] = true
	case !ok && !state.down && state.fails >= state.spec.FailThreshold:
		state.down = true
		state.known = true
		r.changed[state.ruleID] = true
	}
}

// report 这次要发的结果：有翻转只发翻转的；到了全量的时候发全部（已经判出结论的）。没有要发的返回 nil。
func (r *routeHopProbeRunner) report() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	full := now.Sub(r.lastSnapshot) >= routeHopProbeSnapshotEvery
	if len(r.changed) == 0 && !full {
		return nil
	}
	results := []map[string]any{}
	for _, state := range r.states {
		if !state.known {
			continue
		}
		if !full && !r.changed[state.ruleID] {
			continue
		}
		item := map[string]any{"ruleId": state.ruleID, "down": state.down}
		if !state.down && state.latencyMs > 0 {
			item["latencyMs"] = state.latencyMs
		}
		results = append(results, item)
	}
	r.changed = map[int]bool{}
	if full {
		r.lastSnapshot = now
	}
	if len(results) == 0 {
		return nil
	}
	return results
}

func (r *routeHopProbeRunner) idle() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.states) == 0
}

var agentRouteHopProbes = newRouteHopProbeRunner()

// routeHopProbeSpecsFromState 只抄带 routeHop 的那几条：每 250ms 一次，不整份复制心跳状态。
func routeHopProbeSpecsFromState() []ruleLatencyProbe {
	heartbeatStateMu.Lock()
	defer heartbeatStateMu.Unlock()
	out := []ruleLatencyProbe{}
	for _, probe := range heartbeatStateCache.RuleLatencyProbes {
		if probe.RouteHop != nil {
			out = append(out, probe)
		}
	}
	return out
}

func routeHopProbeLoop(cfg Config) {
	ticker := time.NewTicker(routeHopProbeTick)
	defer ticker.Stop()
	var wg sync.WaitGroup
	for range ticker.C {
		agentRouteHopProbes.sync(routeHopProbeSpecsFromState())
		if agentRouteHopProbes.idle() {
			continue
		}
		for _, state := range agentRouteHopProbes.due() {
			state := state
			wg.Add(1)
			agentRouteHopProbes.sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-agentRouteHopProbes.sem }()
				agentRouteHopProbes.probe(state)
			}()
		}
		if results := agentRouteHopProbes.report(); results != nil {
			go func(results []map[string]any) {
				if err := post(cfg, "/api/agent/route-hop-probes", map[string]any{"results": results}, &map[string]any{}); err != nil {
					logf("route hop probe report failed: %v", err)
				}
			}(results)
		}
	}
	wg.Wait()
}
