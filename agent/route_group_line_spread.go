package main

import (
	"hash/fnv"
	"strconv"
	"time"
)

/*
线路里几个落地一起分（2.2.245，面板 2.3.501「落地怎么分」）。

一条线路可以有几个落地（「+ 并列」加的、落地池里的几台）。以前不管怎么配，主备逻辑（稳定优先、整链最优、
按时段、人工指定都是 fallback）一次只挑一条路径，几个落地里只用一个，其余的候着。现在线路可以选：

	least_load  按负载分：给现在挂着连接最少的那个落地（经不同中转到同一个落地的几条，连接加在一起算）
	round_robin 轮流
	random      随机
	ip_hash     按访客固定：按「访客 + 落地」算分（加权 rendezvous），一个落地挂了只有原来在它上面的访客换
	auto        自动（2.2.251）：按最近延迟和面板给的主机负载算有效权重（route_group_balance.go 的 autoWeightsLocked），
	            随机挑两个落地、取「这个落地的连接数 ÷ 有效权重」更小的那个

主备逻辑照旧决定走哪条线路（activeIndex 落在哪条线路上），这里只在那条线路里面分：每个落地出一条代表 ——
挑出来的那条代表它自己的落地，别的落地取这条线路上健康、没被排除的里面下标最小的那条（面板展开时已经按
整链估计 / 顺序排好）。能用的落地不到两个时就是主备挑出来的那条，和以前一样。

规格里不带 Line / Spread 的目标完全不受影响；面板只在「一次走一条线路」时才带（按权重、聚合 / 复制时
整组本来就在分）。
*/

func validLineSpread(spread string) bool {
	switch spread {
	case "least_load", "round_robin", "random", "ip_hash", "auto":
		return true
	}
	return false
}

// 同一个落地的标识：面板没给就按下标，等于每条路径各算一个落地。
func (p *failoverProxy) lineLandingLocked(index int) string {
	if landing := p.spec.Targets[index].Landing; landing != "" {
		return landing
	}
	return "#" + strconv.Itoa(index)
}

func (p *failoverProxy) sameLineLocked(index int, line int) bool {
	target := p.spec.Targets[index]
	return target.Line != nil && *target.Line == line && validLineSpread(target.Spread)
}

// spreadWithinLineLocked：anchor 是主备逻辑挑出来的那条；它所在的线路选了「一起分」时，在这条线路的几个落地
// 里按分法重新挑一条。调用方持有 p.mu。
func (p *failoverProxy) spreadWithinLineLocked(anchor int, hashKey string, exclude map[int]bool, udp bool) int {
	if anchor < 0 || anchor >= len(p.spec.Targets) {
		return anchor
	}
	head := p.spec.Targets[anchor]
	if head.Line == nil || !validLineSpread(head.Spread) {
		return anchor
	}
	line := *head.Line
	reps := []int{anchor}
	seen := map[string]bool{p.lineLandingLocked(anchor): true}
	for i := range p.spec.Targets {
		if i == anchor || !p.sameLineLocked(i, line) {
			continue
		}
		if exclude != nil && exclude[i] {
			continue
		}
		if !p.usableLocked(i, udp) {
			continue
		}
		landing := p.lineLandingLocked(i)
		if seen[landing] {
			continue
		}
		seen[landing] = true
		reps = append(reps, i)
	}
	if len(reps) < 2 {
		return anchor
	}
	switch head.Spread {
	case "least_load":
		now := time.Now()
		start := p.roundRobinNext % len(reps)
		p.roundRobinNext = (p.roundRobinNext + 1) % 1000000
		// 有落地挂了：负载一样的几个里优先挑和挂掉那个同出口 IP 的（2.2.251）。
		deadExits := p.lineDeadExitIPsLocked(line, reps, exclude, udp)
		best, bestCost, bestSameExit := -1, 0.0, false
		for offset := range reps {
			index := reps[(start+offset)%len(reps)]
			landing := p.lineLandingLocked(index)
			conns := 0
			for i := range p.spec.Targets {
				if p.sameLineLocked(i, line) && p.lineLandingLocked(i) == landing {
					conns += p.connectionsLocked(i)
				}
			}
			// 刚恢复的落地 60 秒内慢慢加量，和整组「按负载」一样。
			cost := float64(conns+1) / p.slowStartLocked(index, now)
			sameExit := len(deadExits) > 0 && deadExits[p.exitIPLocked(index)]
			if best < 0 || cost < bestCost || (cost == bestCost && sameExit && !bestSameExit) {
				best, bestCost, bestSameExit = index, cost, sameExit
			}
		}
		return best
	case "auto":
		// 同一个落地的连接合着算（和按负载分一样），有效权重按代表那条路径的延迟和负载。
		weights := p.autoWeightsLocked(reps, time.Now())
		return p.powerOfTwoPickLocked(reps, weights, func(index int) int {
			landing := p.lineLandingLocked(index)
			conns := 0
			for i := range p.spec.Targets {
				if p.sameLineLocked(i, line) && p.lineLandingLocked(i) == landing {
					conns += p.connectionsLocked(i)
				}
			}
			return conns
		})
	case "round_robin":
		index := reps[p.roundRobinNext%len(reps)]
		p.roundRobinNext = (p.roundRobinNext + 1) % 1000000
		return index
	case "random":
		if p.rng == nil {
			p.rng = newFailoverRand(p.ruleID, p.sourcePort)
		}
		return reps[p.rng.Intn(len(reps))]
	case "ip_hash":
		key := hashKey
		if key == "" {
			key = strconv.Itoa(p.sourcePort)
		}
		// 按落地算分，不按下标：同一个落地换了中转、主备换了挑出来的那条，访客还落在这个落地上。
		best := p.rendezvousLandingLocked(reps, key)
		// 这个访客原本的落地（算上挂了的）用不了：优先换到同出口 IP 的落地上去（2.2.251），没有就照旧。
		if home := p.rendezvousLandingLocked(p.lineLandingIndicesLocked(line), key); home >= 0 && p.lineLandingLocked(home) != p.lineLandingLocked(best) {
			if want := p.exitIPLocked(home); want != "" {
				sameExit := make([]int, 0, len(reps))
				for _, index := range reps {
					if p.exitIPLocked(index) == want {
						sameExit = append(sameExit, index)
					}
				}
				if len(sameExit) > 0 {
					return p.rendezvousLandingLocked(sameExit, key)
				}
			}
		}
		return best
	}
	return anchor
}

// 这条线路上每个落地出一条代表（不管健不健康），按下标顺序。
func (p *failoverProxy) lineLandingIndicesLocked(line int) []int {
	indices := make([]int, 0, len(p.spec.Targets))
	seen := map[string]bool{}
	for i := range p.spec.Targets {
		if !p.sameLineLocked(i, line) {
			continue
		}
		landing := p.lineLandingLocked(i)
		if seen[landing] {
			continue
		}
		seen[landing] = true
		indices = append(indices, i)
	}
	return indices
}

// 按「访客 + 落地」算 rendezvous 分：indices 里分最高的那条；空的是 -1。
func (p *failoverProxy) rendezvousLandingLocked(indices []int, key string) int {
	best, bestScore := -1, uint64(0)
	for _, index := range indices {
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(key))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(p.lineLandingLocked(index)))
		if score := hash.Sum64(); best < 0 || score > bestScore {
			best, bestScore = index, score
		}
	}
	return best
}

// closeOldLineConnsLocked：从一条「一起分」的线路切到别的线路时，旧线路别的落地上的连接按切换方式处理 ——
// 强制切换全断（「每次切换都断开旧连接」），快速切换只断已经坏了的（死连接留着客户端不会重连），平滑切换
// 不动。旧的那条本身由 setActiveLocked 照原来的规矩处理，这里跳过它。调用方持有 p.mu。
func (p *failoverProxy) closeOldLineConnsLocked(old, next int) int {
	if old < 0 || old >= len(p.spec.Targets) || next < 0 || next >= len(p.spec.Targets) {
		return 0
	}
	from := p.spec.Targets[old]
	if from.Line == nil || !validLineSpread(from.Spread) {
		return 0
	}
	line := *from.Line
	if p.sameLineLocked(next, line) {
		return 0
	}
	closed := 0
	for i := range p.spec.Targets {
		if i == old || !p.sameLineLocked(i, line) {
			continue
		}
		switch p.spec.SwitchMode {
		case "force":
			closed += p.closeConnsLocked(i)
		case "fast":
			if !p.healthyLocked(i) {
				closed += p.closeConnsLocked(i)
			}
		}
	}
	return closed
}
