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

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
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

防来回漂：一小时里一台出口中断超过 3 次，下一次恢复要坏满 5 分钟才算；
主备里排在前面的那台恢复后也要稳 5 分钟才切回去；刚恢复的 1 分钟里慢慢加量。

目标本身挂了（每台出口到它都不通）时不再挨个出口重放：一条连接只试一台、轮着来（targetDownEverywhere）。
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
	// outages：最近一小时里每次「好 → 坏」的时刻，抖动抑制按它数（见 flapDamper）。
	outages []time.Time

	lastSampleAt time.Time
	probing      bool

	// cached：窗口没变时 stats 直接给上次算的。挑一次出口要问好几遍（折算、延迟、上报），
	// 以前每问一遍都排两次序、分配四五块内存，全在规则锁里（路线图 X12）。
	cached   targetStats
	cachedOK bool
}

type targetStats struct {
	median  float64
	jitter  float64
	loss    float64
	samples int
}

func (h *targetHealth) stats() targetStats {
	if h.cachedOK {
		return h.cached
	}
	var oks [fxpTargetWindow]float64
	n, failures := 0, 0
	for i := 0; i < h.count; i++ {
		sample := h.samples[(h.pos-h.count+i+fxpTargetWindow)%fxpTargetWindow]
		if !sample.ok {
			failures++
			continue
		}
		oks[n] = sample.ms
		n++
	}
	stats := targetStats{samples: h.count}
	if h.count > 0 {
		stats.loss = float64(failures) / float64(h.count)
	}
	if n > 0 {
		sorted := oks[:n]
		sort.Float64s(sorted)
		middle := n / 2
		if n%2 == 0 {
			stats.median = (sorted[middle-1] + sorted[middle]) / 2
		} else {
			stats.median = sorted[middle]
		}
		/*
			抖动（2.2.143 起）：以前是「相邻两次的差的平均」，一次 1 秒的重发就把它拉高几十毫秒。现在是「比这条路最低延迟
			高出多少」的 90 分位 —— 排队造成的那部分，偶尔一个尖峰不影响。排好序之后最低的就是第一个，
			「高出多少」的次序和延迟本身的次序一样，不用再排一遍。
		*/
		if n >= 3 {
			index := int(math.Ceil(float64(n)*0.9)) - 1
			if index < 0 {
				index = 0
			}
			stats.jitter = sorted[index] - sorted[0]
		}
	}
	h.cached, h.cachedOK = stats, true
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

/*
抖动抑制（lbcore.FlapDamper，和线路组同一套计数）：一小时里中断超过 fxpTargetFlapLimit 次，下一次恢复要坏满
5 分钟才算，「稳回来」也要稳够 5 分钟。上限就是 5 分钟、不翻倍：它压的是「恢复」，压太久等于把一台好出口长期排除在外。

记的是中断（好 → 坏）。以前「不稳」「稳回来」也各记一次翻转：一次 20 秒的中断被数成 4 次（坏、好、不稳、稳），
这台出口直接进「抖动放慢」（路线图 X9）。「不稳」是另一回事（按抖动 / 丢包少分），不算中断。
*/
var fxpTargetFlapPolicy = lbcore.FlapPolicy{Window: fxpTargetFlapWindow, Threshold: fxpTargetFlapLimit + 1, Base: fxpTargetFlapHold, Max: fxpTargetFlapHold}

func (h *targetHealth) flapDamper() lbcore.FlapDamper {
	return lbcore.FlapDamper{Policy: fxpTargetFlapPolicy, Events: h.outages}
}

// flapping：这台出口到目标此刻是不是在来回断（一小时里中断超过 fxpTargetFlapLimit 次）。
func (h *targetHealth) flapping(now time.Time) bool {
	damper := h.flapDamper()
	return damper.Flapping(now)
}

// keepRecent：窗口里只留最近 keep 个样本。
func (h *targetHealth) keepRecent(keep int) {
	if keep >= h.count {
		return
	}
	var kept [fxpTargetWindow]targetSample
	for i := 0; i < keep; i++ {
		kept[i] = h.samples[(h.pos-keep+i+fxpTargetWindow)%fxpTargetWindow]
	}
	h.samples = kept
	h.count = keep
	h.pos = keep % fxpTargetWindow
	h.cachedOK = false
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
	h.cachedOK = false
	h.lastSampleAt = now
	change := ""
	if ok {
		h.consecOK++
		h.consecFail = 0
		damper := h.flapDamper()
		if h.down && h.consecOK >= d.recover && !damper.Holding(now, h.downAt, 0, false) {
			h.down = false
			h.upAt = now
			change = "recovered"
			/*
				刚恢复：窗口里只留让它恢复的那几次成功。中断期间那几次失败留在 30 个样本的窗口里，丢包率要过
				一分多钟才掉回门槛以下 —— 目标早就好了，这台出口还被当成「不稳」少分 / 切走（路线图 X9）。
				「不稳」的计时也从头来：恢复之后真抖，照样要抖够「持续多久」才算。
			*/
			h.keepRecent(h.consecOK)
			h.unstable = false
			h.unstableSince = time.Time{}
			h.stableSince = now
		}
	} else {
		h.consecFail++
		h.consecOK = 0
		if !h.down && h.consecFail >= d.fail {
			h.down = true
			h.downAt = now
			damper := h.flapDamper()
			damper.Note(now)
			h.outages = damper.Events
			change = "down"
		}
	}
	if d.action == "ignore" {
		h.unstable = false
		return change
	}
	if h.down {
		// 坏着的时候不评「稳不稳」：那几次不通已经算在「坏」里了，不再另记一笔。
		h.unstableSince = time.Time{}
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
		damper := h.flapDamper()
		if flap := damper.Hold(now); flap > hold {
			hold = flap
		}
		if h.unstable && now.Sub(h.stableSince) >= hold {
			h.unstable = false
			h.upAt = now
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

// fxpTargetDownFresh：「到目标不通」的结论多久之内算新鲜。坏着的出口最慢 60 秒探一次（targetProbeInterval），
// 超过这么久没有新样本说明探测停了，不拿旧结论去拦用户的连接。
const fxpTargetDownFresh = 90 * time.Second

// targetDownOnAllLocked：候选的出口到目标全都不通，而且都是刚测的 —— 目标本身挂了。调用方持锁。
func (s *exitEndpointSelector) targetDownOnAllLocked(candidates []int, now time.Time) bool {
	if !s.targetAware() || len(candidates) == 0 {
		return false
	}
	for _, index := range candidates {
		if !s.target.supported[index] {
			return false
		}
		health := s.target.health[index]
		if !health.down || now.Sub(health.lastSampleAt) > fxpTargetDownFresh {
			return false
		}
	}
	return true
}

/*
targetDownEverywhere：目标本身挂了（现在能用的出口到它全都不通）。

这时换出口重放没有意义：以前每条新连接照样挨个出口重放一遍，3 台出口就是 3 次目标拨号；目标是「连接超时」
那种挂法时，客户端要等 3×4 秒才收到失败，出口那边同时压着 3 倍的半开连接（路线图 X8）。现在只试挑中的那一台
（chooseLocked 里轮着挑），不通就直接告诉客户端。目标回来由这一次尝试、或者后台探测发现。
*/
func (s *exitEndpointSelector) targetDownEverywhere() bool {
	if !s.targetAware() {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	candidates, level := s.candidatesLocked(nil, now, false)
	return level == lbcore.LevelPanic && s.targetDownOnAllLocked(candidates, now)
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
		if !health.lastSampleAt.IsZero() && now.Sub(health.lastSampleAt) < targetProbeInterval(health, s.target.detect) {
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

/*
targetProbeInterval（2.2.144 起）：判成连不上的出口，探测间隔每多失败一次翻一倍，最长 60 秒。目标是高防时，
一直每几秒连一次、连上就断，像扫描，会让对方一直拦着这台出口的 IP，永远恢复不了；慢下来让拦截有机会过期。
恢复最多晚一分钟发现。
*/
const fxpTargetProbeBackoffMax = 60 * time.Second

func targetProbeInterval(health *targetHealth, detect balanceDetect) time.Duration {
	interval := detect.interval
	// 没坏的照常探。坏着、但刚探通了一次的也回到平常的间隔：目标多半回来了，接着探两次就能确认，
	// 不要再等一个翻过倍的间隔（一次 20 秒的中断，以前目标回来后还要十几秒才恢复，路线图 X9）。
	if !health.down || health.consecOK > 0 {
		return interval
	}
	extra := health.consecFail - detect.fail
	if extra < 0 {
		extra = 0
	}
	for step := 0; step <= extra && interval < fxpTargetProbeBackoffMax; step++ {
		interval *= 2
	}
	if interval > fxpTargetProbeBackoffMax {
		interval = fxpTargetProbeBackoffMax
	}
	return interval
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
