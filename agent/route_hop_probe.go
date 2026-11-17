package main

import (
	"math"
	"net"
	"sort"
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
	// Passive（2.2.260 起，负载均衡「这台出口到规则目标」那几条）：先看这台机器上到这个目标的真实连接（内核记的 RTT，
	// 见 passive_rtt.go），有活跃连接就用它，不再新建连接去探；没有才主动探。
	Passive bool `json:"passive,omitempty"`
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
	// 最近 30 次的结果（2.2.259 起）：报中位数、抖动、丢包，面板拿它显示「延迟 · 抖动」、判不稳。
	samples [routeHopProbeWindow]routeHopSample
	count   int
	pos     int
	// 真实流量那边：重传比例（平滑过的）、最近一次看到几条活跃连接
	passiveLoss  float64
	passiveConns int
	passiveMinMs float64
}

type routeHopSample struct {
	ms float64
	ok bool
	// passive：这一次来自真实连接（内核 RTT），varMs 是内核算的 RTT 波动
	passive bool
	varMs   float64
}

const routeHopProbeWindow = 30

// routeHopStats：中位延迟、抖动、丢包率（0～1）、这条路的最低延迟、这次的来源。
type routeHopStats struct {
	median  float64
	jitter  float64
	loss    float64
	minMs   float64
	passive bool
}

/*
stats（2.2.260 起换了算法）：

	· 抖动：以前是「相邻两次成功的差的平均」—— 一次 1000ms 的重发就拉高几十毫秒。现在真实流量为主时用内核算的 RTT
	  波动（各次的中位数）；主动探测为主时用「比这条路最低延迟高出多少」的 90 分位（排队造成的那部分，偶尔一个尖峰
	  不影响）。
	· 丢包：主动探测整轮不通的比例，和真实连接的重传比例，取大的。
*/
func (s *routeHopProbeState) stats() routeHopStats {
	var oks, passiveVars, activeOks []float64
	failures := 0
	for i := 0; i < s.count; i++ {
		sample := s.samples[(s.pos-s.count+i+routeHopProbeWindow)%routeHopProbeWindow]
		if !sample.ok {
			failures++
			continue
		}
		oks = append(oks, sample.ms)
		if sample.passive {
			passiveVars = append(passiveVars, sample.varMs)
		} else {
			activeOks = append(activeOks, sample.ms)
		}
	}
	out := routeHopStats{}
	if s.count > 0 {
		out.loss = float64(failures) / float64(s.count)
	}
	if s.passiveLoss > out.loss {
		out.loss = s.passiveLoss
	}
	if len(oks) == 0 {
		return out
	}
	out.median = medianFloat(oks)
	out.minMs = oks[0]
	for _, ms := range oks {
		if ms < out.minMs {
			out.minMs = ms
		}
	}
	if s.passiveMinMs > 0 && len(passiveVars) > 0 && s.passiveMinMs < out.minMs {
		out.minMs = s.passiveMinMs
	}
	if len(passiveVars) > 0 && len(passiveVars)*2 >= len(oks) {
		out.passive = true
		out.jitter = medianFloat(passiveVars)
		return out
	}
	if len(activeOks) >= 3 {
		floor := activeOks[0]
		for _, ms := range activeOks {
			if ms < floor {
				floor = ms
			}
		}
		queue := make([]float64, 0, len(activeOks))
		for _, ms := range activeOks {
			queue = append(queue, ms-floor)
		}
		sort.Float64s(queue)
		index := int(math.Ceil(float64(len(queue))*0.9)) - 1
		if index < 0 {
			index = 0
		}
		out.jitter = queue[index]
	}
	return out
}

type routeHopProbeRunner struct {
	mu           sync.Mutex
	states       map[string]*routeHopProbeState
	changed      map[int]bool
	lastSnapshot time.Time
	sem          chan struct{}
	dial         func(network, address string, timeout time.Duration) (net.Conn, error)
	now          func() time.Time
	scanner      *passiveRTTScanner
	lastScan     time.Time
	passive      map[string]passiveTargetStats
}

func newRouteHopProbeRunner() *routeHopProbeRunner {
	return &routeHopProbeRunner{
		states:  map[string]*routeHopProbeState{},
		changed: map[int]bool{},
		sem:     make(chan struct{}, routeHopProbeMaxParallel),
		dial:    net.DialTimeout,
		now:     time.Now,
		scanner: newPassiveRTTScanner(),
		passive: map[string]passiveTargetStats{},
	}
}

// scanPassive 每 2 秒读一次到「要看真实流量」的那些目标的连接（一次 ss，不管有几个目标）。
func (r *routeHopProbeRunner) scanPassive() {
	r.mu.Lock()
	now := r.now()
	if r.scanner == nil || now.Sub(r.lastScan) < passiveRTTScanEvery {
		r.mu.Unlock()
		return
	}
	r.lastScan = now
	targets := []string{}
	for _, state := range r.states {
		if state.spec.Passive {
			targets = append(targets, state.target)
		}
	}
	r.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	stats := r.scanner.scan(targets, now)
	r.mu.Lock()
	r.passive = map[string]passiveTargetStats{}
	for key, value := range stats {
		r.passive[key] = value
	}
	r.mu.Unlock()
}

// usePassive：这条要看真实流量、而且刚读到到这个目标的活跃连接 —— 直接记一次（不建连接），返回 true。
func (r *routeHopProbeRunner) usePassive(state *routeHopProbeState) bool {
	r.mu.Lock()
	if !state.spec.Passive {
		r.mu.Unlock()
		return false
	}
	stats, ok := r.passive[normalizePassiveTarget(state.target)]
	fresh := ok && r.now().Sub(stats.at) <= passiveRTTFresh
	if fresh && stats.segsDelta >= 20 {
		// 重传比例平滑一下：一次扫描几十个包，单次比例跳得厉害
		ratio := float64(stats.retransDelta) / float64(stats.segsDelta)
		state.passiveLoss = state.passiveLoss*0.7 + ratio*0.3
	}
	if !fresh || stats.conns == 0 {
		r.mu.Unlock()
		return false
	}
	state.passiveConns = stats.conns
	state.passiveMinMs = stats.minMs
	r.mu.Unlock()
	r.recordSample(state, routeHopSample{ms: stats.srttMs, ok: true, passive: true, varMs: stats.varMs})
	return true
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

/*
routeHopProbeInterval（2.2.261 起）：负载均衡「出口到目标」那几条（Passive）判成连不上以后，间隔每多失败一次
翻一倍，最长 60 秒，每次只连 1 次。用户：「这么久了不会一直没恢复吧，机器是正常的」—— 目标是高防时，一直每
2 秒连三次、连上就断，像扫描，会让对方一直拦着这台出口的 IP，永远恢复不了；慢下来让拦截有机会过期。恢复最多
晚一分钟发现。线路组的下一跳（自己的中转机）照旧按原节奏探，切回要快。
*/
const routeHopProbeBackoffMax = 60 * time.Second

func routeHopProbeInterval(state *routeHopProbeState) time.Duration {
	interval := time.Duration(state.spec.IntervalMs) * time.Millisecond
	if !state.spec.Passive || !state.down {
		return interval
	}
	extra := state.fails - state.spec.FailThreshold
	if extra < 0 {
		extra = 0
	}
	for step := 0; step <= extra && interval < routeHopProbeBackoffMax; step++ {
		interval *= 2
	}
	if interval > routeHopProbeBackoffMax {
		interval = routeHopProbeBackoffMax
	}
	return interval
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
		state.nextDue = now.Add(routeHopProbeInterval(state))
		out = append(out, state)
	}
	return out
}

/*
主动探一轮（2.2.260 起）：连 2 次成功为止（最多 3 次），延迟取成功里最小的 —— 最小值滤掉偶发的排队、本机忙。
一次连接拖到「握手包丢了、系统 1 秒后重发」才连上（≥ 900ms，或者比这条路最低延迟慢 3 倍以上）算这次丢了，
不算成 1000ms 延迟：以前一个丢包就把抖动拉高几十上百毫秒。三次都不行这一轮才算不通。
*/
const routeHopRetransmitCutoff = 900 * time.Millisecond

func (r *routeHopProbeRunner) probe(state *routeHopProbeState) {
	r.mu.Lock()
	target := state.target
	timeout := time.Duration(state.spec.TimeoutMs) * time.Millisecond
	floor := windowMinLocked(state)
	// 判成连不上的出口（Passive）：每轮只连 1 次，别像扫描
	attempts := 3
	if state.spec.Passive && state.down {
		attempts = 1
	}
	r.mu.Unlock()
	cutoff := timeout
	if floor > 0 {
		// 已经知道这条路多快：超过 max(900ms, 3 倍最低延迟) 的就当丢了
		cutoff = routeHopRetransmitCutoff
		if limit := time.Duration(floor*3*1000) * time.Microsecond; limit > cutoff {
			cutoff = limit
		}
		if cutoff > timeout {
			cutoff = timeout
		}
	}
	best := -1.0
	successes := 0
	for attempt := 0; attempt < attempts && successes < 2; attempt++ {
		started := r.now()
		conn, err := r.dial("tcp", target, cutoff)
		elapsed := r.now().Sub(started)
		if conn != nil {
			_ = conn.Close()
		}
		if err != nil || elapsed >= cutoff {
			continue
		}
		successes++
		ms := float64(elapsed.Microseconds()) / 1000
		if best < 0 || ms < best {
			best = ms
		}
	}
	if successes == 0 {
		r.recordSample(state, routeHopSample{ok: false})
		return
	}
	r.recordSample(state, routeHopSample{ms: best, ok: true})
}

// windowMinLocked：最近窗口里成功的那几次的最小延迟（没有返回 0）。调用方持锁。
func windowMinLocked(state *routeHopProbeState) float64 {
	min := 0.0
	for i := 0; i < state.count; i++ {
		sample := state.samples[(state.pos-state.count+i+routeHopProbeWindow)%routeHopProbeWindow]
		if sample.ok && sample.ms > 0 && (min == 0 || sample.ms < min) {
			min = sample.ms
		}
	}
	return min
}

// record 兼容老的调用（测试里用）：一次普通的主动结果。
func (r *routeHopProbeRunner) record(state *routeHopProbeState, ok bool, latencyMs float64) {
	r.recordSample(state, routeHopSample{ms: latencyMs, ok: ok})
}

// recordSample 记一次结果；翻转了记进 changed，下一次 flush 立刻报。
func (r *routeHopProbeRunner) recordSample(state *routeHopProbeState, sample routeHopSample) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ok := sample.ok
	latencyMs := sample.ms
	state.running = false
	state.lastResult = r.now()
	state.samples[state.pos] = sample
	state.pos = (state.pos + 1) % routeHopProbeWindow
	if state.count < routeHopProbeWindow {
		state.count++
	}
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
		// 2.2.259 起多报中位数、抖动、丢包；2.2.260 起多报最低延迟、来源（traffic = 真实连接，probe = 主动探测）、
		// 活跃连接数（面板老版本不认这几个字段，照旧只看 down / latencyMs）。
		if state.count > 0 {
			stats := state.stats()
			item["medianMs"] = math.Round(stats.median*10) / 10
			item["jitterMs"] = math.Round(stats.jitter*10) / 10
			item["lossPct"] = math.Round(stats.loss*1000) / 10
			item["samples"] = state.count
			if stats.minMs > 0 {
				item["minMs"] = math.Round(stats.minMs*10) / 10
			}
			if stats.passive {
				item["source"] = "traffic"
				item["conns"] = state.passiveConns
			} else {
				item["source"] = "probe"
			}
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
		agentRouteHopProbes.scanPassive()
		for _, state := range agentRouteHopProbes.due() {
			state := state
			if agentRouteHopProbes.usePassive(state) {
				continue
			}
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
