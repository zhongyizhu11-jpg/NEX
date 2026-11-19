package main

import (
	"errors"
	"io"
	"math"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
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

H1 之后的几条规矩：
  - 一个目标探得慢不拖别的目标。以前每 250ms 一轮里「占满 16 个并发名额就原地等」：96 个黑洞目标（每个一轮
    最多等 3×2 秒）把循环卡死，旁边一个好端端的目标 8 秒只探到 4 次，翻转也报不出去。现在循环从不等：
    到点的目标有名额就开一个 goroutine 去探，没名额这一拍先跳过（下一拍再看，优先给没判坏的）；
    上一轮还没探完的目标这一拍也跳过。一轮探测总共最多花 TimeoutMs，不再是「每次连接各等一个超时」。
  - 几条规则探同一个下一跳（地址一样、参数一样）只探一份，结果按规则各报各的。
  - 翻转报面板失败了不丢：翻转记录留到面板收下为止，下一拍重报（连着失败就退避，最长 5 秒）。
    以前报的那一刻就清掉，失败了要等 30 秒后的全量才补上 —— 快速通道白快了。
  - 间隔带 ±10% 抖动，一批目标不会永远在同一毫秒一起探。
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
	// 同时在探的目标上限。名额只是防止目标特别多时一下子开太多连接；不够时到点的目标这一拍先跳过，不排队等。
	routeHopProbeMaxParallel = 256
	// 报面板连着失败时两次重报之间最长隔多久。
	routeHopReportRetryMax = 5 * time.Second
	// 真实流量的重传率多久没有新样本就不再算数（H2）。
	routeHopPassiveLossStale = 30 * time.Second
)

type routeHopProbeState struct {
	// key：目标 + 探测参数。几条规则探同一个下一跳共用一份（rules 里是这些规则）。
	key        string
	rules      map[int]bool
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
	// 重传比例最近一次有新样本（两次扫描之间发了够多的包）的时刻。
	passiveLossAt time.Time
	// 连着几轮不通都是目标主动拒绝（RST）：只有这种才放慢到 60 秒（routeHopProbeInterval）。
	rejectStreak int
}

type routeHopSample struct {
	ms float64
	ok bool
	// passive：这一次来自真实连接（内核 RTT），varMs 是内核算的 RTT 波动
	passive bool
	varMs   float64
	// 不通的这一轮是被目标主动拒的（RST），不是超时 / 不可达
	rejected bool
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
statsAt（2.2.260 起换了算法）。now 是零值时不做过期判断（测试里手搭的状态，见 stats）：

	· 抖动：以前是「相邻两次成功的差的平均」—— 一次 1000ms 的重发就拉高几十毫秒。现在真实流量为主时用内核算的 RTT
	  波动（各次的中位数）；主动探测为主时用「比这条路最低延迟高出多少」的 90 分位（排队造成的那部分，偶尔一个尖峰
	  不影响）。
	· 丢包：主动探测整轮不通的比例，和真实连接的重传比例，取大的。
	· 重传比例会过期（H2）：它只在「两次扫描之间到这个目标发了够多的包」时更新。流量一停就再也没有新样本，
	  以前这个数就永远停在流量停下那一刻 —— 丢过一阵包的出口之后一直被报成「不稳」，哪怕主动探测全是通的。
	  现在超过 routeHopPassiveLossStale 没有新样本就不算它，由主动探测的结果接手；流量还在而且干净时，
	  它本来就按 0.7 的系数每次扫描往下掉，二十来秒归零。
*/
func (s *routeHopProbeState) statsAt(now time.Time) routeHopStats {
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
	passiveLoss := s.passiveLoss
	if !now.IsZero() && (s.passiveLossAt.IsZero() || now.Sub(s.passiveLossAt) > routeHopPassiveLossStale) {
		passiveLoss = 0
	}
	if passiveLoss > out.loss {
		out.loss = passiveLoss
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
	mu     sync.Mutex
	states map[string]*routeHopProbeState
	// 翻转了、还没被面板收下的规则 → 翻转的序号。报成功了才清（清的时候序号没变才清：报的途中又翻了一次的留着）。
	changed      map[int]uint64
	changeSeq    uint64
	lastSnapshot time.Time
	// 有一次上报在路上（同一时刻只报一份）；连着失败时下一次最早什么时候再报。
	reporting     bool
	reportRetryAt time.Time
	reportBackoff time.Duration
	sem           chan struct{}
	dial          func(network, address string, timeout time.Duration) (net.Conn, error)
	now           func() time.Time
	// 间隔的抖动；nil = 不抖（测试里要精确的间隔）。
	jitter   func(time.Duration) time.Duration
	scanner  *passiveRTTScanner
	scanning atomic.Bool
	lastScan time.Time
	passive  map[string]passiveTargetStats
}

func newRouteHopProbeRunner() *routeHopProbeRunner {
	return &routeHopProbeRunner{
		states:  map[string]*routeHopProbeState{},
		changed: map[int]uint64{},
		sem:     make(chan struct{}, routeHopProbeMaxParallel),
		dial:    net.DialTimeout,
		now:     time.Now,
		scanner: newPassiveRTTScanner(),
		passive: map[string]passiveTargetStats{},
	}
}

// 调用方持锁。
func (r *routeHopProbeRunner) markChangedLocked(ruleID int) {
	r.changeSeq++
	r.changed[ruleID] = r.changeSeq
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
		state.passiveLossAt = r.now()
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

// routeHopProbeKey 一份探测的键：目标地址 + 探测参数。规则号不在里面 —— 几条规则探同一个下一跳、参数也一样时
// 共用一份探测（一台中转后面挂着几十条线路组规则很常见，以前每条规则各探各的，同一个端口一秒被连几十次）。
func routeHopProbeKey(probe ruleLatencyProbe) string {
	key := strings.ToLower(strings.TrimSpace(probe.TargetIP)) + "|" + strconv.Itoa(probe.TargetPort)
	if probe.RouteHop == nil {
		return key
	}
	spec := normalizeRouteHopProbeSpec(*probe.RouteHop)
	return key + "|" + strconv.Itoa(spec.IntervalMs) + "/" + strconv.Itoa(spec.TimeoutMs) + "/" + strconv.Itoa(spec.FailThreshold) + "/" + strconv.Itoa(spec.RecoverOks) + "/" + strconv.FormatBool(spec.Passive)
}

// sync 换上面板这一次给的清单：新出现的立刻探一次，消失的丢掉，目标没变的保留计数和状态。
func (r *routeHopProbeRunner) sync(probes []ruleLatencyProbe) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	seen := map[string]map[int]bool{}
	for _, probe := range probes {
		if probe.RouteHop == nil || probe.RuleID <= 0 || strings.TrimSpace(probe.TargetIP) == "" || probe.TargetPort <= 0 {
			continue
		}
		key := routeHopProbeKey(probe)
		if seen[key] == nil {
			seen[key] = map[int]bool{}
		}
		seen[key][probe.RuleID] = true
		state := r.states[key]
		if state == nil {
			state = &routeHopProbeState{
				key:     key,
				rules:   map[int]bool{},
				target:  net.JoinHostPort(strings.TrimSpace(probe.TargetIP), strconv.Itoa(probe.TargetPort)),
				nextDue: now,
			}
			r.states[key] = state
		}
		state.spec = normalizeRouteHopProbeSpec(*probe.RouteHop)
		if !state.rules[probe.RuleID] {
			state.rules[probe.RuleID] = true
			// 这条规则是后来才搭上这份探测的，而结论已经有了：立刻替它报一次，不等 30 秒后的全量。
			if state.known {
				r.markChangedLocked(probe.RuleID)
			}
		}
	}
	for key, state := range r.states {
		rules := seen[key]
		if len(rules) == 0 {
			delete(r.states, key)
			continue
		}
		for ruleID := range state.rules {
			if !rules[ruleID] {
				delete(state.rules, ruleID)
			}
		}
	}
}

/*
routeHopProbeInterval：负载均衡「出口到目标」那几条（Passive）判成连不上以后探多勤（每次只连 1 次）。分两种：

  - 目标主动拒绝（RST、连上就被关，routeHopDialRejected）—— 2.2.261 起的退避：间隔每多失败一次翻一倍，最长
    60 秒。用户：「这么久了不会一直没恢复吧，机器是正常的」—— 目标是高防时，一直每 2 秒连三次、连上就断，像
    扫描，会让对方一直拦着这台出口的 IP，永远恢复不了；慢下来让拦截有机会过期。恢复最多晚一分钟发现。
  - 超时、网络不可达（出口自己的网络断了 / 被黑洞，对方根本没看到这台出口的连接）：不放慢，最多两倍节拍（默认
    4 秒）。实测（2.2.264）：三台出口一起断过一阵以后全在 60 秒的退避里，恢复了也要一分钟才报「通了」；这期间
    面板拿到的「连不上」全是旧的 —— 先报恢复的那台一来，另外两台好好的出口被摘掉；后来单独断又恢复的出口要
    半分钟才放回。这种情况连得再勤也不会惹到目标（包到不了它那儿）。
  - 判坏以后通了一次：按原节拍确认恢复（连续 RecoverOks 次通才算好，只多这几次连接），不再按退避的间隔等。

线路组的下一跳（自己的中转机）照旧按原节奏探，切回要快。面板另外按上报的 ageMs / intervalMs 判断「连不上」这条
结论是不是已经旧了（server/exitTargetHealth.ts 的 exitTargetDownStale），旧的不拿来摘出口。
*/
const routeHopProbeBackoffMax = 60 * time.Second

// routeHopDialRejected 这次连接是不是被目标主动拒了（RST / 连上就被关）—— 和「超时、网络不可达」分开：
// 前者是对方在拦这台出口，后者多半是出口自己的网络断了（见 routeHopProbeInterval）。
func routeHopDialRejected(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return false
	}
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, io.EOF) {
		return true
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "connection refused") || strings.Contains(text, "connection reset")
}

func routeHopProbeInterval(state *routeHopProbeState) time.Duration {
	interval := time.Duration(state.spec.IntervalMs) * time.Millisecond
	if !state.spec.Passive || !state.down || state.oks > 0 {
		return interval
	}
	if state.rejectStreak == 0 {
		// 超时 / 不可达：最多两倍节拍
		if interval*2 > routeHopProbeBackoffMax {
			return routeHopProbeBackoffMax
		}
		return interval * 2
	}
	extra := state.rejectStreak - state.spec.FailThreshold
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

// due 挑出这一刻该探的（上一轮还没探完的跳过），标成在探。没判坏的排前面、等得久的排前面：
// 名额不够时先给它们（黑洞目标一轮要占满整个超时，不能让它们把好目标挤掉）。
func (r *routeHopProbeRunner) due() []*routeHopProbeState {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	out := []*routeHopProbeState{}
	for _, state := range r.states {
		if state.running || now.Before(state.nextDue) {
			continue
		}
		out = append(out, state)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].down != out[j].down {
			return !out[i].down
		}
		return out[i].nextDue.Before(out[j].nextDue)
	})
	for _, state := range out {
		state.running = true
		interval := routeHopProbeInterval(state)
		if r.jitter != nil {
			interval = r.jitter(interval)
		}
		state.nextDue = now.Add(interval)
	}
	return out
}

// postpone 这一拍没名额：放回去，下一拍再看。
func (r *routeHopProbeRunner) postpone(state *routeHopProbeState) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state.running = false
	state.nextDue = r.now()
}

// dispatch 把到点的目标派出去探，**从不等**：能用真实流量的直接记；有名额的开 goroutine；没名额的这一拍跳过。
func (r *routeHopProbeRunner) dispatch() {
	for _, state := range r.due() {
		state := state
		if r.usePassive(state) {
			continue
		}
		select {
		case r.sem <- struct{}{}:
			go func() {
				defer func() { <-r.sem }()
				r.probe(state)
			}()
		default:
			r.postpone(state)
		}
	}
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
	rejected := false
	// 一轮总共最多花 timeout：黑洞目标第一次连接就把它用完了，不再接着连第二、第三次（以前一轮 3×超时，
	// 判坏要多等好几秒，名额也被占着）。
	roundStarted := r.now()
	for attempt := 0; attempt < attempts && successes < 2; attempt++ {
		started := r.now()
		limit := cutoff
		if remaining := timeout - started.Sub(roundStarted); remaining < limit {
			limit = remaining
		}
		if limit <= 0 {
			break
		}
		conn, err := r.dial("tcp", target, limit)
		elapsed := r.now().Sub(started)
		if conn != nil {
			_ = conn.Close()
		}
		if err != nil || elapsed >= cutoff {
			if routeHopDialRejected(err) {
				rejected = true
			}
			continue
		}
		successes++
		ms := float64(elapsed.Microseconds()) / 1000
		if best < 0 || ms < best {
			best = ms
		}
	}
	if successes == 0 {
		r.recordSample(state, routeHopSample{ok: false, rejected: rejected})
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
		state.rejectStreak = 0
		state.latencyMs = latencyMs
	} else {
		state.fails++
		state.oks = 0
		if sample.rejected {
			state.rejectStreak++
		} else {
			state.rejectStreak = 0
		}
	}
	if r.states[state.key] != state {
		return
	}
	flipped := false
	switch {
	case !state.known && ok:
		// 第一次就通：直接算通，报一次让面板知道快速通道在跑。
		state.known = true
		state.down = false
		flipped = true
	case ok && state.down && state.oks >= state.spec.RecoverOks:
		state.down = false
		state.known = true
		flipped = true
	case !ok && !state.down && state.fails >= state.spec.FailThreshold:
		state.down = true
		state.known = true
		flipped = true
	}
	if flipped {
		// 共用这份探测的每条规则各报一次。
		for ruleID := range state.rules {
			r.markChangedLocked(ruleID)
		}
	}
}

// routeHopPendingReport 一次要发的上报：结果、它带走的翻转（规则 → 序号）、是不是全量。
type routeHopPendingReport struct {
	results []map[string]any
	changed map[int]uint64
	full    bool
	at      time.Time
}

/*
pendingReport 这次要发的结果：有翻转只发翻转的；到了全量的时候发全部（已经判出结论的）。没有要发的、已经有一份
在路上、或者还在失败后的退避里，返回 nil。拿到的那份发完必须 ack：成功了才把它带走的翻转清掉。
*/
func (r *routeHopProbeRunner) pendingReport() *routeHopPendingReport {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if r.reporting || now.Before(r.reportRetryAt) {
		return nil
	}
	full := now.Sub(r.lastSnapshot) >= routeHopProbeSnapshotEvery
	if len(r.changed) == 0 && !full {
		return nil
	}
	results := []map[string]any{}
	for _, state := range r.states {
		if !state.known {
			continue
		}
		var stats routeHopStats
		if state.count > 0 {
			stats = state.statsAt(now)
		}
		for ruleID := range state.rules {
			if !full && r.changed[ruleID] == 0 {
				continue
			}
			item := map[string]any{"ruleId": ruleID, "down": state.down}
			if !state.down && state.latencyMs > 0 {
				item["latencyMs"] = state.latencyMs
			}
			// 2.2.259 起多报中位数、抖动、丢包；2.2.260 起多报最低延迟、来源（traffic = 真实连接，probe = 主动探测）、
			// 活跃连接数（面板老版本不认这几个字段，照旧只看 down / latencyMs）。
			if state.count > 0 {
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
			// 负载均衡「出口到目标」那几条：这条结论是多久前探的、现在多久探一次（含退避）。面板拿它判断「连不上」
			// 是不是旧的（全局故障刚过时各台都还在退避里），旧的不拿来摘出口。
			if state.spec.Passive && !state.lastResult.IsZero() {
				age := now.Sub(state.lastResult).Milliseconds()
				if age < 0 {
					age = 0
				}
				item["ageMs"] = age
				item["intervalMs"] = routeHopProbeInterval(state).Milliseconds()
			}
			results = append(results, item)
		}
	}
	// 同一条规则有几个下一跳时结果的先后固定下来（按规则号），面板和测试都好对。
	sort.SliceStable(results, func(i, j int) bool { return results[i]["ruleId"].(int) < results[j]["ruleId"].(int) })
	if len(results) == 0 {
		// 翻转的规则已经不在清单里了（或者还没有任何结论）：没东西可报，记录清掉。
		r.changed = map[int]uint64{}
		if full {
			r.lastSnapshot = now
		}
		return nil
	}
	pending := &routeHopPendingReport{results: results, changed: make(map[int]uint64, len(r.changed)), full: full, at: now}
	for ruleID, seq := range r.changed {
		pending.changed[ruleID] = seq
	}
	r.reporting = true
	return pending
}

// ack 一份上报发完了。ok 才清它带走的翻转、记全量的时刻；失败的留着，退避一下再报。
func (r *routeHopProbeRunner) ack(pending *routeHopPendingReport, ok bool) {
	if pending == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reporting = false
	if !ok {
		// 第一次失败下一拍就重报；连着失败每次翻倍，最长 routeHopReportRetryMax。
		r.reportRetryAt = r.now().Add(r.reportBackoff)
		switch {
		case r.reportBackoff <= 0:
			r.reportBackoff = 2 * routeHopProbeTick
		case r.reportBackoff*2 > routeHopReportRetryMax:
			r.reportBackoff = routeHopReportRetryMax
		default:
			r.reportBackoff *= 2
		}
		return
	}
	r.reportBackoff = 0
	r.reportRetryAt = time.Time{}
	for ruleID, seq := range pending.changed {
		if r.changed[ruleID] == seq {
			delete(r.changed, ruleID)
		}
	}
	if pending.full {
		r.lastSnapshot = pending.at
	}
}

func (r *routeHopProbeRunner) idle() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.states) == 0
}

var agentRouteHopProbes = func() *routeHopProbeRunner {
	runner := newRouteHopProbeRunner()
	runner.jitter = jitterDuration
	return runner
}()

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
	agentRouteHopProbes.run(nil, routeHopProbeSpecsFromState, func(results []map[string]any) error {
		return post(cfg, "/api/agent/route-hop-probes", map[string]any{"results": results}, &map[string]any{})
	})
}

// run 每 routeHopProbeTick 走一拍，直到 stop 关闭（nil = 一直跑）。
func (r *routeHopProbeRunner) run(stop <-chan struct{}, specs func() []ruleLatencyProbe, send func(results []map[string]any) error) {
	ticker := time.NewTicker(routeHopProbeTick)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			r.tick(specs, send)
		}
	}
}

// tick 一拍：同步清单、读真实流量、派探测、有东西就报。每一步都不等网络。
func (r *routeHopProbeRunner) tick(specs func() []ruleLatencyProbe, send func(results []map[string]any) error) {
	r.sync(specs())
	if r.idle() {
		return
	}
	// 读真实流量要跑一次 ss（最长 1.5 秒）：放到后台，别让它卡住这一拍；上一次还没跑完就不再起。
	if r.scanning.CompareAndSwap(false, true) {
		go func() {
			defer r.scanning.Store(false)
			r.scanPassive()
		}()
	}
	r.dispatch()
	if pending := r.pendingReport(); pending != nil {
		go func() {
			err := send(pending.results)
			if err != nil && shouldLogAgentReport("route-hop-probe-report", agentReportLogInterval) {
				logf("route hop probe report failed (will retry): %v", err)
			}
			r.ack(pending, err == nil)
		}()
	}
}
