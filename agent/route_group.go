package main

import (
	"fmt"
	"math"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
线路组（一个入口 + 多条路径 + 一个调度策略）在 Agent 这一侧新加的部分：评分、探测样本
窗口、计划切换的预检、按权重分连接、断旧连接，以及随心跳带回去的统计快照。选路本身
还在 failoverProxy 里 —— 这里是它量「这条线有多好」用的样本，「有多好」的算法在 lbcore（Quality、QualityCost）。

入口 Agent 不理解「路径」：每条出站在它眼里就是一个要拨的地址（走中转的路径拨的是第一跳
中转上那条中继规则）。路径中段挂了由面板从中转机的探测得知，再作为 failoverTarget.Down
提示下发 —— 所以这里的「能用」= 本机探测通 && 没被面板标掉。
*/

/*
计划切换的预检门槛（precheckIssueLocked）：延迟到这么高、丢包到这么多，就不按计划切过去。
*/
const (
	routePrecheckLatencyMs = 400
	routePrecheckLossPct   = 4
)

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
	// 新连接「上游回之前就关」的计数（failover_early_close.go）；正常回了就清零，拨号成功不清。
	earlyClose   failoverEarlyCloseState
	samples      []routeProbeSample
	availability []bool
	/*
		连续失败分两本账（A2）：探测不通记 probeFailures，真实连接拨不通记 dialFailures。
		以前是一个数，探测成功和拨号成功都清零 —— 探测目标（落地上的某个端口）已经死了、而拨号地址
		（第一跳中转）照样接得住连接时，每一条业务连接都把探测攒的失败清掉，这条线路永远判不坏。
		现在各清各的：一次探测成功只清 probeFailures，一次正常的真实拨号只清 dialFailures；
		任何一本过了自己的门槛就判坏（探测：次数 + 持续异常够久，见 checkHealth；拨号：见 markDialFailure）。
	*/
	probeFailures int
	dialFailures  int
	// 上一次**计了数**的拨号失败是什么时候记下的：在它之前就发起的拨号再失败，算同一次（见 countDialFailure）。
	lastDialFailureAt time.Time
	// summary() 的缓存：探测样本没变就不重算（每条连接拨通都要看一眼探测延迟，以前每次都在写锁里排一遍序）。
	summaryCache      routeStatsSummary
	summaryCacheValid bool
	summaryCacheLen   int
	lastProbeOK       bool
	lastProbeAt       time.Time
	// 探测延迟的指数平均（α = routeLatencyEwmaAlpha，第一次探通的那个数起头）：「自动」分法算权重用它 ——
	// 比样本窗口的中位数跟得紧，又不像最近一次那样一跳就变。0 = 还没探通过。
	latencyEwmaMs float64
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
立刻探一轮，而不是等下一个 5 秒；慢本身不记失败（2.2.240 起），坏没坏由探测说。一次正常的拨号成功把**拨号那本账**
的连续失败清零；探测那本不清 —— 拨得通第一跳说明不了探测目标还活着（见 routeTargetStats.probeFailures）。

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

// recordDial 记一次真实拨号。返回 true 表示这次凑够了连续慢拨，调用方该报事件并立刻探测（不算失败）。
func (s *routeTargetStats) recordDial(ok bool, durationMs int, at time.Time, probeLatencyMs int) bool {
	if durationMs < 0 {
		durationMs = 0
	}
	sample := routeDialSample{at: at, ok: ok, ms: durationMs}
	s.lastDialAt = at
	streak := false
	if !ok {
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
				// 只要求立刻探一轮，不记失败：拨得慢多半是这一刻线路或中转忙（测速时几十条连接一起拨），
				// 当失败记的话，正在跑满的那条线会被判坏、切走，再被抖动抑制钉在差的那条上。
				// 线路是不是真坏了由那一轮探测说了算（2.2.237 记成了失败，和设计说明相反）。
				s.consecutiveSlow = 0
				streak = true
			}
		} else {
			s.consecutiveSlow = 0
			s.dialFailures = 0
		}
	}
	s.dials = append(s.dials, sample)
	// 每条连接都走到这里：只在攒到两倍上限时收一次（均摊 O(1)），不再每次按时间裁、整段复制。
	// 过期的样本留在里面不碍事，dialSummary 读的时候按时间滤掉。
	if len(s.dials) >= 2*routeDialMaxSamples {
		s.dials = append(s.dials[:0], s.dials[len(s.dials)-routeDialMaxSamples:]...)
	}
	return streak
}

/*
countDialFailure 一次真实拨号失败算不算「又一次」（A4）。

一条线路断的那一刻，正在拨的几十条连接会在同一瞬间一起失败 —— 以前各算一次，「连续失败 3 次才判坏」
一下就过了，等于没有门槛；对端只是抖了一下（那一瞬间的连接全失败）也被当成连着坏了很多次。
所以：在上一次计了数的失败**记下来之前**就已经发起的拨号，失败了算同一次。一串并发失败 = 1 次。
真断了的线路照样快：下一条在那之后发起的连接再失败就是第 2 次，凑够门槛当场判坏。
*/
func (s *routeTargetStats) countDialFailure(startedAt time.Time, now time.Time) bool {
	if s.dialFailures > 0 && !s.lastDialFailureAt.IsZero() && startedAt.Before(s.lastDialFailureAt) {
		return false
	}
	s.dialFailures++
	s.lastDialFailureAt = now
	return true
}

// 报给面板、写日志用的「连续失败」：两本账里大的那个。
func (s *routeTargetStats) consecutiveFailures() int {
	if s.dialFailures > s.probeFailures {
		return s.dialFailures
	}
	return s.probeFailures
}

func (s *routeTargetStats) dialSummary(now time.Time) routeDialSummary {
	out := routeDialSummary{}
	if s == nil {
		return out
	}
	cutoff := now.Add(-routeDialWindow)
	recent := s.dials
	if len(recent) > routeDialMaxSamples {
		recent = recent[len(recent)-routeDialMaxSamples:]
	}
	for _, sample := range recent {
		if sample.at.Before(cutoff) {
			continue
		}
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
	s.summaryCacheValid = false
	if ok {
		s.probeFailures = 0
		// 不到 1 毫秒按 1 算：0 留给「还没探通过」，同机房那种 0ms 的路径照样有个数可比。
		sample := math.Max(1, float64(latencyMs))
		if s.latencyEwmaMs <= 0 {
			s.latencyEwmaMs = sample
		} else {
			s.latencyEwmaMs = s.latencyEwmaMs*(1-routeLatencyEwmaAlpha) + sample*routeLatencyEwmaAlpha
		}
	} else {
		s.probeFailures++
	}
}

// 探测延迟指数平均的权重：新样本占三成。
const routeLatencyEwmaAlpha = 0.3

// summary 样本窗口的汇总。探测样本没变就用上一次算好的（recordProbe 会作废缓存；长度也对一下，
// 测试里直接改 samples 的写法照样对）。
func (s *routeTargetStats) summary() routeStatsSummary {
	if s == nil {
		return routeStatsSummary{availabilityPct: 100}
	}
	if s.summaryCacheValid && s.summaryCacheLen == len(s.samples)+len(s.availability) {
		return s.summaryCache
	}
	out := s.computeSummary()
	s.summaryCache, s.summaryCacheValid, s.summaryCacheLen = out, true, len(s.samples)+len(s.availability)
	return out
}

func (s *routeTargetStats) computeSummary() routeStatsSummary {
	out := routeStatsSummary{availabilityPct: 100}
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

// 这条出站此刻能不能用：本机探测通，而且没被面板按「中转异常」标掉。
func (p *failoverProxy) healthyLocked(index int) bool {
	if index < 0 || index >= len(p.spec.Targets) {
		return false
	}
	/*
		这里不能调 ensureHealthStateLocked（A12）：竞速拨号这些只拿读锁的地方也会走到这儿，而它在切片长度
		对不上时会重新分配 —— 读锁下写共享状态，出站条数变了以后的并发拨号能撞出数据竞争。
		切片的长度由拿写锁的地方保证（起代理、rebuildForSpecLocked、各个写路径开头的 ensure）；
		万一还没配齐（测试里手搭的代理），按「还没探过」算：健康，面板提示看规格里带的。
	*/
	if index >= len(p.targetHealth) || index >= len(p.relayDown) {
		return !p.spec.Targets[index].Down
	}
	return p.targetHealth[index] && !p.relayDown[index]
}

// statsLocked 调用方持有写锁。
func (p *failoverProxy) statsLocked(index int) *routeTargetStats {
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.stats) {
		return &routeTargetStats{}
	}
	return p.stats[index]
}

// markDialSuccess 记一次真实连接拨通了：清拨号那本账的连续失败；连续几次拨得慢就报事件、立刻探一轮（不记失败）。
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
		logf("failover target slow dials rule=%d source=%d index=%d target=%s:%d %s failures=%d/%d", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, reason, stats.consecutiveFailures(), p.spec.FailureThreshold)
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

// 按整条链路算的评分输入：本机探出的延迟再加上面板给的下游中转延迟（ExtraLatencyMs）。
// 只在本机探出了延迟时才加 —— 没探出就是没法打分，不能靠下游那几段凑出一个分来。
// 上报的 latencyMs、拨号快慢的比较仍用 scoreInputLocked（只是第一段）。
func (p *failoverProxy) chainScoreInputLocked(index int) routeStatsSummary {
	summary := p.scoreInputLocked(index)
	if summary.hasLatency && index >= 0 && index < len(p.spec.Targets) {
		summary.latencyMs += p.extraLatencyLocked(index)
	}
	return summary
}

/*
scoreLocked 这条出站给人看的 0–100 分（「92 优」）：和自动择优、延迟优先比的是同一个成本
（lbcore.DisplayScore(qualityLocked)，整链延迟 + 抖动、丢包 / 拨号失败、沿途主机负载），只是换算成分数。
不参与任何决定。探不通是 0；还没量出延迟 ok=false（「等评分」）。
*/
func (p *failoverProxy) scoreLocked(index int) (int, bool) {
	if index < 0 || index >= len(p.spec.Targets) {
		return 0, false
	}
	if !p.healthyLocked(index) {
		return 0, true
	}
	return lbcore.DisplayScore(p.qualityLocked(index, time.Now(), false))
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
	if summary.hasLatency && summary.latencyMs >= routePrecheckLatencyMs {
		return fmt.Sprintf("latency %dms", summary.latencyMs)
	}
	if summary.samples >= 3 && summary.lossPct >= routePrecheckLossPct {
		return fmt.Sprintf("loss %.0f%%", summary.lossPct)
	}
	return ""
}

/*
原地换规格。

上一版是「一切归零」：健康全部当成好的、活跃线路回到第 0 条。改一下时段表就把正走着
备线的流量拽回主线，而主线可能正挂着 —— 要等下一轮探测才发现。现在按「拨的地址 +
探测地址」认出没变的出站（carryIndex），把按路径记的状态都搬到它的新下标上（carried）；真变了的
才从头来。不在这里重新选路：下一轮探测（5 秒内）会按新规格评估，和以前一样。

所有按路径下标记的状态都在这一处搬，一样不落（A11、F3）：以前慢启动的恢复时刻、按权重的计数、演练撤掉的
时刻、延迟优先的那一组（lbNear）各有各的遗漏 —— 长度对不上时在别处整个清零重建，长度没变而顺序变了时
状态留在旧下标上，算到了别的路径头上（慢的那条继承了「在组里」）。在途计数不搬：旧下标发出去的那几笔
按旧的一代作废（见 failoverReservation.gen），从 0 起。轮流的位置（roundRobinNext）是个不分路径的计数，
原样留着：起代理时随机定的起步位置（路线图 X4）不能因为改了一下设置就清回 0（F4）。

返回出站列表有没有变（条数、顺序、拨的地址或探测地址）。变了的话调用方在放锁之后
立刻探一轮（probeNowAndReport），新出站不用空等定时探测。
*/
func (p *failoverProxy) rebuildForSpecLocked(spec failoverSpec, now time.Time) bool {
	p.ensureHealthStateLocked()
	targetsChanged := len(spec.Targets) != len(p.spec.Targets)
	for i := 0; !targetsChanged && i < len(spec.Targets); i++ {
		targetsChanged = targetStateKey(spec.Targets[i]) != targetStateKey(p.spec.Targets[i])
	}
	from := carryIndex(p.spec.Targets, spec.Targets)
	newActive := -1
	for i, j := range from {
		if j >= 0 && j == p.activeIndex {
			newActive = i
		}
	}
	p.targetHealth = carried(p.targetHealth, from)
	p.failureSince = carried(p.failureSince, from)
	p.recoveredSince = carried(p.recoveredSince, from)
	p.lastLatencyMs = carried(p.lastLatencyMs, from)
	p.stats = carried(p.stats, from)
	p.conns = carried(p.conns, from)
	p.slowStartAt = carried(p.slowStartAt, from)
	p.drillEndedAt = carried(p.drillEndedAt, from)
	p.lbQuality = carried(p.lbQuality, from)
	p.pickCounts = carried(p.pickCounts, from)
	p.exitThroughFailed = carried(p.exitThroughFailed, from)
	p.exitThroughOKs = carried(p.exitThroughOKs, from)
	p.exitThroughGen = carried(p.exitThroughGen, from)
	p.exitCanaryMisses = carried(p.exitCanaryMisses, from)
	p.exitOutages = carried(p.exitOutages, from)
	p.exitRecoveredAt = carried(p.exitRecoveredAt, from)
	// 按权重的计数还没用过（nil）就保持没用过：spreadStateLocked 第一次用时才开、才随机转起步位置。
	if p.wrrCurrent != nil {
		p.wrrCurrent = carried(p.wrrCurrent, from)
	}
	p.lbNear = p.lbNear.Remap(from)
	p.lbFastest = p.lbFastest.Remap(from)
	p.udpSide = p.udpSide.carried(from)
	// 正在复核的不带：复核的协程回来按地址重新找下标（indexOfTargetLocked）。
	p.exitConfirming = make([]bool, len(spec.Targets))
	p.inflight = make([]int, len(spec.Targets))
	p.inflightGen++
	p.relayDown = make([]bool, len(spec.Targets))
	p.relayDownReason = make([]string, len(spec.Targets))
	for i, target := range spec.Targets {
		if from[i] < 0 {
			p.targetHealth[i] = true
		}
		// 新规格里带的中转提示以新的为准。
		p.relayDown[i] = target.Down
		if target.Down {
			p.relayDownReason[i] = strings.TrimSpace(target.DownReason)
		}
	}
	p.spec = spec
	if newActive >= 0 {
		p.activeIndex = newActive
	} else {
		p.activeIndex = 0
		p.activeSince = now
	}
	p.challenger.Reset()
	p.prewarmIndex = -1
	p.precheckFailedIndex = -1
	p.pinnedLast = -1
	// 新出站的样本、连接表，以及别的按出站条数开的切片在这里（写锁下）一次配齐：之后只拿读锁的路径不会再碰到
	// 长度对不上（A12）。
	p.ensureHealthStateLocked()
	return targetsChanged
}

/*
carryIndex：新规格的第 i 条是旧规格的第几条（targetStateKey 一样：拨的地址 + 探测地址），-1 = 新出站。
同一个地址出现几次就按先后一一对上，不会两条新出站搬到同一份旧状态上（共用一张连接表、一份样本）。
*/
func carryIndex(old, next []failoverTarget) []int {
	byKey := map[string][]int{}
	for j, target := range old {
		key := targetStateKey(target)
		byKey[key] = append(byKey[key], j)
	}
	from := make([]int, len(next))
	for i, target := range next {
		from[i] = -1
		key := targetStateKey(target)
		if queue := byKey[key]; len(queue) > 0 {
			from[i], byKey[key] = queue[0], queue[1:]
		}
	}
	return from
}

// carried：按 from（carryIndex）把按路径下标排的状态搬到新下标上；新出站是零值。
func carried[T any](old []T, from []int) []T {
	out := make([]T, len(from))
	for i, j := range from {
		if j >= 0 && j < len(old) {
			out[i] = old[j]
		}
	}
	return out
}

// ---- 断旧连接（快速故障转移 / 强制切换） ----

func (p *failoverProxy) trackConn(index int, conn net.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.trackConnLocked(index, conn)
}

func (p *failoverProxy) trackConnLocked(index int, conn net.Conn) {
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
	// 评分时加在 latencyMs 上的下游中转延迟（面板给的）。latencyMs 本身只是第一段。
	ExtraLatencyMs int `json:"extraLatencyMs,omitempty"`
	// 评分时扣了分的沿途主机负载（面板给的，0–100；0 = 不知道，没扣）。
	LoadPct int `json:"loadPct,omitempty"`
	// 真实连接最近 10 分钟的拨号：成功 / 失败 / 慢（慢的也算成功里的）、耗时折半均值、最近一次（Unix 毫秒）。
	DialOK     int   `json:"dialOk"`
	DialFailed int   `json:"dialFailed"`
	DialSlow   int   `json:"dialSlow"`
	DialMs     int   `json:"dialMs,omitempty"`
	LastDialAt int64 `json:"lastDialAt,omitempty"`
	// UDP 那一侧（2.2.251 起，route_group_udp_health.go）：只转 UDP 的规格就是 healthy / latencyMs 本身；
	// TCP+UDP 规格是单独探出来的；只转 TCP 的不带。老 Agent 不报这两个字段，面板就什么都不多显示。
	UDPHealthy   *bool `json:"udpHealthy,omitempty"`
	UDPLatencyMs int   `json:"udpLatencyMs,omitempty"`
}

/*
此刻真正在按什么跑（2.2.253 起，面板拿它做「期望 vs 实际」对账）。

2.3.522 线上「切到备用 1 还是走主线路」：钉子存在面板上的模板里，机器跑的那条从没拿到过，而面板照着模板写
「人工指定」—— 只看面板永远发现不了。所以让机器自己说它在按什么跑：面板按用户配好的那份比对，对不上就在
线路详情里标红、列出差异。

人工指定报的是**此刻生效**的那条（到期了就是 null，和面板 readFailoverPin 的读法一致）；时段表报规整后的；
别的字段都是 normalizeFailoverSpec 之后的值。路径的拨号地址在 targets[].target 里，不重复报。
*/
type failoverSpecReport struct {
	PinnedIndex      *int              `json:"pinnedIndex"`
	PinnedUntil      int64             `json:"pinnedUntil,omitempty"`
	Schedule         *failoverSchedule `json:"schedule,omitempty"`
	MinHoldSeconds   int               `json:"minHoldSeconds"`
	PreferFastest    bool              `json:"preferFastest"`
	Strategy         string            `json:"strategy"`
	Delivery         string            `json:"delivery,omitempty"`
	FailoverSeconds  int               `json:"failoverSeconds"`
	RecoverSeconds   int               `json:"recoverSeconds"`
	AutoFailback     bool              `json:"autoFailback"`
	FailureThreshold int               `json:"failureThreshold"`
	LatencyMarginMs  int               `json:"latencyMarginMs,omitempty"`
	ScoreHoldSeconds int               `json:"scoreHoldSeconds"`
	PrewarmSeconds   int               `json:"prewarmSeconds"`
	SwitchMode       string            `json:"switchMode"`
	TargetCount      int               `json:"targetCount"`
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
	// 最近 10 分钟连进来的客户端连接：拨通了一条路径的、一条都没拨通的（TCP；UDP 会话不算）。
	InboundOK     int `json:"inboundOk,omitempty"`
	InboundFailed int `json:"inboundFailed,omitempty"`
	// 此刻生效的规格（见 failoverSpecReport）。
	Spec *failoverSpecReport `json:"spec,omitempty"`
}

func (p *failoverProxy) specReportLocked(now time.Time) *failoverSpecReport {
	report := &failoverSpecReport{
		Schedule:         normalizeFailoverSchedule(p.spec.Schedule),
		MinHoldSeconds:   p.spec.MinHoldSeconds,
		PreferFastest:    p.spec.PreferFastest,
		Strategy:         p.spec.Strategy,
		Delivery:         p.spec.Delivery,
		FailoverSeconds:  p.spec.FailoverSeconds,
		RecoverSeconds:   p.spec.RecoverSeconds,
		AutoFailback:     p.spec.AutoFailback,
		FailureThreshold: p.spec.FailureThreshold,
		LatencyMarginMs:  p.spec.LatencyMarginMs,
		ScoreHoldSeconds: p.spec.ScoreHoldSeconds,
		PrewarmSeconds:   p.spec.PrewarmSeconds,
		SwitchMode:       p.spec.SwitchMode,
		TargetCount:      len(p.spec.Targets),
	}
	if index := p.pinnedIndexAt(now); index >= 0 {
		pinned := index
		report.PinnedIndex = &pinned
		report.PinnedUntil = p.spec.PinnedUntil
	}
	return report
}

// routeInboundWindowMinutes 分钟一格，滚动着记。连接再多也只占这几格，不存样本。
const routeInboundWindowMinutes = 10

type routeInboundBucket struct {
	minute int64
	ok     int
	failed int
}

type routeInboundWindow struct {
	mu      sync.Mutex
	buckets [routeInboundWindowMinutes]routeInboundBucket
}

func (w *routeInboundWindow) record(ok bool, at time.Time) {
	minute := at.Unix() / 60
	w.mu.Lock()
	defer w.mu.Unlock()
	bucket := &w.buckets[minute%routeInboundWindowMinutes]
	if bucket.minute != minute {
		*bucket = routeInboundBucket{minute: minute}
	}
	if ok {
		bucket.ok++
	} else {
		bucket.failed++
	}
}

// summary 最近 10 分钟（含这一分钟）的合计。
func (w *routeInboundWindow) summary(now time.Time) (ok int, failed int) {
	current := now.Unix() / 60
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, bucket := range w.buckets {
		if bucket.minute <= 0 || current-bucket.minute >= routeInboundWindowMinutes || bucket.minute > current {
			continue
		}
		ok += bucket.ok
		failed += bucket.failed
	}
	return ok, failed
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
			ConsecutiveFailures: stats.consecutiveFailures(),
			Connections:         p.connectionsLocked(index),
			Samples:             summary.samples,
			ExtraLatencyMs:      p.extraLatencyLocked(index),
			LoadPct:             target.LoadPct,
		}
		if !stats.lastProbeAt.IsZero() {
			item.LastProbeAt = stats.lastProbeAt.UnixMilli()
		}
		item.UDPHealthy, item.UDPLatencyMs = p.udpReportLocked(index)
		dials := stats.dialSummary(time.Now())
		item.DialOK, item.DialFailed, item.DialSlow, item.DialMs = dials.ok, dials.failed, dials.slow, dials.avgMs
		if !dials.lastAt.IsZero() {
			item.LastDialAt = dials.lastAt.UnixMilli()
		}
		report.Targets = append(report.Targets, item)
	}
	report.InboundOK, report.InboundFailed = p.inbound.summary(time.Now())
	report.Spec = p.specReportLocked(time.Now())
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
