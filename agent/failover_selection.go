package main

import (
	"strconv"
	"time"
)

func (p *failoverProxy) resetFastestLocked() {
	p.fastestCandidate = -1
	p.fastestSince = time.Time{}
}

func (p *failoverProxy) fastestIndexLocked(now time.Time) int {
	if !p.spec.PreferFastest || len(p.spec.Targets) < 2 {
		return -1
	}
	p.ensureHealthStateLocked()
	// 分层：只在还有健康出站的最优一层里择优。当前这条不在那一层（走着备用组而主组
	// 已经恢复）时不择优 —— 交给按数组顺序切回，回到那一层的第一条健康出站。
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
	activeScore, activeScored := p.scoreLocked(p.activeIndex)
	activeLatency := p.chainScoreInputLocked(p.activeIndex).latencyMs
	best := -1
	bestScore := 0
	bestLatency := 0
	for index := range p.spec.Targets {
		if index == p.activeIndex || !p.healthyLocked(index) {
			continue
		}
		if tiered && *p.spec.Targets[index].Tier != bestTier {
			continue
		}
		// 还没法打分（没探出耗时）的不能当成「好得不得了」。
		score, scored := p.scoreLocked(index)
		if !scored {
			continue
		}
		latency := p.chainScoreInputLocked(index).latencyMs
		if best < 0 || score > bestScore || (score == bestScore && latency > 0 && latency < bestLatency) {
			best, bestScore, bestLatency = index, score, latency
		}
	}
	if best < 0 || !activeScored || !p.healthyLocked(p.activeIndex) {
		p.resetFastestLocked()
		return -1
	}
	better := bestScore-activeScore >= p.spec.ScoreMargin
	if !better && activeLatency > 0 && bestLatency > 0 && bestScore >= activeScore {
		margin := activeLatency - bestLatency
		better = margin >= failoverFastestMarginMs && float64(margin) >= float64(activeLatency)*failoverFastestMarginRatio
	}
	if !better {
		p.resetFastestLocked()
		return -1
	}
	// fastestSince 是零值时必须当成「还没开始计时」。
	//
	// fastestCandidate 的 Go 零值是 0，所以第一次评估如果恰好选中第 0 条，
	// `p.fastestCandidate != best` 会是 false，而 now.Sub(零时刻) 是个巨大的数 ——
	// 持续时间那道门槛会被整个跳过，第一次探测就切。这三道门槛里最重要的一道
	// 就这么没了，而且只在「最快的恰好是第 0 条」时发生，最难查。
	if p.fastestCandidate != best || p.fastestSince.IsZero() {
		p.fastestCandidate = best
		p.fastestSince = now
		return -1
	}
	hold := time.Duration(p.spec.ScoreHoldSeconds) * time.Second
	if activeLatency > 0 && bestLatency > 0 && activeLatency-bestLatency >= failoverDramaticMarginMs && bestLatency*2 <= activeLatency && hold > failoverDramaticHold {
		hold = failoverDramaticHold
	}
	if now.Sub(p.fastestSince) < hold {
		return -1
	}
	return best
}

/*
抖动抑制：一小时内自动切了三次以上，就把「刚切过去不许马上再切」的驻留拉长。

切换保护（连续失败次数、评分分差、持续时间）挡的是**单次**误判；两条线路质量接近、
轮流领先时，每一次切换都各自合规，合起来却是来回漂 —— honk 把这叫 switchFlap。对付它
不能再加一道单次门槛，得看频率：切得越勤，下一次等得越久。三次起 5 分钟，之后每多一次
翻一倍，最多一小时。人工指定不算（人说了算），当前线路挂了的逃生也不受它限制。
*/
const flapHoldWindow = time.Hour

const flapHoldSwitches = 3

const flapHoldBase = 5 * time.Minute

const flapHoldMax = time.Hour

func (p *failoverProxy) noteAutoSwitchLocked(at time.Time) {
	kept := p.autoSwitchTimes[:0]
	for _, t := range p.autoSwitchTimes {
		if at.Sub(t) < flapHoldWindow {
			kept = append(kept, t)
		}
	}
	p.autoSwitchTimes = append(kept, at)
}

// 一小时内自动切了几次。
func (p *failoverProxy) recentAutoSwitchesLocked(now time.Time) int {
	count := 0
	for _, t := range p.autoSwitchTimes {
		if now.Sub(t) < flapHoldWindow {
			count++
		}
	}
	return count
}

// 抖动抑制要求的驻留；没在抖是 0。
func (p *failoverProxy) flapHoldLocked(now time.Time) time.Duration {
	count := p.recentAutoSwitchesLocked(now)
	if count < flapHoldSwitches {
		return 0
	}
	hold := flapHoldBase << uint(count-flapHoldSwitches)
	if hold > flapHoldMax || hold <= 0 {
		hold = flapHoldMax
	}
	return hold
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
	for _, index := range order {
		if p.healthyLocked(index) {
			p.setActiveLocked(index, reason)
			return
		}
	}
}

/*
真实连接拨不通。

上一版拨不通一次就把这条出站标成坏的。一次拨号失败在公网上太常见了（对端偶尔 RST、
中间设备抽风），为它切一次线路等于把抖动放大成切换。现在算进连续失败次数，到了
FailureThreshold 才标记 —— 那条连接本身照样换下一条出站去拨，客户端不会因此失败。
*/
func (p *failoverProxy) markTargetFailure(index int, reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.spec.Targets) {
		return
	}
	stats := p.statsLocked(index)
	stats.recordDialFailure()
	if p.targetHealth[index] {
		target := p.spec.Targets[index]
		if stats.consecutiveFailures < p.spec.FailureThreshold {
			logVerbosef("failover target dial failed rule=%d source=%d index=%d target=%s:%d failures=%d/%d", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, stats.consecutiveFailures, p.spec.FailureThreshold)
			return
		}
		p.targetHealth[index] = false
		p.failureSince[index] = time.Now()
		p.recoveredSince[index] = time.Time{}
		logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=%s", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, reason)
		p.recordTargetEventLocked(index, "unhealthy", reason)
	}
	p.updateFallbackActiveLocked(reason)
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
