package main

// 选路第 1 段：候选（见 failover_pick.go）。

// pickCandidatesLocked：先只要能用的；一条都没有时退回全部（不分层），让连接去碰碰运气。
func (p *failoverProxy) pickCandidatesLocked(exclude map[int]bool, udp bool) []int {
	candidates := p.candidateIndicesForLocked(exclude, true, udp)
	if len(candidates) == 0 {
		candidates = p.candidateIndicesForLocked(exclude, false, udp)
	}
	return candidates
}

/*
候选路径。healthyOnly 时只要健康的；分层规格（failoverSpecTiered）下再只留「还有健康
出站的最优一层」—— 权重 / 最少连接只在主线路组里分，整个主组都挂了才轮到备用组。
healthyOnly=false（全挂时的兜底）不分层，和以前一样。
*/
func (p *failoverProxy) candidateIndicesLocked(exclude map[int]bool, healthyOnly bool) []int {
	return p.candidateIndicesForLocked(exclude, healthyOnly, false)
}

// udp 为 true 时「健康」按 UDP 那一侧算（udpUsableLocked）：TCP+UDP 规格的 UDP 会话用。
func (p *failoverProxy) candidateIndicesForLocked(exclude map[int]bool, healthyOnly bool, udp bool) []int {
	indices := make([]int, 0, len(p.spec.Targets))
	for i := range p.spec.Targets {
		if exclude != nil && exclude[i] {
			continue
		}
		if healthyOnly && !p.usableLocked(i, udp) {
			continue
		}
		indices = append(indices, i)
	}
	if !healthyOnly || len(indices) < 2 || !failoverSpecTiered(p.spec) {
		return indices
	}
	best := p.lowestTierLocked(indices)
	filtered := indices[:0]
	for _, i := range indices {
		if *p.spec.Targets[i].Tier == best {
			filtered = append(filtered, i)
		}
	}
	return filtered
}

// indices 里最优（数字最小）的一层。调用方保证规格是分层的、indices 非空。
func (p *failoverProxy) lowestTierLocked(indices []int) int {
	best := *p.spec.Targets[indices[0]].Tier
	for _, i := range indices[1:] {
		if tier := *p.spec.Targets[i].Tier; tier < best {
			best = tier
		}
	}
	return best
}
