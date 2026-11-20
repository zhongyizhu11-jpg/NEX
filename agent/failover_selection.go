package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"syscall"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

func (p *failoverProxy) resetFastestLocked() {
	p.challenger.Reset()
}

/*
自动择优（主备里开了「整链最优」）：有没有一条明显更好、而且已经领先够久的。返回它的下标，没有是 -1。

「明显更好」和「等多久」是 lbcore.SwitchPolicy（lbcore/switch.go）：比的是只看质量的成本
（整链延迟 + 抖动，乘丢包 / 拨号失败系数 —— 拨号失败只在每条都有拨号样本时才算，见 comparableCostsLocked ——
除以沿途主机负载留下的余量），差出延迟优先的那个门槛
（switchPolicyLocked：规格的 LatencyMarginMs，默认 50ms）而且快出两成才算；同一条要连着领先 ScoreHoldSeconds，
好得多的（不到一半、差出两个门槛）10 秒就换。切过去以后的来回由抖动抑制压（holdingLocked）。

分层：只在还有健康出站的最优一层里择优。当前这条不在那一层（走着备用组而主组已经恢复）时不择优 ——
交给按数组顺序切回，回到那一层的第一条健康出站。
*/
func (p *failoverProxy) fastestIndexLocked(now time.Time) int {
	if !p.spec.PreferFastest || len(p.spec.Targets) < 2 {
		return -1
	}
	p.ensureHealthStateLocked()
	tiered := failoverSpecTiered(p.spec)
	bestTier := 0
	if tiered {
		healthy := p.candidateIndicesLocked(nil, true)
		if len(healthy) == 0 {
			p.resetFastestLocked()
			return -1
		}
		bestTier = p.lowestTierLocked(healthy)
		if *p.spec.Targets[p.activeIndex].Tier != bestTier {
			p.resetFastestLocked()
			return -1
		}
	}
	if !p.healthyLocked(p.activeIndex) {
		p.resetFastestLocked()
		return -1
	}
	contenders := []int{p.activeIndex}
	for index := range p.spec.Targets {
		if index != p.activeIndex && p.healthyLocked(index) && (!tiered || *p.spec.Targets[index].Tier == bestTier) {
			contenders = append(contenders, index)
		}
	}
	costs := p.comparableCostsLocked(contenders, now)
	activeCost := costs[0]
	best, bestCost := -1, 0.0
	for i := 1; i < len(contenders); i++ {
		// 还没量出延迟的（成本 0）不能当成「好得不得了」。
		if c := costs[i]; c > 0 && (best < 0 || c < bestCost) {
			best, bestCost = contenders[i], c
		}
	}
	policy := p.switchPolicyLocked()
	better, much := policy.Better(activeCost, bestCost)
	if best < 0 || !better {
		p.resetFastestLocked()
		return -1
	}
	if !p.challenger.Ready(best, now, policy.HoldFor(much)) {
		return -1
	}
	return best
}

/*
comparableCostsLocked：indices 这几条只看质量的成本（lbcore.QualityCost，整链延迟，见 qualityLocked；不知道延迟是 0），
拿来互相比的。拨通率只在每条都有拨号样本时才算进去（F6）：真实连接只拨在走的那条，别的几条的拨通率几乎总是
「不知道」（不罚），在走的那条偶尔拨不通一次就被罚、别的永远不被罚 —— 比下来总像是「该换了」。
*/
func (p *failoverProxy) comparableCostsLocked(indices []int, now time.Time) []float64 {
	qualities := make([]lbcore.Quality, len(indices))
	allDialed := true
	for i, index := range indices {
		qualities[i] = p.qualityLocked(index, now, false)
		allDialed = allDialed && qualities[i].Success > 0
	}
	costs := make([]float64, len(indices))
	for i, quality := range qualities {
		if !allDialed {
			quality.Success = 0
		}
		costs[i] = lbcore.QualityCost(quality)
	}
	return costs
}

// latencyMarginLocked「一样快」的门槛（毫秒）：延迟优先圈组、择优比成本、同出口 IP 算平手都用它。
func (p *failoverProxy) latencyMarginLocked() float64 {
	if p.spec.LatencyMarginMs > 0 {
		return float64(p.spec.LatencyMarginMs)
	}
	return lbcore.DefaultLatencyMargin
}

func (p *failoverProxy) switchPolicyLocked() lbcore.SwitchPolicy {
	return lbcore.SwitchPolicy{Margin: p.latencyMarginLocked(), Hold: time.Duration(p.spec.ScoreHoldSeconds) * time.Second}
}

/*
抖动抑制：一小时内自动切了三次以上，就把「刚切过去不许马上再切」的驻留拉长。

切换保护（连续失败次数、评分分差、持续时间）挡的是**单次**误判；两条线路质量接近、
轮流领先时，每一次切换都各自合规，合起来却是来回漂 —— honk 把这叫 switchFlap。对付它
不能再加一道单次门槛，得看频率：切得越勤，下一次等得越久。三次起 5 分钟，之后每多一次
翻一倍，最多一小时。人工指定不算（人说了算），当前线路挂了的逃生也不受它限制。

计数和翻倍是 lbcore.FlapDamper（NEX 隧道出口组「出口到目标来回断」用的是同一个，参数不同）；
这里只是把账记在代理身上（autoSwitchTimes、flapWarmupUntil）。
*/
const flapHoldWindow = time.Hour

const flapHoldSwitches = 3

const flapHoldBase = 5 * time.Minute

const flapHoldMax = time.Hour

/*
flapWarmup：线路刚在这台机器上起来的头一分半钟里，自动切换不计入抖动抑制。

新建线路时中转上的中继、出口往往比入口晚起几秒，头几轮探测会判主线路不健康、切走、马上又切回。
这是开机抖动，不是线路在漂；以前它们照样记账，一上来就用掉三次额度里的两次，之后真出故障切走再切回，
切回就被压五分钟（2026-11 CI 的 E2E 偶发红过两次）。切换本身照常发生，只是不记进「一小时切了几次」。
*/
const flapWarmup = 90 * time.Second

var routeFlapPolicy = lbcore.FlapPolicy{Window: flapHoldWindow, Threshold: flapHoldSwitches, Base: flapHoldBase, Max: flapHoldMax}

func (p *failoverProxy) flapDamperLocked() lbcore.FlapDamper {
	return lbcore.FlapDamper{Policy: routeFlapPolicy, WarmupUntil: p.flapWarmupUntil, Events: p.autoSwitchTimes}
}

// 记一次自动切换（预热期里的不记）。
func (p *failoverProxy) noteAutoSwitchLocked(at time.Time) {
	damper := p.flapDamperLocked()
	damper.Note(at)
	p.autoSwitchTimes = damper.Events
}

// 一小时内自动切了几次。
func (p *failoverProxy) recentAutoSwitchesLocked(now time.Time) int {
	damper := p.flapDamperLocked()
	return damper.Count(now)
}

// 抖动抑制要求的驻留；没在抖是 0。
func (p *failoverProxy) flapHoldLocked(now time.Time) time.Duration {
	damper := p.flapDamperLocked()
	return damper.Hold(now)
}

// 刚切过去，还在最短驻留时间里（配置的最短驻留和抖动抑制取长的那个）。
func (p *failoverProxy) holdingLocked(now time.Time) bool {
	if p.lastSwitchAt.IsZero() {
		return false
	}
	hold := time.Duration(p.spec.MinHoldSeconds) * time.Second
	if flap := p.flapHoldLocked(now); flap > hold {
		hold = flap
		if now.Sub(p.lastSwitchAt) < hold && !p.flapHoldReported {
			// 报一次就够：面板的「最近切换」里写明为什么这会儿不切。
			p.flapHoldReported = true
			until := p.lastSwitchAt.Add(hold)
			logf("failover flap hold rule=%d source=%d switches=%d hold=%s", p.ruleID, p.sourcePort, p.recentAutoSwitchesLocked(now), hold)
			recordFailoverProxyEvent(failoverProxyEvent{
				RuleID: p.ruleID, SourcePort: p.sourcePort, Kind: "flap_hold",
				ToTarget:  failoverTargetLabel(p.spec.Targets[p.activeIndex]),
				FromIndex: -1, ToIndex: p.activeIndex,
				Reason:    "flap: " + strconv.Itoa(p.recentAutoSwitchesLocked(now)) + " switches in 1h, hold " + strconv.Itoa(int(hold/time.Minute)) + "m until " + until.UTC().Format(time.RFC3339),
				LatencyMs: p.latencyMsLocked(p.activeIndex), Score: p.scoreValueLocked(p.activeIndex),
			})
		}
	}
	if hold <= 0 {
		return false
	}
	return now.Sub(p.lastSwitchAt) < hold
}

func (p *failoverProxy) updateFallbackActiveLocked(reason string) {
	p.updateFallbackActiveAtLocked(time.Now(), reason)
}

// 人工指定到期了：报一条「指定到期」，这一轮切回去的原因也随之写成「指定到期」。
func (p *failoverProxy) notePinStateLocked(now time.Time) bool {
	pinned := p.pinnedIndexAt(now)
	expired := false
	if p.pinnedLast >= 0 && pinned < 0 && p.spec.PinnedIndex != nil {
		expired = true
		logf("failover pin expired rule=%d source=%d index=%d", p.ruleID, p.sourcePort, p.pinnedLast)
		p.recordTargetEventLocked(p.pinnedLast, "unpinned", "pin expired")
	}
	p.pinnedLast = pinned
	return expired
}

/*
计划切换的预热：时段表再过 PrewarmSeconds 就要换首选了，提前把那条标成「预热中」。

所有出站本来就每 5 秒探一次，预热并不需要额外的探测；它的意义是让面板提前告诉人
「17:55 起预热 B，18:00 切」，以及到点时预检拿得出足够新的样本。只在开始预热那一刻记一条事件。
*/
func (p *failoverProxy) notePrewarmLocked(now time.Time) {
	if p.spec.PrewarmSeconds <= 0 || p.spec.Schedule == nil || p.pinnedIndexAt(now) >= 0 {
		p.prewarmIndex = -1
		return
	}
	current := failoverScheduleTargetIndexAt(p.spec.Schedule, now)
	if current < 0 {
		current = 0
	}
	upcoming := failoverScheduleTargetIndexAt(p.spec.Schedule, now.Add(time.Duration(p.spec.PrewarmSeconds)*time.Second))
	if upcoming < 0 {
		upcoming = 0
	}
	if upcoming >= len(p.spec.Targets) || upcoming == current || upcoming == p.activeIndex {
		p.prewarmIndex = -1
		return
	}
	if p.prewarmIndex == upcoming {
		return
	}
	p.prewarmIndex = upcoming
	logf("failover prewarm rule=%d source=%d target=%d in=%ds", p.ruleID, p.sourcePort, upcoming, p.spec.PrewarmSeconds)
	p.recordTargetEventLocked(upcoming, "prewarm", "schedule")
}

func (p *failoverProxy) notePrecheckFailedLocked(index int, issue string) {
	if p.precheckFailedIndex == index {
		return
	}
	p.precheckFailedIndex = index
	logf("failover planned switch held rule=%d source=%d target=%d precheck=%s", p.ruleID, p.sourcePort, index, issue)
	p.recordTargetEventLocked(index, "precheck_failed", "precheck: "+issue)
}

/*
把「现在几点」作为参数传进来，而不是在里面读 time.Now()。

时段表的行为只有按指定时刻才测得准：读真实时钟的话，「18 点到了而那条线正挂着，
不该切过去」这条用例只在真实时间落在 18-23 点时才真的走到判断，其余时候压根没有
窗口命中 —— 测试照常绿，但什么都没验证。这种测试比没有更糟，因为它看起来在保护。
*/
func (p *failoverProxy) updateFallbackActiveAtLocked(now time.Time, reason string) {
	// 延迟优先「只走最快的一台」：每轮探测、每次判坏 / 恢复也重新看一遍在用的是谁（failover_fastest.go）。
	if p.fastestOnlyLocked() {
		p.evaluateFastestLocked(now, reason)
		return
	}
	if len(p.spec.Targets) == 0 || p.spec.Strategy != "fallback" {
		return
	}
	p.ensureHealthStateLocked()
	pinExpired := p.notePinStateLocked(now)
	preferred, source := p.preferredLocked(now)
	p.notePrewarmLocked(now)
	order := p.orderFromPreferredLocked(preferred)

	if p.healthyLocked(p.activeIndex) {
		candidate := -1
		for _, index := range order {
			// 走到当前这条了，说明前面没有更优且健康的，保持不动。
			if index == p.activeIndex {
				break
			}
			if p.healthyLocked(index) {
				candidate = index
				break
			}
		}
		if candidate < 0 {
			p.precheckFailedIndex = -1
			return
		}
		// 切换的原因写给人看：按时段表、线路评分更优、人工指定，其余都是「首选恢复，切回」。
		switchReason := "failback"
		if candidate == preferred {
			switch source {
			case "pin", "schedule", "score":
				switchReason = source
			}
		}
		if switchReason == "failback" && pinExpired {
			switchReason = "pin expired"
		}
		// 「首选恢复后切不切回」只管切回这件事；人定的时段表和指定、机器算出来的择优照常。
		if switchReason == "failback" && !p.spec.AutoFailback {
			return
		}
		// 开了择优：同一层的两条健康线路之间不按数组顺序切回（见 orderFailbackYieldsToScoreLocked）。
		if switchReason == "failback" && p.orderFailbackYieldsToScoreLocked(candidate, source) {
			p.precheckFailedIndex = -1
			return
		}
		// 按优先级往回切是可以等的：刚切过来就被拽回去，线路会来回抖。
		// 人工指定不等：人说了算，等上 10 分钟只会让人以为没生效。
		if switchReason != "pin" && p.holdingLocked(now) {
			return
		}
		// 计划内的切换（到点、切回）先预检，不过就不切；故障逃生和人工指定不预检。
		if p.spec.PrewarmSeconds > 0 && switchReason != "pin" && switchReason != "score" {
			if issue := p.precheckIssueLocked(candidate); issue != "" {
				p.notePrecheckFailedLocked(candidate, issue)
				return
			}
		}
		p.setActiveLocked(candidate, switchReason)
		return
	}
	/*
		当前这条挂了：按优先级找第一条健康的，**不受最短驻留限制**。

		守着一条死路比抖动更糟 —— 最短驻留是拿来防「好线路之间来回切」的，
		不是拿来拖着不逃生的。
	*/
	// 人工指定和时段表是人定的首选：健康就走它，出口 IP 的取舍压不过它们。
	explicit := -1
	if source == "pin" || source == "schedule" {
		explicit = preferred
	}
	if index, sameExit := p.escapePickLocked(order, p.activeIndex, explicit, false); index >= 0 {
		if sameExit {
			reason += failoverSameExitReasonSuffix
		}
		p.setActiveLocked(index, reason)
	}
}

/*
择优和「恢复后切回」打架（A1）。

两条都健康、B 比 A 快得多时：择优把流量切到 B；下一轮 B 已经在走了，择优没有更好的候选可提，首选回到
「数组顺序」，A 排在 B 前面又健康 —— 按「首选恢复，切回」把流量拽回 A；过了驻留择优又切到 B……
一小时能来回几十次，直到抖动抑制把它钉在慢的那条上。

开了择优（PreferFastest）而这一刻的首选不是人定的（人工指定 / 时段表）时，同一层的两条健康线路之间
谁该走由评分说了算，数组顺序不再插手。按顺序切回只留给：没开择优；分层规格里当前这条在更差的一层
（回主线路组，择优只在一层里比）；人工指定到期（原因是 pin expired，不走到这里）。
*/
func (p *failoverProxy) orderFailbackYieldsToScoreLocked(candidate int, source string) bool {
	if !p.spec.PreferFastest || source == "pin" || source == "schedule" {
		return false
	}
	if candidate < 0 || candidate >= len(p.spec.Targets) || p.activeIndex < 0 || p.activeIndex >= len(p.spec.Targets) {
		return false
	}
	if failoverSpecTiered(p.spec) && *p.spec.Targets[candidate].Tier < *p.spec.Targets[p.activeIndex].Tier {
		return false
	}
	return true
}

/*
真实连接拨不通。

上一版拨不通一次就把这条出站标成坏的。一次拨号失败在公网上太常见了（对端偶尔 RST、
中间设备抽风），为它切一次线路等于把抖动放大成切换。现在算进连续失败次数，到了
FailureThreshold 才标记 —— 那条连接本身照样换下一条出站去拨，客户端不会因此失败。
*/
func (p *failoverProxy) markTargetFailure(index int, reason string) {
	p.markDialFailure(index, reason, time.Now(), nil)
}

/*
markDialFailure 记一次真实拨号失败（A4）。startedAt 是这次拨号发起的时刻，err 是拨号的错误（没有就是 nil）。

  - 本机的错误不是线路的错：fd 用完（EMFILE / ENFILE）、临时端口用完（EADDRNOTAVAIL）、内核没内存
    （ENOBUFS / ENOMEM）、我们自己取消的拨号 —— 这时每条线路都拨不出去，记到线路头上只会把所有线路
    一起判坏。不计数、不进拨号记录，一分钟写一条日志（failoverLocalDialError）。
  - 并发的一串失败算一次（routeTargetStats.countDialFailure）。
  - 连着 FailureThreshold 次**各自独立**的失败，当场判坏，不等探测 —— 真断了的线路照样几条连接就切走。
    中间只要有一次正常拨通就清零；探测攒的失败在另一本账上，互不清零（A2）。
*/
func (p *failoverProxy) markDialFailure(index int, reason string, startedAt time.Time, err error) {
	if failoverLocalDialError(err) {
		if shouldLogAgentReport(fmt.Sprintf("failover-local-dial-error:%d:%d", p.ruleID, p.sourcePort), time.Minute) {
			logf("failover dial failed locally (not counted against the path) rule=%d source=%d index=%d: %v", p.ruleID, p.sourcePort, index, err)
		}
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.spec.Targets) {
		return
	}
	// 出口组拨的是本机的 gost 端口：拨不上是前面的 gost 没起来 / 在重载，每台出口都一样，不是哪台出口的错。
	if err != nil && p.exitGroupLocked() {
		if shouldLogAgentReport(fmt.Sprintf("failover-exit-local-dial:%d:%d", p.ruleID, p.sourcePort), time.Minute) {
			logf("failover exit group: local runtime port not reachable (not counted against the exit) rule=%d source=%d index=%d: %v", p.ruleID, p.sourcePort, index, err)
		}
		return
	}
	now := time.Now()
	stats := p.statsLocked(index)
	stats.recordDial(false, 0, now, 0)
	counted := stats.countDialFailure(startedAt, now)
	if p.targetHealth[index] {
		target := p.spec.Targets[index]
		if !counted || stats.dialFailures < p.spec.FailureThreshold {
			logVerbosef("failover target dial failed rule=%d source=%d index=%d target=%s:%d failures=%d/%d counted=%v", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, stats.dialFailures, p.spec.FailureThreshold, counted)
			return
		}
		p.markUnhealthyLocked(index, reason, "")
	}
	p.updateFallbackActiveLocked(reason)
}

// failoverLocalDialError 这个拨号错误是不是本机的问题（和线路无关）。
func failoverLocalDialError(err error) bool {
	if err == nil {
		return false
	}
	for _, local := range []error{syscall.EMFILE, syscall.ENFILE, syscall.EADDRNOTAVAIL, syscall.ENOBUFS, syscall.ENOMEM, context.Canceled} {
		if errors.Is(err, local) {
			return true
		}
	}
	return false
}

/*
立刻探一轮，探完唤醒一次心跳把新的统计带给面板。

代理刚起来、或者换了出站时用：定时探测 5 秒后才来，再等一次心跳，面板上新线路要
空着「等评分」好一阵。在自己的 goroutine 里跑，调用方不能持有 p.mu（探测要拿锁）。
wakeHeartbeat 是带缓冲 channel 的非阻塞发送，不会卡住。
*/
func (p *failoverProxy) probeNowAndReport() {
	if p.retiredNow() {
		return
	}
	p.checkHealthShared()
	if p.retiredNow() {
		return
	}
	wakeHeartbeat()
}

func (p *failoverProxy) retiredNow() bool {
	if p.done == nil {
		return false
	}
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

// 两份规格的人工指定是不是同一个（指哪条、到什么时候）。
func sameFailoverPin(a, b failoverSpec) bool {
	if (a.PinnedIndex == nil) != (b.PinnedIndex == nil) {
		return false
	}
	if a.PinnedIndex != nil && *a.PinnedIndex != *b.PinnedIndex {
		return false
	}
	return a.PinnedUntil == b.PinnedUntil
}
