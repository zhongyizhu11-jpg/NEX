package main

import (
	"fmt"
	"math"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"
)

/*
线路组（一个入口 + 多条路径 + 一个调度策略）在 Agent 这一侧新加的部分：评分、探测样本
窗口、计划切换的预检、按权重分连接、断旧连接，以及随心跳带回去的统计快照。选路本身
还在 main.go 的 failoverProxy 里 —— 这里只是它量「这条线有多好」用的那把尺子。

入口 Agent 不理解「路径」：每条出站在它眼里就是一个要拨的地址（走中转的路径拨的是第一跳
中转上那条中继规则）。路径中段挂了由面板从中转机的探测得知，再作为 failoverTarget.Down
提示下发 —— 所以这里的「能用」= 本机探测通 && 没被面板标掉。
*/

// 评分公式：和 shared/routeScore.ts 逐字一致（运算顺序也一样），两边共用 routeScore.cases.json。
const (
	routeScoreLatencyFullMs = 40
	routeScoreLatencyZeroMs = 400
	routeScoreLossZeroPct   = 4
	routeScoreJitterZeroMs  = 100
)

func clamp01(value float64) float64 {
	if !(value > 0) {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// 0–100 的整数；探不通是 0；还没探出延迟时 ok=false —— 「等评分」和「0 分」是两回事。
func routeScore(latencyMs float64, hasLatency bool, lossPct float64, jitterMs float64, availabilityPct float64, healthy bool) (int, bool) {
	if !healthy {
		return 0, true
	}
	if !hasLatency || math.IsNaN(latencyMs) || math.IsInf(latencyMs, 0) {
		return 0, false
	}
	latency := clamp01((routeScoreLatencyZeroMs-latencyMs)/(routeScoreLatencyZeroMs-routeScoreLatencyFullMs)) * 40
	loss := clamp01(1-lossPct/routeScoreLossZeroPct) * 30
	jitter := clamp01(1-jitterMs/routeScoreJitterZeroMs) * 15
	availability := clamp01(availabilityPct/100) * 15
	return int(math.Round(latency + loss + jitter + availability)), true
}

/*
每条出站的探测样本窗口。

探测 5 秒一次，留最近 10 分钟算延迟（中位数）、丢包、抖动；可用率看最近 1 小时。
中位数而不是平均：一次 2 秒的尖峰会把平均值拉到天上去，而抖动那一项已经在惩罚尖峰了。
*/
const (
	routeSampleWindow       = 120
	routeAvailabilityWindow = 720
)

type routeProbeSample struct {
	ok        bool
	latencyMs int
	at        time.Time
}

type routeTargetStats struct {
	samples      []routeProbeSample
	availability []bool
	// 连续失败次数：探测不通和真实连接拨不通都算一次，一次探测成功或一次正常的真实拨号清零。
	// 「失败 1 次不切、连续失败 N 次才标记异常」看的就是它。
	consecutiveFailures int
	lastProbeOK         bool
	lastProbeAt         time.Time
	// 真实连接的拨号记录（最近 routeDialWindow）：成功、失败、慢；见 recordDial。
	dials []routeDialSample
	// 拨号耗时的折半移动平均 (prev+sample)/2：跟着最近几次走，又不会被一次尖峰带飞。0 = 还没拨过。
	dialAvgMs int
	// 连续几次拨号「慢」了；够 routeSlowDialStreak 次算一次失败并要求立刻探测。
	consecutiveSlow int
	lastDialAt      time.Time
}

/*
真实连接也算票（honk 的思路）：探测 5 秒一次、探的是一个固定端点，而真实连接每时每刻都在
拨，拨的就是业务要走的地址。拨不通本来就记一次失败；这里再补上「拨得慢」—— 连续
routeSlowDialStreak 次比探测延迟慢 routeSlowDialFactor 倍（且不低于 routeSlowDialMinMs），
当作一次失败并立刻探一轮，而不是等下一个 5 秒。一次正常的拨号成功则把连续失败清零：
业务连接都通了，比探测更有说服力。

拨号记录不进探测样本窗口：它不是按固定间隔来的，混进去丢包率和抖动就不准了。
*/
const (
	routeDialWindow     = 10 * time.Minute
	routeDialMaxSamples = 400
	routeSlowDialMinMs  = 500
	routeSlowDialFactor = 3
	routeSlowDialStreak = 3
)

type routeDialSample struct {
	at   time.Time
	ok   bool
	slow bool
	ms   int
}

type routeDialSummary struct {
	ok, failed, slow int
	avgMs            int
	lastAt           time.Time
}

// 这次拨号算不算慢：有探测延迟时按倍数比，没有就只看下限。
func routeDialIsSlow(durationMs int, probeLatencyMs int) bool {
	threshold := routeSlowDialMinMs
	if probeLatencyMs > 0 && probeLatencyMs*routeSlowDialFactor > threshold {
		threshold = probeLatencyMs * routeSlowDialFactor
	}
	return durationMs >= threshold
}

// recordDial 记一次真实拨号。返回 true 表示这次凑够了连续慢拨，调用方该报事件并立刻探测。
func (s *routeTargetStats) recordDial(ok bool, durationMs int, at time.Time, probeLatencyMs int) bool {
	if durationMs < 0 {
		durationMs = 0
	}
	sample := routeDialSample{at: at, ok: ok, ms: durationMs}
	s.lastDialAt = at
	streak := false
	if !ok {
		s.consecutiveFailures++
		s.consecutiveSlow = 0
	} else {
		if s.dialAvgMs <= 0 {
			s.dialAvgMs = durationMs
		} else {
			s.dialAvgMs = (s.dialAvgMs + durationMs) / 2
		}
		sample.slow = routeDialIsSlow(durationMs, probeLatencyMs)
		if sample.slow {
			s.consecutiveSlow++
			if s.consecutiveSlow >= routeSlowDialStreak {
				s.consecutiveSlow = 0
				s.consecutiveFailures++
				streak = true
			}
		} else {
			s.consecutiveSlow = 0
			s.consecutiveFailures = 0
		}
	}
	s.dials = append(s.dials, sample)
	s.pruneDials(at)
	return streak
}

func (s *routeTargetStats) pruneDials(now time.Time) {
	cutoff := now.Add(-routeDialWindow)
	start := 0
	for start < len(s.dials) && s.dials[start].at.Before(cutoff) {
		start++
	}
	if start > 0 {
		s.dials = append([]routeDialSample(nil), s.dials[start:]...)
	}
	if len(s.dials) > routeDialMaxSamples {
		s.dials = s.dials[len(s.dials)-routeDialMaxSamples:]
	}
}

func (s *routeTargetStats) dialSummary(now time.Time) routeDialSummary {
	out := routeDialSummary{}
	if s == nil {
		return out
	}
	s.pruneDials(now)
	for _, sample := range s.dials {
		switch {
		case !sample.ok:
			out.failed++
		case sample.slow:
			out.slow++
			out.ok++
		default:
			out.ok++
		}
	}
	out.avgMs = s.dialAvgMs
	out.lastAt = s.lastDialAt
	return out
}

type routeStatsSummary struct {
	latencyMs       int
	hasLatency      bool
	lossPct         float64
	jitterMs        float64
	availabilityPct float64
	samples         int
}

func (s *routeTargetStats) recordProbe(ok bool, latencyMs int, at time.Time) {
	if latencyMs < 0 {
		latencyMs = 0
	}
	s.samples = append(s.samples, routeProbeSample{ok: ok, latencyMs: latencyMs, at: at})
	if len(s.samples) > routeSampleWindow {
		s.samples = s.samples[len(s.samples)-routeSampleWindow:]
	}
	s.availability = append(s.availability, ok)
	if len(s.availability) > routeAvailabilityWindow {
		s.availability = s.availability[len(s.availability)-routeAvailabilityWindow:]
	}
	s.lastProbeOK = ok
	s.lastProbeAt = at
	if ok {
		s.consecutiveFailures = 0
	} else {
		s.consecutiveFailures++
	}
}

// 真实连接拨不通：算一次失败，但不进样本窗口（见 recordDial）。
func (s *routeTargetStats) recordDialFailure() {
	s.recordDial(false, 0, time.Now(), 0)
}

func (s *routeTargetStats) summary() routeStatsSummary {
	out := routeStatsSummary{availabilityPct: 100}
	if s == nil {
		return out
	}
	out.samples = len(s.samples)
	latencies := make([]int, 0, len(s.samples))
	failed := 0
	var jitterTotal float64
	jitterCount := 0
	previous := -1
	for _, sample := range s.samples {
		if !sample.ok {
			failed++
			previous = -1
			continue
		}
		latencies = append(latencies, sample.latencyMs)
		if previous >= 0 {
			jitterTotal += math.Abs(float64(sample.latencyMs - previous))
			jitterCount++
		}
		previous = sample.latencyMs
	}
	if len(s.samples) > 0 {
		out.lossPct = float64(failed) * 100 / float64(len(s.samples))
	}
	if len(latencies) > 0 {
		sort.Ints(latencies)
		middle := len(latencies) / 2
		if len(latencies)%2 == 0 {
			out.latencyMs = (latencies[middle-1] + latencies[middle]) / 2
		} else {
			out.latencyMs = latencies[middle]
		}
		out.hasLatency = true
	}
	if jitterCount > 0 {
		out.jitterMs = jitterTotal / float64(jitterCount)
	}
	if len(s.availability) > 0 {
		okCount := 0
		for _, ok := range s.availability {
			if ok {
				okCount++
			}
		}
		out.availabilityPct = float64(okCount) * 100 / float64(len(s.availability))
	}
	return out
}

// 换规格时靠它认出「还是同一条出站」：拨的地址和探测地址都没变，健康、样本、活跃线路才能带过去。
func targetStateKey(target failoverTarget) string {
	host, port := target.probeEndpoint()
	return failoverTargetLabel(target) + "|" + host + ":" + strconv.Itoa(port)
}

// 面板下发的中转提示是运行时状态，不进落盘快照：Agent 重启后以面板下一次心跳给的为准。
func stripFailoverRelayHints(spec failoverSpec) failoverSpec {
	targets := make([]failoverTarget, len(spec.Targets))
	copy(targets, spec.Targets)
	for i := range targets {
		targets[i].Down = false
		targets[i].DownReason = ""
	}
	spec.Targets = targets
	return spec
}

// 这条出站此刻能不能用：本机探测通，而且没被面板按「中转异常」标掉。
func (p *failoverProxy) healthyLocked(index int) bool {
	if index < 0 || index >= len(p.spec.Targets) {
		return false
	}
	p.ensureHealthStateLocked()
	return p.targetHealth[index] && !p.relayDown[index]
}

func (p *failoverProxy) statsLocked(index int) *routeTargetStats {
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.stats) {
		return &routeTargetStats{}
	}
	if p.stats[index] == nil {
		p.stats[index] = &routeTargetStats{}
	}
	return p.stats[index]
}

// markDialSuccess 记一次真实连接拨通了：清连续失败；连续几次拨得慢就当一次失败、报事件、立刻探一轮。
func (p *failoverProxy) markDialSuccess(index int, duration time.Duration) {
	p.mu.Lock()
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.spec.Targets) {
		p.mu.Unlock()
		return
	}
	now := time.Now()
	probe := p.scoreInputLocked(index)
	probeMs := 0
	if probe.hasLatency {
		probeMs = probe.latencyMs
	}
	stats := p.statsLocked(index)
	streak := stats.recordDial(true, int(duration/time.Millisecond), now, probeMs)
	if streak {
		target := p.spec.Targets[index]
		reason := fmt.Sprintf("slow dial: %dms x%d, probe %dms", stats.dialAvgMs, routeSlowDialStreak, probeMs)
		logf("failover target slow dials rule=%d source=%d index=%d target=%s:%d %s failures=%d/%d", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, reason, stats.consecutiveFailures, p.spec.FailureThreshold)
		p.recordTargetEventLocked(index, "slow_dial", reason)
	}
	p.mu.Unlock()
	if streak {
		go p.checkHealthShared()
	}
}

// 评分的输入：样本窗口的汇总；还没攒到样本时退回最近一次探测的耗时。
func (p *failoverProxy) scoreInputLocked(index int) routeStatsSummary {
	summary := p.statsLocked(index).summary()
	if !summary.hasLatency && index >= 0 && index < len(p.lastLatencyMs) && p.lastLatencyMs[index] > 0 {
		summary.latencyMs = p.lastLatencyMs[index]
		summary.hasLatency = true
	}
	return summary
}

// 这条出站的评分；ok=false 表示还没法打分。
func (p *failoverProxy) scoreLocked(index int) (int, bool) {
	if index < 0 || index >= len(p.spec.Targets) {
		return 0, false
	}
	summary := p.scoreInputLocked(index)
	return routeScore(float64(summary.latencyMs), summary.hasLatency, summary.lossPct, summary.jitterMs, summary.availabilityPct, p.healthyLocked(index))
}

// 事件和快照里带的分：没法打分记 -1，面板显示成「等评分」。
func (p *failoverProxy) scoreValueLocked(index int) int {
	score, ok := p.scoreLocked(index)
	if !ok {
		return -1
	}
	return score
}

/*
计划切换前的预检：目标线路此刻配不配接流量。

到点切换是人事先定的，可定的时候不知道到点那一刻 B 是什么样。切过去才发现 B 不通、或者
丢包 6%，就是拿一次计划制造一次故障。所以只在预检通过时才切；不通过就记一条「计划切换
未执行」，继续走当前这条，之后每轮探测再试，B 好了就切。

还没探过的出站放行：健康标记默认为真，探测 5 秒内就会来，为这几秒报一条「预检失败」只是噪音。
*/
func (p *failoverProxy) precheckIssueLocked(index int) string {
	if index < 0 || index >= len(p.spec.Targets) {
		return "no such path"
	}
	p.ensureHealthStateLocked()
	if p.relayDown[index] {
		if reason := strings.TrimSpace(p.relayDownReason[index]); reason != "" {
			return "relay down: " + reason
		}
		return "relay down"
	}
	if !p.targetHealth[index] {
		return "unreachable"
	}
	stats := p.statsLocked(index)
	if !stats.lastProbeAt.IsZero() && !stats.lastProbeOK {
		return "unreachable"
	}
	summary := stats.summary()
	if summary.hasLatency && summary.latencyMs >= routeScoreLatencyZeroMs {
		return fmt.Sprintf("latency %dms", summary.latencyMs)
	}
	if summary.samples >= 3 && summary.lossPct >= routeScoreLossZeroPct {
		return fmt.Sprintf("loss %.0f%%", summary.lossPct)
	}
	return ""
}

/*
面板下发的「中转异常」提示变了：不重建代理，只改这几条的可用性，再重新选路。

提示不进签名（见 failoverSignature），所以同一份规格反复下发只会走到这里。变化才记事件：
面板每次心跳都会重发同样的提示。
*/
func (p *failoverProxy) applyRelayHintsLocked(targets []failoverTarget) {
	p.ensureHealthStateLocked()
	reason := ""
	changed := false
	for i, target := range targets {
		if i >= len(p.spec.Targets) {
			break
		}
		down := target.Down
		downReason := strings.TrimSpace(target.DownReason)
		if !down {
			downReason = ""
		}
		if down == p.relayDown[i] && downReason == p.relayDownReason[i] {
			continue
		}
		flipped := down != p.relayDown[i]
		p.relayDown[i] = down
		p.relayDownReason[i] = downReason
		p.spec.Targets[i].Down = down
		p.spec.Targets[i].DownReason = downReason
		if !flipped {
			continue
		}
		changed = true
		if down {
			text := "relay down"
			if downReason != "" {
				text = "relay down: " + downReason
			}
			logf("failover target relay down rule=%d source=%d index=%d target=%s reason=%s", p.ruleID, p.sourcePort, i, failoverTargetLabel(p.spec.Targets[i]), downReason)
			p.recordTargetEventLocked(i, "unhealthy", text)
			if i == p.activeIndex || reason == "" {
				reason = text
			}
		} else {
			logf("failover target relay recovered rule=%d source=%d index=%d target=%s", p.ruleID, p.sourcePort, i, failoverTargetLabel(p.spec.Targets[i]))
			p.recordTargetEventLocked(i, "recovered", "relay recovered")
			if reason == "" {
				reason = "relay recovered"
			}
		}
	}
	if changed {
		p.updateFallbackActiveLocked(reason)
	}
}

/*
原地换规格。

上一版是「一切归零」：健康全部当成好的、活跃线路回到第 0 条。改一下时段表就把正走着
备线的流量拽回主线，而主线可能正挂着 —— 要等下一轮探测才发现。现在按「拨的地址 +
探测地址」认出没变的出站，把它们的健康、样本、连接和「现在走哪条」都带过去；真变了的
才从头来。不在这里重新选路：下一轮探测（5 秒内）会按新规格评估，和以前一样。
*/
func (p *failoverProxy) rebuildForSpecLocked(spec failoverSpec, now time.Time) {
	p.ensureHealthStateLocked()
	oldIndex := map[string]int{}
	for i, target := range p.spec.Targets {
		key := targetStateKey(target)
		if _, seen := oldIndex[key]; !seen {
			oldIndex[key] = i
		}
	}
	activeKey := ""
	if p.activeIndex >= 0 && p.activeIndex < len(p.spec.Targets) {
		activeKey = targetStateKey(p.spec.Targets[p.activeIndex])
	}
	n := len(spec.Targets)
	health := make([]bool, n)
	failureSince := make([]time.Time, n)
	recoveredSince := make([]time.Time, n)
	latency := make([]int, n)
	stats := make([]*routeTargetStats, n)
	relayDown := make([]bool, n)
	relayReason := make([]string, n)
	conns := make([]map[net.Conn]struct{}, n)
	newActive := -1
	for i, target := range spec.Targets {
		health[i] = true
		stats[i] = &routeTargetStats{}
		conns[i] = map[net.Conn]struct{}{}
		key := targetStateKey(target)
		if j, ok := oldIndex[key]; ok {
			health[i] = p.targetHealth[j]
			failureSince[i] = p.failureSince[j]
			recoveredSince[i] = p.recoveredSince[j]
			latency[i] = p.lastLatencyMs[j]
			if p.stats[j] != nil {
				stats[i] = p.stats[j]
			}
			if p.conns[j] != nil {
				conns[i] = p.conns[j]
			}
			if key == activeKey && newActive < 0 {
				newActive = i
			}
		}
		// 新规格里带的中转提示以新的为准。
		relayDown[i] = target.Down
		if target.Down {
			relayReason[i] = strings.TrimSpace(target.DownReason)
		}
	}
	p.spec = spec
	p.targetHealth = health
	p.failureSince = failureSince
	p.recoveredSince = recoveredSince
	p.lastLatencyMs = latency
	p.stats = stats
	p.relayDown = relayDown
	p.relayDownReason = relayReason
	p.conns = conns
	if newActive >= 0 {
		p.activeIndex = newActive
	} else {
		p.activeIndex = 0
		p.activeSince = now
	}
	p.roundRobinNext = 0
	p.fastestCandidate = -1
	p.fastestSince = time.Time{}
	p.prewarmIndex = -1
	p.precheckFailedIndex = -1
	p.pinnedLast = -1
}

// ---- 断旧连接（快速故障转移 / 强制切换） ----

func (p *failoverProxy) trackConn(index int, conn net.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.conns) {
		return
	}
	if p.conns[index] == nil {
		p.conns[index] = map[net.Conn]struct{}{}
	}
	p.conns[index][conn] = struct{}{}
}

func (p *failoverProxy) untrackConn(index int, conn net.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if index >= 0 && index < len(p.conns) && p.conns[index] != nil {
		if _, ok := p.conns[index][conn]; ok {
			delete(p.conns[index], conn)
			return
		}
	}
	/*
		连接建立时记下的下标可能已经过期：换规格时 rebuildForSpecLocked 按「还是同一条出站」
		把连接表搬到了新下标上（比如前面插了一条路径）。按旧下标删不掉的话，这条连接会一直
		算在那条路径名下，面板上的连接数只涨不跌。
	*/
	for i := range p.conns {
		if p.conns[i] == nil {
			continue
		}
		if _, ok := p.conns[i][conn]; ok {
			delete(p.conns[i], conn)
			return
		}
	}
}

// 关掉走这条出站的全部客户端连接；handleConn 里的拷贝随之结束，上游也就一起关了。
func (p *failoverProxy) closeConnsLocked(index int) int {
	if index < 0 || index >= len(p.conns) || len(p.conns[index]) == 0 {
		return 0
	}
	count := 0
	for conn := range p.conns[index] {
		_ = conn.Close()
		count++
	}
	p.conns[index] = map[net.Conn]struct{}{}
	return count
}

func (p *failoverProxy) connectionsLocked(index int) int {
	if index < 0 || index >= len(p.conns) {
		return 0
	}
	return len(p.conns[index])
}

/*
切换时旧连接怎么办，由规格里的 SwitchMode 定：

	smooth  平滑：旧连接留在原线路（默认，也是上一版唯一的行为）
	fast    快速故障转移：只有原线路挂了才断它上面的旧连接 —— 挂了的线路上的连接本来就是死的，
	        断了客户端才会重连到新线路；按计划、按评分的切换仍然平滑
	force   强制：每次切换都断
*/
func (p *failoverProxy) shouldCloseOldConnsLocked(oldIndex int) bool {
	switch p.spec.SwitchMode {
	case "force":
		return true
	case "fast":
		return !p.healthyLocked(oldIndex)
	default:
		return false
	}
}

// ---- 随心跳带回去的统计快照 ----

/*
每条出站此刻的评分和它背后的数（延迟、丢包、抖动、可用率、连续失败、连接数）。

切换事件说的是「换了」，这份快照说的是「为什么是它」：面板的线路面板拿它画每条路径的
「92 优」，也拿它解释「B 比 A 高 14 分，已经持续 2 分钟，再过 1 分钟就切」。
*/
type failoverTargetStatsReport struct {
	Index      int    `json:"index"`
	Target     string `json:"target"`
	Healthy    bool   `json:"healthy"`
	Down       bool   `json:"down,omitempty"`
	DownReason string `json:"downReason,omitempty"`
	// 没法打分是 -1。
	Score               int     `json:"score"`
	LatencyMs           int     `json:"latencyMs"`
	LossPct             float64 `json:"lossPct"`
	JitterMs            float64 `json:"jitterMs"`
	AvailabilityPct     float64 `json:"availabilityPct"`
	ConsecutiveFailures int     `json:"consecutiveFailures"`
	Connections         int     `json:"connections"`
	Samples             int     `json:"samples"`
	LastProbeAt         int64   `json:"lastProbeAt,omitempty"`
	// 真实连接最近 10 分钟的拨号：成功 / 失败 / 慢（慢的也算成功里的）、耗时折半均值、最近一次（Unix 毫秒）。
	DialOK     int   `json:"dialOk"`
	DialFailed int   `json:"dialFailed"`
	DialSlow   int   `json:"dialSlow"`
	DialMs     int   `json:"dialMs,omitempty"`
	LastDialAt int64 `json:"lastDialAt,omitempty"`
}

type failoverStatsReport struct {
	RuleID      int    `json:"ruleId"`
	SourcePort  int    `json:"sourcePort"`
	Strategy    string `json:"strategy"`
	ActiveIndex int    `json:"activeIndex"`
	ActiveSince int64  `json:"activeSince,omitempty"`
	// 正在为计划切换预热的那条；没有是 -1。
	PrewarmIndex int                         `json:"prewarmIndex"`
	Targets      []failoverTargetStatsReport `json:"targets"`
}

func roundTenth(value float64) float64 {
	return math.Round(value*10) / 10
}

func (p *failoverProxy) statsReportLocked() failoverStatsReport {
	p.ensureHealthStateLocked()
	report := failoverStatsReport{
		RuleID:       p.ruleID,
		SourcePort:   p.sourcePort,
		Strategy:     p.spec.Strategy,
		ActiveIndex:  p.activeIndex,
		PrewarmIndex: p.prewarmIndex,
		Targets:      make([]failoverTargetStatsReport, 0, len(p.spec.Targets)),
	}
	if !p.activeSince.IsZero() {
		report.ActiveSince = p.activeSince.UnixMilli()
	}
	for index, target := range p.spec.Targets {
		stats := p.statsLocked(index)
		summary := p.scoreInputLocked(index)
		item := failoverTargetStatsReport{
			Index:               index,
			Target:              failoverTargetLabel(target),
			Healthy:             p.healthyLocked(index),
			Down:                p.relayDown[index],
			DownReason:          p.relayDownReason[index],
			Score:               p.scoreValueLocked(index),
			LatencyMs:           summary.latencyMs,
			LossPct:             roundTenth(summary.lossPct),
			JitterMs:            roundTenth(summary.jitterMs),
			AvailabilityPct:     roundTenth(summary.availabilityPct),
			ConsecutiveFailures: stats.consecutiveFailures,
			Connections:         p.connectionsLocked(index),
			Samples:             summary.samples,
		}
		if !stats.lastProbeAt.IsZero() {
			item.LastProbeAt = stats.lastProbeAt.UnixMilli()
		}
		dials := stats.dialSummary(time.Now())
		item.DialOK, item.DialFailed, item.DialSlow, item.DialMs = dials.ok, dials.failed, dials.slow, dials.avgMs
		if !dials.lastAt.IsZero() {
			item.LastDialAt = dials.lastAt.UnixMilli()
		}
		report.Targets = append(report.Targets, item)
	}
	return report
}

func failoverStatsSnapshot() []failoverStatsReport {
	failoverMu.Lock()
	proxies := make([]*failoverProxy, 0, len(failoverProxies))
	for _, proxy := range failoverProxies {
		proxies = append(proxies, proxy)
	}
	failoverMu.Unlock()
	reports := make([]failoverStatsReport, 0, len(proxies))
	for _, proxy := range proxies {
		proxy.mu.Lock()
		reports = append(reports, proxy.statsReportLocked())
		proxy.mu.Unlock()
	}
	sort.Slice(reports, func(i, j int) bool {
		if reports[i].RuleID != reports[j].RuleID {
			return reports[i].RuleID < reports[j].RuleID
		}
		return reports[i].SourcePort < reports[j].SourcePort
	})
	return reports
}
