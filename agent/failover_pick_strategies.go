package main

import "github.com/zhongyizhu11-jpg/NEX/lbcore"

/*
选路第 2 段：按策略挑（见 failover_pick.go）。候选由第 1 段给（非空）。

八种分配方式的名字和算法都在 lbcore（和 NEX 隧道的出口组是同一套，见 lbcore/strategy.go）：

	auto / least_load / latency / weighted / round_robin / random / ip_hash
	    在候选里「分」—— 都走 strategySpreadLocked → spreadPickLocked（route_group_balance.go）→ lbcore.Pick。
	fallback
	    主备：一次只用一条。「现在走哪条」是这边自己的状态机（activeIndex：粘性、切回、择优、时段表、人工指定，
	    failover_selection.go）；这里只负责在走的那条用不了时换哪条。

加一种分法：在 lbcore 里加，这里的表里登记一行。
*/

type failoverStrategy struct {
	// 在候选里挑一条，返回下标。
	pick func(p *failoverProxy, request failoverPickRequest) int
	// 挑完以后要不要在这条所在的线路里再分（第 3 段，failover_pick_refine.go）。只有主备要：按权重这些
	// 本来就在整组里分。
	spreadWithinLine bool
}

var failoverStrategies = map[string]failoverStrategy{
	lbcore.StrategyFallback:   {pick: (*failoverProxy).strategyFallbackLocked, spreadWithinLine: true},
	lbcore.StrategyWeighted:   {pick: (*failoverProxy).strategySpreadLocked},
	lbcore.StrategyLeastLoad:  {pick: (*failoverProxy).strategySpreadLocked},
	lbcore.StrategyAuto:       {pick: (*failoverProxy).strategySpreadLocked},
	lbcore.StrategyLatency:    {pick: (*failoverProxy).strategySpreadLocked},
	lbcore.StrategyRoundRobin: {pick: (*failoverProxy).strategySpreadLocked},
	lbcore.StrategyRandom:     {pick: (*failoverProxy).strategySpreadLocked},
	lbcore.StrategyIPHash:     {pick: (*failoverProxy).strategySpreadLocked},
}

// 认不出的策略按主备（规格规整时已经把认不出的改成 fallback 了，这里再兜一次底）。
func failoverStrategyFor(name string) failoverStrategy {
	if strategy, ok := failoverStrategies[name]; ok {
		return strategy
	}
	return failoverStrategies[lbcore.StrategyFallback]
}

// 主备：在走的那条能用就走它。TCP+UDP 规格的 UDP 会话按 UDP 那一侧另挑（route_group_udp_health.go）。
func (p *failoverProxy) strategyFallbackLocked(request failoverPickRequest) int {
	if request.udp && p.udpSeparateLocked() {
		return p.udpFallbackIndexLocked(request.candidates, request.exclude)
	}
	// 在走的那条被管理上排除了（暂停 / 维护）而候选是兜底：它不在候选里，也按「用不了」处理。
	if !p.healthyLocked(p.activeIndex) || (request.exclude != nil && request.exclude[p.activeIndex]) {
		// 当前这条用不了（挂了、或这条连接刚在它上面拨失败）：在候选里优先挑出口 IP 一样的（2.2.251），
		// 没有就还是第一条，和以前一样。全都不健康时候选是兜底的那些（不含管理上排除的），挑不出健康的，照旧第一条。
		index := request.candidates[0]
		if pick, _ := p.escapePickLocked(request.candidates, p.activeIndex, -1, request.udp); pick >= 0 {
			index = pick
		}
		return index
	}
	return p.activeIndex
}

// 在候选里分：按规格里的分配方式交给 lbcore。
func (p *failoverProxy) strategySpreadLocked(request failoverPickRequest) int {
	return p.spreadPickLocked(p.spec.Strategy, request.candidates, request.hashKey)
}
