package main

import (
	"strings"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
出口选择器怎么挑（阶段 2 起）：算法在共用的 lbcore 里，这里只做三件事 ——

 1. 把每台出口此刻的健康填成 lbcore.Health（healthLocked）：出口本身连不连得上（端点状态，endpoint_pool.go；
    UDP 会话看 UDP 那一侧）、它到这条规则的目标通不通、稳不稳（target_health.go）。
 2. 把候选的负载和质量填成 lbcore.Member（fillMembersLocked）：分量、慢启动、挂着的会话、刚挑中的、
    延迟（入口到出口的握手 + 出口到目标的中位数）、抖动、丢包、利用率（流量 ÷ 线路带宽）。
 3. 按分配方式调 lbcore 的函数（chooseLocked）。

和线路组（agent/）用的是同一套函数，由 lbcore/testdata/conformance 的用例卡住两边一致
（lbcore_conformance_test.go 拿这里的 pick 跑）。以前这些算法在 main.go、exit_load.go、target_health.go 里各写了一份。

各分配方式的算法、参数和默认值见 lbcore 各文件开头。
*/

// Float64 让选择器自己当 lbcore 的随机数来源（[0,1)）。取不到随机数时返回 0：按几成收的会收下，抽签抽到第一个。
func (s *exitEndpointSelector) Float64() float64 {
	value, err := s.randomValue()
	if err != nil {
		return 0
	}
	return float64(value>>11) / float64(uint64(1)<<53)
}

// ensureBuffersLocked：挑选路径上反复用的几块临时区（每个选择器一份，都在规则锁里用），都按端点下标排。
// 以前每次挑选都新分配分档表、候选表、折算表、负载快照……目标感知打开后一次挑选 59 次分配（路线图 X12）。
func (s *exitEndpointSelector) ensureBuffersLocked() {
	n := len(s.endpoints)
	if s.healthBuf != nil && len(s.healthBuf) == n {
		return
	}
	s.healthBuf = make([]lbcore.Health, n)
	s.members = make([]lbcore.Member, n)
	s.candBuf = make([]int, 0, n)
	s.nearBuf = make([]int, 0, n)
	s.scoreBuf = make([]float64, n)
}

/*
randomizeStartLocked：轮询从哪一台起步、平滑加权轮到第几步，每个选择器随机定（路线图 X4）。

以前每条规则都从第一台起步。入口上几百条规则一起启动（重启、重载）时，每条规则的第一条连接都落在
同一台出口上；连接少的规则（一两条长连接）更是永远只用第一台。加权同理：先把序列空转随机步
（lbcore.SmoothWRR.Spin），一整圈里各台的份额不变，只是起点不同。只在构造时调，还没有别人拿得到这个选择器。
*/
func (s *exitEndpointSelector) randomizeStartLocked() {
	if len(s.endpoints) < 2 {
		return
	}
	value, err := randomUint64()
	if err != nil {
		return
	}
	s.next = int(value % uint64(len(s.endpoints)))
	if s.strategy != "weighted" {
		return
	}
	s.ensureBuffersLocked()
	all := s.candBuf[:0]
	for i := range s.endpoints {
		all = append(all, i)
		s.members[i] = lbcore.Member{Weight: s.weights[i], Share: 1}
	}
	s.current.Spin(s.members, all, value>>20)
}

/*
healthLocked：每台出口此刻的健康（lbcore.Health，按端点下标）。调用方持锁；返回的是选择器自己的临时区。

  - Dead：出口本身连不上。udp 为 true（给 UDP 会话挑）时看 UDP 那一侧（fxpEndpointState.reachable）。
    Cooling：连不上而且还在退避里（主备全挂时先试退避到期的）。
  - DownstreamDown：出口连得上，它到这条规则的目标不通。
  - Soft：分着用（spread）时是「不稳，而且面板设的动作是切走」；主备（fallback 为 true）时是「不稳（动作不是不管）」
    或者「刚恢复还没稳够 5 分钟」—— 主备一次只用一台，排在后面还有稳的就先用稳的。

「不稳、动作是少分」不算软信号：它照常参与，只是按几成算（fillMembersLocked）。
*/
func (s *exitEndpointSelector) healthLocked(now time.Time, udp bool, fallback bool) []lbcore.Health {
	s.ensureBuffersLocked()
	/*
		UDP 会话：从没回过 UDP 探活包的出口（版本过旧 / UDP 一直不通）算软信号 —— 有验证过的就先用验证过的，
		摘除有上限，不会因此没出口可用。只在真有一台验证过、UDP 通的出口时才这么算（F5）：全都没验证过时（这一版刚上线、
		对端都还没升级）个个都是软信号，摘除上限一卡，一半出口白白分不到 UDP 新会话，又没有更好的可选。
	*/
	preferVerified := false
	if udp {
		for _, state := range s.states {
			if state.udpVerifiedUp() {
				preferVerified = true
				break
			}
		}
	}
	for i, state := range s.states {
		ok, cooling := state.reachable(udp, now)
		health := lbcore.Health{Dead: !ok, Cooling: cooling}
		if preferVerified && ok && state.udpUnverifiedNow() {
			health.Soft = true
		}
		if ok && s.endpointReportsTarget(i) {
			target := s.target.health[i]
			health.DownstreamDown = target.down
			switch {
			case target.down:
			case fallback:
				health.Soft = health.Soft || (target.unstable && s.target.detect.action != "ignore") ||
					(!target.upAt.IsZero() && now.Sub(target.upAt) < fxpTargetFailbackStable)
			default:
				health.Soft = health.Soft || (target.unstable && s.target.detect.action == "switch")
			}
		}
		s.healthBuf[i] = health
	}
	return s.healthBuf
}

// candidatesLocked：这一次可以挑的出口（lbcore.Candidates：摘除有上限、不够就恐慌，见 lbcore/tier.go）。
// 调用方持锁；返回的切片是选择器自己的临时区，下一次调用就会被覆盖。
func (s *exitEndpointSelector) candidatesLocked(excluded map[int]bool, now time.Time, udp bool) ([]int, lbcore.Level) {
	candidates, level := lbcore.Candidates(s.candBuf[:0], s.healthLocked(now, udp, false), excluded, lbcore.EjectPolicy{})
	s.candBuf = candidates
	return candidates, level
}

/*
fallbackChoiceLocked：主备现在该走哪台（pick 和上报「在用的是谁」共用，不计数）。调用方持锁。

lbcore.First：稳的 → 不稳 / 刚恢复的 → 到目标不通的 → 出口本身连不上的，同一类里按配置的先后。
出口本身连不上的，只要还有一台连得上就不挑 —— 以前「到目标稳不稳」排在「出口连不连得上」前面，主出口握手失败、
备用只是不稳时挑中的还是主出口，新连接全撞在死出口上；UDP 新会话没有重放，直接终身钉死（路线图 X1）。
*/
func (s *exitEndpointSelector) fallbackChoiceLocked(excluded map[int]bool, now time.Time, udp bool) (int, bool) {
	index := lbcore.First(s.healthLocked(now, udp, true), excluded)
	return index, index >= 0
}

/*
fillMembersLocked：把候选此刻的负载和质量填进 s.members。调用方持锁。

	Weight       按权重：权重（没填当 1）；其余：分量（线路带宽，或者权重，或者一样大，见 endpointCapacities）
	Share        慢启动（出口刚恢复 60 秒内，exit_load.go）× 到目标刚恢复的慢启动 ×「不稳的少分」（面板设的动作是少分时 0.25）
	Active       挂在这台出口上的会话（TCP、UDP 都算）
	InFlight     刚挑中的（挑中就记，5 秒衰减）
	Latency      自动：入口到出口握手耗时的 peak EWMA 读数 + 出口到目标的中位数；延迟优先：握手的普通平均 + 中位数
	Jitter、Loss 出口到目标最近 30 次的抖动、丢包
	Utilisation  这台出口最近的流量 ÷ 线路带宽（配置里写了线路带宽才有）

自动 / 延迟优先不乘「不稳的少分」：抖动和丢包已经在成本里了，再乘一次是罚两遍。
*/
func (s *exitEndpointSelector) fillMembersLocked(candidates []int, now time.Time) {
	quality := s.strategy == "auto" || s.strategy == "latency"
	weighted := s.strategy == "weighted"
	want := fxpSnapshotShare
	switch {
	case quality:
		want = fxpSnapshotAll
	case s.strategy == "least_load" || s.strategy == "ip_hash":
		want = fxpSnapshotLoad
	}
	for _, index := range candidates {
		load := s.loads[index]
		snap := load.snapshotOf(now, want)
		member := lbcore.Member{Weight: s.capacities[index], Share: snap.slowStart, Active: snap.active, InFlight: snap.recent}
		if weighted {
			member.Weight = s.weights[index]
		}
		if mbps := s.endpoints[index].CapacityMbps; mbps > 0 && snap.rate > 0 {
			member.Utilisation = snap.rate * 8 / (float64(mbps) * 1e6)
		}
		if quality {
			load.noteLatencyUsed(now)
			if s.strategy == "auto" {
				member.Latency = snap.peak
			} else {
				member.Latency = snap.latency
			}
		}
		if s.endpointReportsTarget(index) {
			target := s.target.health[index]
			if s.target.detect.slowStart {
				member.Share *= lbcore.DefaultSlowStart.Factor(target.upAt, now)
			}
			if quality {
				stats := target.stats()
				member.Latency += stats.median
				member.Jitter = stats.jitter
				member.Loss = stats.loss
			} else if target.unstable && !target.down && s.target.detect.action == "reduce" {
				member.Share *= fxpTargetReducedShare
			}
		}
		s.members[index] = member
	}
}

// chooseLocked：这一条新会话给谁。不计数、不动负载（pick 负责）。udp 为 true 是给 UDP 会话挑。调用方持锁。
func (s *exitEndpointSelector) chooseLocked(excluded map[int]bool, selectionKey string, now time.Time, udp bool) (int, bool) {
	candidates, level := s.candidatesLocked(excluded, now, udp)
	if len(candidates) == 0 {
		return -1, false
	}
	// 目标本身挂了（连得上的出口到目标全都不通，而且是刚测的）：换哪台都一样，只试一台，轮着来 ——
	// 轮着是为了每台都有机会最先发现目标回来了（路线图 X8）。
	if level == lbcore.LevelPanic && s.targetDownOnAllLocked(candidates, now) {
		index := candidates[s.downNext%len(candidates)]
		s.downNext = (s.downNext + 1) % 1000000
		return index, true
	}
	if s.strategy == "fallback" {
		return s.fallbackChoiceLocked(excluded, now, udp)
	}
	s.fillMembersLocked(candidates, now)
	options := lbcore.Options{Scratch: s.scoreBuf}
	if s.strategy == lbcore.StrategyLatency {
		options.Near = lbcore.NearPolicy{Margin: lbcore.DefaultLatencyMargin, Hold: lbcore.DefaultNearHold}
		if s.targetAware() {
			options.Near.Margin = s.target.detect.margin
		}
		options.NearScratch = s.nearBuf
	}
	state := lbcore.State{WRR: s.current, Near: &s.near, Next: &s.next}
	index := lbcore.Pick(s.strategy, state, s.members, s.hashAddrs, candidates, selectionKey, now, s, options)
	if s.strategy == lbcore.StrategyLatency {
		for _, candidate := range candidates {
			if s.members[candidate].Latency > 0 && !s.near.Contains(candidate) {
				// 这台因为延迟这一轮不分：记下来，维护循环会勤量它（路线图 X10）。
				s.loads[candidate].noteLatencyStarved(now)
			}
		}
	}
	return index, index >= 0
}

// prewarmTargetsLocked：现在会用到哪几台（预热用）。只看，不动轮询 / 加权的状态，也不算一次挑选。调用方持锁。
func (s *exitEndpointSelector) prewarmTargetsLocked(now time.Time) []int {
	if s.strategy == "fallback" {
		if index, ok := s.fallbackChoiceLocked(nil, now, false); ok {
			return []int{index}
		}
		return nil
	}
	candidates, _ := s.candidatesLocked(nil, now, false)
	return append([]int(nil), candidates...)
}

/*
pickSessionAffinity：叠加（多路径）连接的各条腿走不同的中继，每台中继都要替自己那条腿挑出口。
各挑各的（轮询计数、负载都是本机视角）会把同一个会话的腿分到不同出口上 —— 出口各自只收到一部分
分片，拼不回来，连接卡住直到超时重置。这里按会话 id 做纯 rendezvous 哈希（只看容量，不看本机负载、
不看到目标的健康），每台中继拿到的出口列表一样，同一个会话就落在同一台出口上；不同会话仍按容量分散到各台出口。

不设上限（lbcore.RendezvousOptions{LoadFactor: -1}）：各台中继看到的负载不一样，带上限就算不出同一个结果了。
哈希和「按访客固定」是同一个（2.2.147 起搅过；这一版要求各台都升级，不再留和老版本逐位一致的那一份）。
主备（fallback）本来各台中继就挑同一个，照旧。调用方不持锁。
*/
func (s *exitEndpointSelector) pickSessionAffinity(excluded map[int]bool, sessionID string) (exitEndpoint, int, bool) {
	if s == nil {
		return exitEndpoint{}, -1, false
	}
	if s.strategy == "fallback" || strings.TrimSpace(sessionID) == "" {
		return s.pick(excluded, sessionID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.endpoints) == 0 {
		return exitEndpoint{}, -1, false
	}
	now := time.Now()
	s.ensureBuffersLocked()
	for i, state := range s.states {
		ok, _ := state.reachable(false, now)
		s.healthBuf[i] = lbcore.Health{Dead: !ok}
		s.members[i] = lbcore.Member{Weight: s.capacities[i], Share: 1}
	}
	candidates, _ := lbcore.Candidates(s.candBuf[:0], s.healthBuf, excluded, lbcore.EjectPolicy{})
	s.candBuf = candidates
	if len(candidates) == 0 {
		return exitEndpoint{}, -1, false
	}
	best := lbcore.Rendezvous(s.members, s.hashAddrs, candidates, sessionID, lbcore.RendezvousOptions{LoadFactor: -1})
	s.countPickLocked(best)
	s.loads[best].notePick(now)
	return s.endpoints[best], best, true
}
