package main

/*
选路第 2 段里的主备（见 failover_pick.go）。另外七种分法（auto / least_load / latency / weighted / round_robin /
random / ip_hash）的名字和算法都在 lbcore（和 NEX 隧道的出口组是同一套，见 lbcore/strategy.go），这边只是把
路径填成 lbcore.Member 交过去（spreadPickLocked，route_group_balance.go）。加一种分法：在 lbcore 里加。

主备一次只用一条。「现在走哪条」是这边自己的状态机（activeIndex：粘性、切回、择优、时段表、人工指定，
failover_selection.go）；这里只负责在走的那条用不了时换哪条。
*/

// fallbackPickLocked：在走的那条能用就走它。TCP+UDP 规格的 UDP 会话按 UDP 那一侧另挑（route_group_udp_health.go）。
// candidates 是第 1 段给的候选（非空）。
func (p *failoverProxy) fallbackPickLocked(candidates []int, exclude map[int]bool, udp bool) int {
	if udp && p.udpSeparateLocked() {
		return p.udpFallbackIndexLocked(candidates, exclude)
	}
	// 在走的那条被管理上排除了（暂停 / 维护）而候选是兜底：它不在候选里，也按「用不了」处理。
	if !p.healthyLocked(p.activeIndex) || (exclude != nil && exclude[p.activeIndex]) {
		// 当前这条用不了（挂了、或这条连接刚在它上面拨失败）：在候选里优先挑出口 IP 一样的（2.2.251），
		// 没有就还是第一条，和以前一样。全都不健康时候选是兜底的那些（不含管理上排除的），挑不出健康的，照旧第一条。
		index := candidates[0]
		if pick, _ := p.escapePickLocked(candidates, p.activeIndex, -1, udp); pick >= 0 {
			index = pick
		}
		return index
	}
	return p.activeIndex
}
