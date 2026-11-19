package main

import "github.com/zhongyizhu11-jpg/NEX/lbcore"

// 选路第 1 段：候选（见 failover_pick.go）。

/*
pickCandidatesLocked：先只要能用的；一条都没有时退回「不健康但没被管理上排除」的（不分层），让连接去碰碰运气。

「在哪些路径里挑」的规矩是 lbcore.Candidates（和 NEX 隧道的出口组同一个）：这边每条路径只有两个信号 ——
连不上（探测 / 中转提示判成不能用）和管理上排除（暂停 / 维护 / 流量停机，adminExcludedLocked，A5）。
还有能用的就只在能用的里挑，分层规格再只留最优一层（bestTierLocked）；一条能用的都没有时在没被排除的里摊开；
全都被排除时返回空：TCP 连接直接关，UDP 包丢掉。
*/
func (p *failoverProxy) pickCandidatesLocked(exclude map[int]bool, udp bool) []int {
	health := make([]lbcore.Health, len(p.spec.Targets))
	for i := range p.spec.Targets {
		health[i] = lbcore.Health{Excluded: p.adminExcludedLocked(i), Dead: !p.usableLocked(i, udp)}
	}
	candidates, level := lbcore.Candidates(nil, health, exclude, lbcore.EjectPolicy{})
	if level == lbcore.LevelNormal {
		return p.bestTierLocked(candidates)
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
	if !healthyOnly {
		return indices
	}
	return p.bestTierLocked(indices)
}

// bestTierLocked：分层规格下只留 indices 里最优（数字最小）的那一层（就地过滤）；不分层、不到两条时原样返回。
func (p *failoverProxy) bestTierLocked(indices []int) []int {
	if len(indices) < 2 || !failoverSpecTiered(p.spec) {
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
