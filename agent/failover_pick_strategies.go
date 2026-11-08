package main

import "strconv"

/*
选路第 2 段：按策略挑（见 failover_pick.go）。每种「新连接怎么分」一个函数，候选由第 1 段给（非空）。

要算一算的几种（按权重的平滑加权轮询、按负载、按访客固定的加权 rendezvous、自动的有效权重和随机挑两条）
算法本身在 route_group_balance.go，这里只是把它们接到候选上。加一种分法：写一个函数，在 failoverStrategies
里登记一行。
*/

type failoverStrategy struct {
	// 在候选里挑一条，返回下标。
	pick func(p *failoverProxy, request failoverPickRequest) int
	// 挑完以后要不要在这条所在的线路里再分（第 3 段，failover_pick_refine.go）。只有主备要：按权重这些
	// 本来就在整组里分。
	spreadWithinLine bool
}

var failoverStrategies = map[string]failoverStrategy{
	"fallback":    {pick: (*failoverProxy).strategyFallbackLocked, spreadWithinLine: true},
	"weighted":    {pick: (*failoverProxy).strategyWeightedLocked},
	"least_load":  {pick: (*failoverProxy).strategyLeastLoadLocked},
	"auto":        {pick: (*failoverProxy).strategyAutoLocked},
	"round_robin": {pick: (*failoverProxy).strategyRoundRobinLocked},
	"random":      {pick: (*failoverProxy).strategyRandomLocked},
	"ip_hash":     {pick: (*failoverProxy).strategyIPHashLocked},
}

// 认不出的策略按主备（规格规整时已经把认不出的改成 fallback 了，这里再兜一次底）。
func failoverStrategyFor(name string) failoverStrategy {
	if strategy, ok := failoverStrategies[name]; ok {
		return strategy
	}
	return failoverStrategies["fallback"]
}

// 主备：在走的那条能用就走它。TCP+UDP 规格的 UDP 会话按 UDP 那一侧另挑（route_group_udp_health.go）。
func (p *failoverProxy) strategyFallbackLocked(request failoverPickRequest) int {
	if request.udp && p.udpSeparateLocked() {
		return p.udpFallbackIndexLocked(request.candidates, request.exclude)
	}
	if !p.healthyLocked(p.activeIndex) || (request.exclude != nil && request.exclude[p.activeIndex]) {
		// 当前这条用不了（挂了、或这条连接刚在它上面拨失败）：在候选里优先挑出口 IP 一样的（2.2.251），
		// 没有就还是第一条，和以前一样。全都不健康时候选是兜底的全部，挑不出健康的，照旧第一条。
		index := request.candidates[0]
		if pick, _ := p.escapePickLocked(request.candidates, p.activeIndex, -1, request.udp); pick >= 0 {
			index = pick
		}
		return index
	}
	return p.activeIndex
}

// 按权重：平滑加权轮询（weightedPickLocked）。
func (p *failoverProxy) strategyWeightedLocked(request failoverPickRequest) int {
	return p.weightedPickLocked(request.candidates)
}

// 按负载：(活动连接 + 1) ÷ 分量最小的（leastLoadPickLocked）。
func (p *failoverProxy) strategyLeastLoadLocked(request failoverPickRequest) int {
	return p.leastLoadPickLocked(request.candidates)
}

// 自动：按延迟和沿途负载算有效权重，随机挑两条取更好的（autoPickLocked）。
func (p *failoverProxy) strategyAutoLocked(request failoverPickRequest) int {
	return p.autoPickLocked(request.candidates)
}

// 轮流：候选里按轮转计数挑，计数每次加一。
func (p *failoverProxy) strategyRoundRobinLocked(request failoverPickRequest) int {
	index := request.candidates[p.roundRobinNext%len(request.candidates)]
	p.roundRobinNext = (p.roundRobinNext + 1) % 1000000
	return index
}

// 随机：候选里随机一条。
func (p *failoverProxy) strategyRandomLocked(request failoverPickRequest) int {
	if p.rng == nil {
		p.rng = newFailoverRand(p.ruleID, p.sourcePort)
	}
	return request.candidates[p.rng.Intn(len(request.candidates))]
}

// 按访客固定：加权 rendezvous 哈希（rendezvousPickLocked）。没有访客地址时按监听端口算，所有连接落在同一条上。
func (p *failoverProxy) strategyIPHashLocked(request failoverPickRequest) int {
	key := request.hashKey
	if key == "" {
		key = strconv.Itoa(p.sourcePort)
	}
	return p.rendezvousPickLocked(request.candidates, key)
}
