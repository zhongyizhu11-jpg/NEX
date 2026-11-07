package main

import (
	"time"
)

/*
TCP+UDP 规格下 UDP 那一侧单独的健康（2.2.251 起）。

以前 protocol=both 只拨 TCP 探测：一条路径 TCP 通、UDP 坏了（中转只转了 TCP、落地的 UDP 服务死了、
中间设备丢 UDP），照样被判成健康，UDP 会话还是往它上面分。现在两侧分开：

  - TCP 那一侧照旧（targetHealth / stats / activeIndex，TCP 连接的选路一点没变）；
  - UDP 那一侧每轮探测再探一次 UDP 端口（failoverProbeUDP），用同一套门槛（连续失败次数、异常多久切、
    恢复多久算好）单独记健康；
  - UDP 会话挑路径时（pickTargetForKeyProto(udp=true)）只在 UDP 通的路径里挑：主备策略下 TCP 在走的那条
    UDP 也通就跟着它走（两种流量走同一条，面板上一目了然）；不通就按同一套优先次序 —— 人工指定 > 时段表 >
    数组顺序（分层规格先按层）—— 找第一条 UDP 通的。自动择优只体现在 TCP 在走的那条上，这里不再单独
    为 UDP 算一份评分：这是最小的正确版本，UDP 在走的那条不进「现在走哪条」、不记切换事件。
    权重 / 轮流 / 随机 / 按访客的分法不变，只是候选换成 UDP 通的那几条。

只转 UDP 的规格不走这里：它的主健康本来就是 UDP 探出来的。只转 TCP 的规格也不走。
两侧的状态都随心跳报给面板（udpHealthy / udpLatencyMs），界面上 TCP 通 UDP 不通（或反过来）时标出来。
*/
type failoverUDPSide struct {
	health         []bool
	failureSince   []time.Time
	recoveredSince []time.Time
	lastLatencyMs  []int
	stats          []*routeTargetStats
}

func (s *failoverUDPSide) ensure(n int) {
	if len(s.health) != n {
		s.health = make([]bool, n)
		for i := range s.health {
			s.health[i] = true
		}
	}
	if len(s.failureSince) != n {
		s.failureSince = make([]time.Time, n)
	}
	if len(s.recoveredSince) != n {
		s.recoveredSince = make([]time.Time, n)
	}
	if len(s.lastLatencyMs) != n {
		s.lastLatencyMs = make([]int, n)
	}
	if len(s.stats) != n {
		s.stats = make([]*routeTargetStats, n)
	}
	for i := range s.stats {
		if s.stats[i] == nil {
			s.stats[i] = &routeTargetStats{}
		}
	}
}

// carried 按「还是同一条出站」（rebuildForSpecLocked 的 oldIndex）把状态搬到新下标上；新出站从头来。
func (s *failoverUDPSide) carried(n int, from func(i int) (int, bool)) failoverUDPSide {
	next := failoverUDPSide{}
	next.ensure(n)
	for i := 0; i < n; i++ {
		j, ok := from(i)
		if !ok || j < 0 || j >= len(s.health) {
			continue
		}
		next.health[i] = s.health[j]
		next.failureSince[i] = s.failureSince[j]
		next.recoveredSince[i] = s.recoveredSince[j]
		next.lastLatencyMs[i] = s.lastLatencyMs[j]
		if s.stats[j] != nil {
			next.stats[i] = s.stats[j]
		}
	}
	return next
}

// 这份规格要不要把 UDP 那一侧分开判：只有 TCP+UDP。
func (p *failoverProxy) udpSeparateLocked() bool {
	return failoverProtocol(p.spec) == "both"
}

// 这条出站此刻 UDP 能不能用：UDP 探测通，而且没被面板按「中转异常」标掉。不分侧的规格就是 healthyLocked。
func (p *failoverProxy) udpUsableLocked(index int) bool {
	if !p.udpSeparateLocked() {
		return p.healthyLocked(index)
	}
	if index < 0 || index >= len(p.spec.Targets) {
		return false
	}
	p.ensureHealthStateLocked()
	return p.udpSide.health[index] && !p.relayDown[index]
}

// usableLocked：udp 为 true 按 UDP 那一侧算，否则就是 healthyLocked。
func (p *failoverProxy) usableLocked(index int, udp bool) bool {
	if udp {
		return p.udpUsableLocked(index)
	}
	return p.healthyLocked(index)
}

/*
主备策略下给 UDP 会话挑哪条（调用方已持有 p.mu；candidates 是按 UDP 健康过滤、分层后的候选，非空）。

TCP 在走的那条 UDP 也通就用它；不通就按人工指定 > 时段表 > 数组顺序找第一条候选。不调 preferredLocked：
它里面的自动择优会改 fastestCandidate / fastestSince，选路的热路径不该动评估状态。
*/
func (p *failoverProxy) udpFallbackIndexLocked(candidates []int, exclude map[int]bool) int {
	inCandidates := func(index int) bool {
		for _, candidate := range candidates {
			if candidate == index {
				return true
			}
		}
		return false
	}
	if p.udpUsableLocked(p.activeIndex) && !(exclude != nil && exclude[p.activeIndex]) && inCandidates(p.activeIndex) {
		return p.activeIndex
	}
	now := time.Now()
	preferred := p.pinnedIndexAt(now)
	if preferred < 0 {
		preferred = failoverScheduleTargetIndexAt(p.spec.Schedule, now)
	}
	for _, index := range p.orderFromPreferredLocked(preferred) {
		if inCandidates(index) {
			return index
		}
	}
	return candidates[0]
}

// probeFailoverTargetsUDP 有界并行地探所有路径的 UDP 那一侧（TCP+UDP 规格的 checkHealth 用）。
func probeFailoverTargetsUDP(targets []failoverTarget) ([]int, []bool) {
	return probeFailoverTargetsWith(targets, failoverProbeUDP)
}

/*
applyUDPProbeLocked 把这一轮 UDP 探测的结果记到 UDP 那一侧：门槛和 TCP 那一侧（checkHealth）同一套。
翻转只写日志，不记事件、不重新选路 —— TCP 的「现在走哪条」不受 UDP 影响，UDP 会话下一次挑路径时自然避开。
调用方持有 p.mu。
*/
func (p *failoverProxy) applyUDPProbeLocked(results []bool, latencies []int, now time.Time) {
	p.ensureHealthStateLocked()
	side := &p.udpSide
	failoverSeconds := time.Duration(p.spec.FailoverSeconds) * time.Second
	recoverSeconds := time.Duration(p.spec.RecoverSeconds) * time.Second
	for i, ok := range results {
		if i >= len(p.spec.Targets) || i >= len(side.health) {
			break
		}
		if i < len(latencies) {
			side.lastLatencyMs[i] = latencies[i]
			side.stats[i].recordProbe(ok, latencies[i], now)
		}
		target := p.spec.Targets[i]
		if ok {
			side.failureSince[i] = time.Time{}
			if side.health[i] {
				side.recoveredSince[i] = time.Time{}
				continue
			}
			if side.recoveredSince[i].IsZero() {
				side.recoveredSince[i] = now
			} else if now.Sub(side.recoveredSince[i]) >= recoverSeconds {
				side.health[i] = true
				side.recoveredSince[i] = time.Time{}
				logf("failover target udp recovered rule=%d source=%d index=%d target=%s:%d", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort)
			}
			continue
		}
		side.recoveredSince[i] = time.Time{}
		if !side.health[i] {
			continue
		}
		if side.failureSince[i].IsZero() {
			side.failureSince[i] = now
		}
		if side.stats[i].consecutiveFailures >= p.spec.FailureThreshold && now.Sub(side.failureSince[i]) >= failoverSeconds {
			side.health[i] = false
			side.failureSince[i] = time.Time{}
			logf("failover target udp unhealthy rule=%d source=%d index=%d target=%s:%d reason=udp health check", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort)
		}
	}
}

// 报给面板的 UDP 那一侧：TCP+UDP 规格是单独那一侧；只转 UDP 的规格主健康就是 UDP 的；只转 TCP 的没有（nil）。
func (p *failoverProxy) udpReportLocked(index int) (*bool, int) {
	switch failoverProtocol(p.spec) {
	case "udp":
		healthy := p.healthyLocked(index)
		return &healthy, p.scoreInputLocked(index).latencyMs
	case "both":
		healthy := p.udpUsableLocked(index)
		latency := 0
		if index >= 0 && index < len(p.udpSide.stats) {
			summary := p.udpSide.stats[index].summary()
			if summary.hasLatency {
				latency = summary.latencyMs
			} else if index < len(p.udpSide.lastLatencyMs) {
				latency = p.udpSide.lastLatencyMs[index]
			}
		}
		return &healthy, latency
	}
	return nil, 0
}
