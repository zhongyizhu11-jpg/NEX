package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"sync"
	"time"
)

/*
「出口连得上目标吗」—— 负载均衡按「出口 + 目标」记健康（2.2.142 起）。

以前入口只知道「出口机本身通不通」：出口连目标失败时直接把会话关掉，入口看到的是握手成功、
出口健康，于是照样往那台出口送。实际例子：三台出口里一台到某个落地丢包 8%、建连常常要 1 秒，
规则的延迟图满屏尖峰，负载均衡却一直没换机器。

现在：

  1. 出口回话。入口的 hello 带 targetStatus，出口连完目标先回一帧（targetStatusMagic + JSON），
     写上连上没有、用了多久。老出口不认识这个字段，照旧不回 —— 入口只对面板标了 targetStatus 的
     出口等这一帧。
  2. 当场换出口。这一帧到之前，入口把发出去的内容留着（和握手确认之前一样，selected_transport.go
     的重放缓存）；回的是「连不上」就换下一台出口重放，用户那边感觉不到。
  3. 按出口 + 目标记账。每个选择器（一条规则一个，目标是固定的）给每台出口留最近 30 次的结果：
     连续几次不通算坏、坏了要连续通几次才算好；延迟的中位数、抖动（相邻两次差的平均）、丢包率。
     抖动或丢包持续够久算「不稳」，按面板设的动作少分 / 切走 / 不管。
  4. 主动探。这条规则最近有人用、或者有出口正坏着，就按「多久探一次」让每台出口连一下目标
     （targetProbe：连上就回话、就关，不转发）。真实连接本身也是样本，刚有样本的不再额外探。

防来回漂：一小时里一台出口好坏翻转超过 3 次，下一次恢复要稳 5 分钟才算；主备里排在前面的
那台恢复后也要稳 5 分钟才切回去；刚恢复的 1 分钟里慢慢加量。
*/

var targetStatusMagic = []byte("\x00\x00FXPTS1")

type targetStatusFrame struct {
	OK    bool   `json:"ok"`
	Ms    int    `json:"ms,omitempty"`
	Error string `json:"error,omitempty"`
}

func encodeTargetStatus(ok bool, elapsed time.Duration, err error) []byte {
	frame := targetStatusFrame{OK: ok, Ms: int(math.Round(float64(elapsed) / float64(time.Millisecond)))}
	if err != nil {
		frame.Error = err.Error()
		if len(frame.Error) > 160 {
			frame.Error = frame.Error[:160]
		}
	}
	body, _ := json.Marshal(frame)
	return append(append([]byte(nil), targetStatusMagic...), body...)
}

// decodeTargetStatus 认不出（不是这个前缀）时 ok=false：说明对端没回结果、直接就是数据。
func decodeTargetStatus(frame []byte) (targetStatusFrame, bool) {
	if !bytes.HasPrefix(frame, targetStatusMagic) {
		return targetStatusFrame{}, false
	}
	var status targetStatusFrame
	if err := json.Unmarshal(frame[len(targetStatusMagic):], &status); err != nil {
		return targetStatusFrame{}, false
	}
	return status, true
}

func writeTargetStatus(sec frameConn, ok bool, elapsed time.Duration, err error) error {
	return sec.writeFrame(encodeTargetStatus(ok, elapsed, err))
}

const (
	fxpTargetDialTimeoutDefault = 4 * time.Second
	fxpTargetDialTimeoutMax     = 10 * time.Second
)

// exitTargetDialTimeout：入口还有别的出口可换时它会让出口别等满 10 秒（hello.TargetDialTimeoutMs）。
func exitTargetDialTimeout(hello helloFrame) time.Duration {
	if hello.TargetDialTimeoutMs > 0 {
		timeout := time.Duration(hello.TargetDialTimeoutMs) * time.Millisecond
		if timeout < time.Second {
			timeout = time.Second
		}
		if timeout > fxpTargetDialTimeoutMax {
			timeout = fxpTargetDialTimeoutMax
		}
		return timeout
	}
	return fxpTargetDialTimeoutMax
}

// handleExitTargetProbe：只连一下目标、回一帧结果。不记流量，不转发。
func handleExitTargetProbe(sec frameConn, hello helloFrame, cfg config) error {
	timeout := exitTargetDialTimeout(hello)
	if hello.TargetDialTimeoutMs <= 0 {
		timeout = fxpTargetDialTimeoutDefault
	}
	started := time.Now()
	target, err := dialExitTargetFor(cfg, hello, timeout)
	elapsed := time.Since(started)
	if err == nil {
		_ = target.Close()
	}
	return writeTargetStatus(sec, err == nil, elapsed, err)
}

/* ───────────────────────── 检测参数 ───────────────────────── */

// balanceDetectConfig：面板「检测与切换」（shared/loadBalance.ts 的 BalanceDetect），原样下发。
type balanceDetectConfig struct {
	IntervalSeconds   int    `json:"intervalSeconds,omitempty"`
	FailThreshold     int    `json:"failThreshold,omitempty"`
	RecoverThreshold  int    `json:"recoverThreshold,omitempty"`
	LatencyMarginMs   int    `json:"latencyMarginMs,omitempty"`
	JitterMs          int    `json:"jitterMs,omitempty"`
	JitterHoldSeconds int    `json:"jitterHoldSeconds,omitempty"`
	JitterAction      string `json:"jitterAction,omitempty"`
	SlowStart         *bool  `json:"slowStart,omitempty"`
}

type balanceDetect struct {
	interval   time.Duration
	fail       int
	recover    int
	margin     float64 // ms
	jitter     float64 // ms
	jitterHold time.Duration
	action     string // reduce / switch / ignore
	slowStart  bool
}

const (
	fxpTargetWindow             = 30
	fxpTargetReducedShare       = 0.25
	fxpTargetLossUnstable       = 0.1 // 最近的探测里一成以上不通，和抖动一样算「不稳」
	fxpTargetLossMinSamples     = 10
	fxpTargetSlowStartWindow    = 60 * time.Second
	fxpTargetFailbackStable     = 5 * time.Minute
	fxpTargetFlapWindow         = time.Hour
	fxpTargetFlapLimit          = 3
	fxpTargetFlapHold           = 5 * time.Minute
	fxpTargetActiveWindow       = 5 * time.Minute
	fxpTargetProbeReplyGrace    = 2 * time.Second
	fxpTargetUnstableClearRatio = 0.7 // 抖动回到门槛的七成以下才算稳回来，免得卡在门槛上来回翻
)

func clampDetect(value, fallback, min, max int) int {
	if value <= 0 {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func resolveBalanceDetect(c *balanceDetectConfig) balanceDetect {
	d := balanceDetect{interval: 2 * time.Second, fail: 2, recover: 3, margin: 50, jitter: 30, jitterHold: 30 * time.Second, action: "reduce", slowStart: true}
	if c == nil {
		return d
	}
	d.interval = time.Duration(clampDetect(c.IntervalSeconds, 2, 1, 60)) * time.Second
	d.fail = clampDetect(c.FailThreshold, 2, 1, 10)
	d.recover = clampDetect(c.RecoverThreshold, 3, 1, 10)
	d.margin = float64(clampDetect(c.LatencyMarginMs, 50, 10, 2000))
	d.jitter = float64(clampDetect(c.JitterMs, 30, 5, 1000))
	d.jitterHold = time.Duration(clampDetect(c.JitterHoldSeconds, 30, 5, 600)) * time.Second
	switch c.JitterAction {
	case "reduce", "switch", "ignore":
		d.action = c.JitterAction
	}
	if c.SlowStart != nil {
		d.slowStart = *c.SlowStart
	}
	return d
}

/* ───────────────────────── 一台出口到这个目标 ───────────────────────── */

type targetSample struct {
	ms float64
	ok bool
}

type targetHealth struct {
	samples [fxpTargetWindow]targetSample
	count   int
	pos     int

	consecFail int
	consecOK   int
	down       bool
	downAt     time.Time
	upAt       time.Time // 最近一次从坏恢复（慢启动、主备切回都看它）

	unstable      bool
	unstableSince time.Time // 指标超过门槛的起点（还没满「持续多久」时也记着）
	stableSince   time.Time // 指标回到门槛以下的起点
	flips         []time.Time

	lastSampleAt time.Time
	probing      bool
}

type targetStats struct {
	median  float64
	jitter  float64
	loss    float64
	samples int
}

func (h *targetHealth) stats() targetStats {
	var oks []float64
	failures := 0
	order := make([]targetSample, 0, h.count)
	for i := 0; i < h.count; i++ {
		// 从最旧到最新
		index := (h.pos - h.count + i + fxpTargetWindow) % fxpTargetWindow
		order = append(order, h.samples[index])
	}
	for _, sample := range order {
		if !sample.ok {
			failures++
			continue
		}
		oks = append(oks, sample.ms)
	}
	stats := targetStats{samples: h.count}
	if h.count > 0 {
		stats.loss = float64(failures) / float64(h.count)
	}
	if len(oks) > 0 {
		sorted := append([]float64(nil), oks...)
		sort.Float64s(sorted)
		middle := len(sorted) / 2
		if len(sorted)%2 == 0 {
			stats.median = (sorted[middle-1] + sorted[middle]) / 2
		} else {
			stats.median = sorted[middle]
		}
	}
	/*
		抖动（2.2.143 起）：以前是「相邻两次的差的平均」，一次 1 秒的重发就把它拉高几十毫秒。现在是「比这条路最低延迟
		高出多少」的 90 分位 —— 排队造成的那部分，偶尔一个尖峰不影响。
	*/
	if len(oks) >= 3 {
		floor := oks[0]
		for _, ms := range oks {
			if ms < floor {
				floor = ms
			}
		}
		queue := make([]float64, 0, len(oks))
		for _, ms := range oks {
			queue = append(queue, ms-floor)
		}
		sort.Float64s(queue)
		index := int(math.Ceil(float64(len(queue))*0.9)) - 1
		if index < 0 {
			index = 0
		}
		stats.jitter = queue[index]
	}
	return stats
}

// windowFloor：窗口里成功的那几次的最低延迟（没有返回 0）。
func (h *targetHealth) windowFloor() float64 {
	floor := 0.0
	for i := 0; i < h.count; i++ {
		sample := h.samples[(h.pos-h.count+i+fxpTargetWindow)%fxpTargetWindow]
		if sample.ok && sample.ms > 0 && (floor == 0 || sample.ms < floor) {
			floor = sample.ms
		}
	}
	return floor
}

// fxpTargetRetransmitMs：连目标拖到这么久才连上，多半是握手包丢了、系统 1 秒后重发的那一次。
const fxpTargetRetransmitMs = 900.0

func (h *targetHealth) flip(now time.Time) {
	h.flips = append(h.flips, now)
	kept := h.flips[:0]
	for _, at := range h.flips {
		if now.Sub(at) <= fxpTargetFlapWindow {
			kept = append(kept, at)
		}
	}
	h.flips = kept
}

func (h *targetHealth) flapping() bool {
	return len(h.flips) > fxpTargetFlapLimit
}

// observe 记一次结果，返回状态有没有变（变了要打日志）。
func (h *targetHealth) observe(ok bool, ms float64, now time.Time, d balanceDetect) string {
	/*
		连上了、但拖到「握手包丢了、系统 1 秒后重发」那么久（≥ 900ms，并且超过这条路最低延迟的 3 倍）：记成一次丢包，
		不记成 1000ms 的延迟（2.2.143 起）。它毕竟连上了，不算「连不上目标」，不推着往坏里翻。
	*/
	sampleOK := ok
	if ok && ms >= fxpTargetRetransmitMs {
		if floor := h.windowFloor(); floor > 0 && ms >= floor*3 {
			sampleOK = false
		}
	}
	h.samples[h.pos] = targetSample{ms: ms, ok: sampleOK}
	h.pos = (h.pos + 1) % fxpTargetWindow
	if h.count < fxpTargetWindow {
		h.count++
	}
	h.lastSampleAt = now
	change := ""
	if ok {
		h.consecOK++
		h.consecFail = 0
		if h.down && h.consecOK >= d.recover && (!h.flapping() || now.Sub(h.downAt) >= fxpTargetFlapHold) {
			h.down = false
			h.upAt = now
			h.flip(now)
			change = "recovered"
		}
	} else {
		h.consecFail++
		h.consecOK = 0
		if !h.down && h.consecFail >= d.fail {
			h.down = true
			h.downAt = now
			h.flip(now)
			change = "down"
		}
	}
	if d.action == "ignore" {
		h.unstable = false
		return change
	}
	stats := h.stats()
	over := stats.jitter > d.jitter || (stats.samples >= fxpTargetLossMinSamples && stats.loss >= fxpTargetLossUnstable)
	calm := stats.jitter <= d.jitter*fxpTargetUnstableClearRatio && (stats.samples < fxpTargetLossMinSamples || stats.loss < fxpTargetLossUnstable/2)
	switch {
	case over:
		h.stableSince = time.Time{}
		if h.unstableSince.IsZero() {
			h.unstableSince = now
		}
		if !h.unstable && now.Sub(h.unstableSince) >= d.jitterHold {
			h.unstable = true
			h.flip(now)
			if change == "" {
				change = "unstable"
			}
		}
	case calm:
		h.unstableSince = time.Time{}
		if h.stableSince.IsZero() {
			h.stableSince = now
		}
		hold := d.jitterHold
		if h.flapping() && hold < fxpTargetFlapHold {
			hold = fxpTargetFlapHold
		}
		if h.unstable && now.Sub(h.stableSince) >= hold {
			h.unstable = false
			h.upAt = now
			h.flip(now)
			if change == "" {
				change = "stable"
			}
		}
	default:
		// 在两条线之间：保持现状，两个起点都不动。
	}
	return change
}

/* ───────────────────────── 选择器上的那一份 ───────────────────────── */

// targetAwareness 挂在一个选择器（一条规则）上：每台出口到这条规则的目标的健康。
type targetAwareness struct {
	detect     balanceDetect
	health     []*targetHealth
	supported  []bool
	lastUsedAt time.Time
	cfg        config
	active     bool
}

func newTargetAwareness(endpoints []exitEndpoint, detect *balanceDetectConfig) *targetAwareness {
	supported := make([]bool, len(endpoints))
	reports := false
	for i, endpoint := range endpoints {
		supported[i] = endpoint.TargetStatus
		reports = reports || endpoint.TargetStatus
	}
	// 只有一台出口时没得换，记了也没用。
	if !reports || len(endpoints) < 2 {
		return nil
	}
	health := make([]*targetHealth, len(endpoints))
	for i := range health {
		health[i] = &targetHealth{}
	}
	return &targetAwareness{detect: resolveBalanceDetect(detect), health: health, supported: supported}
}

func (s *exitEndpointSelector) targetAware() bool {
	return s != nil && s.target != nil
}

func (s *exitEndpointSelector) endpointReportsTarget(index int) bool {
	return s.targetAware() && index >= 0 && index < len(s.target.supported) && s.target.supported[index]
}

// observeTarget 记一次「这台出口连这个目标」的结果（真实连接或主动探测）。
func (s *exitEndpointSelector) observeTarget(index int, ok bool, elapsed time.Duration) {
	if !s.endpointReportsTarget(index) {
		return
	}
	now := time.Now()
	s.mu.Lock()
	health := s.target.health[index]
	change := health.observe(ok, float64(elapsed)/float64(time.Millisecond), now, s.target.detect)
	endpoint := s.endpoints[index]
	var stats targetStats
	if change != "" {
		stats = health.stats()
	}
	cfg := s.target.cfg
	s.mu.Unlock()
	if change != "" {
		log.Printf("entry exit target %s tunnel=%d rule=%d exit=%s:%d target=%s:%d median=%.0fms jitter=%.0fms loss=%.0f%%",
			change, cfg.TunnelID, cfg.RuleID, endpoint.Host, endpoint.Port, cfg.TargetIP, cfg.TargetPort, stats.median, stats.jitter, stats.loss*100)
	}
}

// targetFactorsLocked：每个候选这次该按几成算（0 = 这次别给它）。全被排除时返回 nil —— 那是目标
// 本身有问题，换哪台都一样，照原来的办法挑（不然等于直接断服）。调用方持锁。
func (s *exitEndpointSelector) targetFactorsLocked(candidates []int, now time.Time) map[int]float64 {
	if !s.targetAware() || len(candidates) < 2 {
		return nil
	}
	d := s.target.detect
	factors := make(map[int]float64, len(candidates))
	medians := make(map[int]float64, len(candidates))
	best := 0.0
	usable := 0
	for _, index := range candidates {
		if !s.target.supported[index] {
			factors[index] = 1
			usable++
			continue
		}
		health := s.target.health[index]
		if health.down {
			factors[index] = 0
			continue
		}
		factor := 1.0
		if health.unstable {
			switch d.action {
			case "switch":
				factor = 0
			case "reduce":
				factor = fxpTargetReducedShare
			}
		}
		if d.slowStart && !health.upAt.IsZero() {
			if since := now.Sub(health.upAt); since < fxpTargetSlowStartWindow {
				factor *= math.Max(0.1, float64(since)/float64(fxpTargetSlowStartWindow))
			}
		}
		factors[index] = factor
		if factor > 0 {
			usable++
		}
		if stats := health.stats(); stats.median > 0 {
			medians[index] = stats.median
			if best == 0 || stats.median < best {
				best = stats.median
			}
		}
	}
	if usable == 0 {
		// 「切走」把剩下的都切光了：退一步，只排除真坏的。
		for _, index := range candidates {
			if s.target.supported[index] && !s.target.health[index].down {
				factors[index] = fxpTargetReducedShare
				usable++
			}
		}
		if usable == 0 {
			return nil
		}
	}
	// 自动 / 延迟优先：比最快的那台慢出门槛的少分一半。
	if s.strategy == "auto" || s.strategy == "latency" {
		for index, median := range medians {
			if factors[index] > 0 && best > 0 && median-best > d.margin {
				factors[index] *= 0.5
			}
		}
	}
	return factors
}

func filterByFactor(candidates []int, factors map[int]float64) []int {
	if factors == nil {
		return candidates
	}
	kept := make([]int, 0, len(candidates))
	for _, index := range candidates {
		if factors[index] > 0 {
			kept = append(kept, index)
		}
	}
	if len(kept) == 0 {
		return candidates
	}
	return kept
}

// fallbackUsableLocked：主备时这一台能不能当「当前这台」。坏了、不稳（动作不是「不管」）、
// 刚恢复还没稳够 5 分钟的，后面还有好的就先跳过。调用方持锁。
func (s *exitEndpointSelector) fallbackUsableLocked(index int, now time.Time) bool {
	if !s.endpointReportsTarget(index) {
		return true
	}
	health := s.target.health[index]
	if health.down {
		return false
	}
	if health.unstable && s.target.detect.action != "ignore" {
		return false
	}
	if !health.upAt.IsZero() && now.Sub(health.upAt) < fxpTargetFailbackStable {
		return false
	}
	return true
}

// targetLatencyLocked：到目标的延迟中位数（ms），没样本时 0。调用方持锁。
func (s *exitEndpointSelector) targetLatencyLocked(index int) (median, jitter float64) {
	if !s.endpointReportsTarget(index) {
		return 0, 0
	}
	stats := s.target.health[index].stats()
	return stats.median, stats.jitter
}

/* ───────────────────────── 主动探 ───────────────────────── */

var fxpTargetSelectors = struct {
	mu        sync.Mutex
	selectors map[*exitEndpointSelector]struct{}
}{selectors: map[*exitEndpointSelector]struct{}{}}

func registerTargetSelector(s *exitEndpointSelector, cfg config) func() {
	if !s.targetAware() {
		return func() {}
	}
	s.mu.Lock()
	s.target.cfg = cfg
	s.target.active = true
	s.mu.Unlock()
	fxpTargetSelectors.mu.Lock()
	fxpTargetSelectors.selectors[s] = struct{}{}
	fxpTargetSelectors.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			fxpTargetSelectors.mu.Lock()
			delete(fxpTargetSelectors.selectors, s)
			fxpTargetSelectors.mu.Unlock()
			s.mu.Lock()
			s.target.active = false
			s.mu.Unlock()
		})
	}
}

// noteTargetUse：这条规则刚有人用（主动探只在最近 5 分钟有人用、或有出口坏着时才做）。
func (s *exitEndpointSelector) noteTargetUse(now time.Time) {
	if !s.targetAware() {
		return
	}
	s.mu.Lock()
	s.target.lastUsedAt = now
	s.mu.Unlock()
}

// maintainTargetProbes 由端点维护循环每秒调一次。
func maintainTargetProbes(now time.Time) {
	fxpTargetSelectors.mu.Lock()
	selectors := make([]*exitEndpointSelector, 0, len(fxpTargetSelectors.selectors))
	for selector := range fxpTargetSelectors.selectors {
		selectors = append(selectors, selector)
	}
	fxpTargetSelectors.mu.Unlock()
	for _, selector := range selectors {
		selector.dispatchTargetProbes(now)
	}
}

func (s *exitEndpointSelector) dispatchTargetProbes(now time.Time) {
	type job struct {
		index    int
		endpoint exitEndpoint
	}
	var jobs []job
	s.mu.Lock()
	if s.target == nil || !s.target.active {
		s.mu.Unlock()
		return
	}
	anyDown := false
	for i, health := range s.target.health {
		if s.target.supported[i] && (health.down || health.unstable) {
			anyDown = true
		}
	}
	recentlyUsed := !s.target.lastUsedAt.IsZero() && now.Sub(s.target.lastUsedAt) <= fxpTargetActiveWindow
	if !recentlyUsed && !anyDown {
		s.mu.Unlock()
		return
	}
	for i, health := range s.target.health {
		if !s.target.supported[i] || health.probing {
			continue
		}
		if !health.lastSampleAt.IsZero() && now.Sub(health.lastSampleAt) < s.target.detect.interval {
			continue
		}
		health.probing = true
		jobs = append(jobs, job{index: i, endpoint: s.endpoints[i]})
	}
	cfg := s.target.cfg
	s.mu.Unlock()
	for _, item := range jobs {
		go s.runTargetProbe(item.index, item.endpoint, cfg)
	}
}

func (s *exitEndpointSelector) runTargetProbe(index int, endpoint exitEndpoint, cfg config) {
	defer func() {
		s.mu.Lock()
		if s.target != nil && index < len(s.target.health) {
			s.target.health[index].probing = false
		}
		s.mu.Unlock()
	}()
	status, err := probeEndpointTarget(s.states[index], endpoint, cfg)
	if err != nil {
		// 到出口这一跳都没通：那是出口本身的事，端点健康会去管，这里不算「连不上目标」。
		return
	}
	s.observeTarget(index, status.OK, time.Duration(status.Ms)*time.Millisecond)
}

// probeEndpointTarget：拿一条到出口的连接（池里的或现拨），发 targetProbe，读它回的那一帧。
func probeEndpointTarget(state *fxpEndpointState, endpoint exitEndpoint, cfg config) (targetStatusFrame, error) {
	dialCfg := cfg
	if endpoint.Key != "" {
		dialCfg.Key = endpoint.Key
	}
	var (
		sec       *secureConn
		closeConn func()
		err       error
	)
	if v3Enabled(dialCfg) {
		conn, v3sec, _, dialErr := dialV3Transport(state, endpoint.Host, endpoint.Port, dialCfg)
		if dialErr != nil {
			return targetStatusFrame{}, dialErr
		}
		sec, closeConn = v3sec, func() { _ = conn.Close() }
	} else if conn, pooled, ok := state.take(dialCfg); ok {
		sec, closeConn = pooled, func() { _ = conn.Close() }
	} else {
		conn, fresh, dialErr := dialSecureTCPFresh(endpoint.Host, endpoint.Port, dialCfg)
		if dialErr != nil {
			return targetStatusFrame{}, dialErr
		}
		sec, closeConn = fresh, func() { _ = conn.Close() }
	}
	defer closeConn()
	hello, _ := json.Marshal(helloFrame{
		Network:             "tcp",
		TargetIP:            cfg.TargetIP,
		TargetPort:          cfg.TargetPort,
		TunnelID:            cfg.TunnelID,
		RuleID:              cfg.RuleID,
		TargetStatus:        true,
		TargetProbe:         true,
		TargetDialTimeoutMs: int(fxpTargetDialTimeoutDefault / time.Millisecond),
	})
	if err = writeSecureFramesWithDeadline(sec, hello); err != nil {
		return targetStatusFrame{}, err
	}
	_ = sec.conn.SetReadDeadline(time.Now().Add(fxpTargetDialTimeoutDefault + fxpTargetProbeReplyGrace))
	frame, err := sec.readFrame()
	if err != nil {
		return targetStatusFrame{}, err
	}
	status, ok := decodeTargetStatus(frame)
	if !ok {
		return targetStatusFrame{}, errors.New("exit did not answer the target probe")
	}
	return status, nil
}

// targetStatusError：出口回「连不上目标」时交给重放切换的错误。
type targetStatusError struct {
	message string
}

func (e *targetStatusError) Error() string {
	return fmt.Sprintf("exit could not reach target: %s", e.message)
}
