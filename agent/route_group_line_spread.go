package main

import (
	"strconv"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
线路里几个落地一起分（2.2.245，面板 2.3.501「落地怎么分」）。

一条线路可以有几个落地（「+ 并列」加的、落地池里的几台）。以前不管怎么配，主备逻辑（稳定优先、整链最优、
按时段、人工指定都是 fallback）一次只挑一条路径，几个落地里只用一个，其余的候着。现在线路可以选一种分法 ——
就是 lbcore 的那几种（和整组分、和 NEX 隧道的出口组同一套算法）：

	auto        自动：成本 = 延迟 × 丢包系数 × (这个落地的连接 + 1) ÷ 余量，挑最低的
	least_load  按负载：给现在挂着连接最少的那个落地
	latency     延迟优先：只在和最快的差不多快的几个落地里分
	round_robin 轮流
	random      随机
	ip_hash     按访客固定：按「访客 + 落地」算分（加权 rendezvous，不设负载上限），一个落地挂了只有原来在它上面的访客换

连接数都按落地合着算：经不同中转到同一个落地的几条路径，连接加在一起。

主备逻辑照旧决定走哪条线路（activeIndex 落在哪条线路上），这里只在那条线路里面分：每个落地出一条代表 ——
挑出来的那条代表它自己的落地，别的落地取这条线路上健康、没被排除的里面下标最小的那条（面板展开时已经按
整链估计 / 顺序排好）。能用的落地不到两个时就是主备挑出来的那条，和以前一样。

有落地挂了时，两处优先挑和它同出口 IP 的落地（2.2.251）：按负载里成本不比它高的、按访客固定里那个访客原本的落地挂了时。

规格里不带 Line / Spread 的目标完全不受影响；面板只在「一次走一条线路」时才带（按权重、聚合 / 复制时
整组本来就在分）。
*/

// 线路里能选的分法：lbcore 的八种里去掉主备（线路里再主备没有意义）和按权重（落地没有各自的权重）。
func validLineSpread(spread string) bool {
	switch spread {
	case lbcore.StrategyLeastLoad, lbcore.StrategyRoundRobin, lbcore.StrategyRandom, lbcore.StrategyIPHash, lbcore.StrategyAuto, lbcore.StrategyLatency:
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
	now := time.Now()
	// 同一个落地的连接合着算。
	landingLoad := func(index int) (active, inflight int) {
		landing := p.lineLandingLocked(index)
		for i := range p.spec.Targets {
			if p.sameLineLocked(i, line) && p.lineLandingLocked(i) == landing {
				a, f := p.pathLoadLocked(i)
				active, inflight = active+a, inflight+f
			}
		}
		return active, inflight
	}
	members := p.membersLocked(reps, head.Spread, now, udp, landingLoad)
	// 落地没有各自的权重：都按一样大（代表那条路径的权重是整组分时用的，这里不看）。
	for _, index := range reps {
		members[index].Weight = 1
	}
	key := hashKey
	var keys []string
	if head.Spread == lbcore.StrategyIPHash && key != "" {
		// 按落地算分，不按下标：同一个落地换了中转、主备换了挑出来的那条，访客还落在这个落地上。
		keys = p.lineLandingKeysLocked()
	}
	state := p.spreadStateLocked(members, reps, false)
	best := lbcore.Pick(head.Spread, state, members, keys, reps, key, now, p.randLocked(), p.pickOptionsLocked())
	switch {
	case head.Spread == lbcore.StrategyLeastLoad:
		// 有落地挂了：成本不比挑中的高的几个里，优先和挂掉那个同出口 IP 的（2.2.251）。
		if deadExits := p.lineDeadExitIPsLocked(line, reps, exclude, udp); len(deadExits) > 0 && !deadExits[p.exitIPLocked(best)] {
			bestCost, _ := lbcore.Cost(members, reps, best, true)
			for _, index := range reps {
				if cost, ok := lbcore.Cost(members, reps, index, true); ok && cost <= bestCost && deadExits[p.exitIPLocked(index)] {
					return index
				}
			}
		}
	case keys != nil:
		// 这个访客原本的落地（算上挂了的、不看负载）不在能用的里面：优先换到同出口 IP 的落地上去（2.2.251），没有就照旧。
		all := p.lineLandingIndicesLocked(line)
		for _, index := range all {
			if members[index].Weight == 0 {
				members[index] = lbcore.Member{Weight: 1, Share: 1}
			}
		}
		home := lbcore.Rendezvous(members, keys, all, key, lbcore.RendezvousOptions{LoadFactor: -1})
		if home >= 0 && !p.lineHasLandingLocked(reps, home) {
			if want := p.exitIPLocked(home); want != "" {
				sameExit := make([]int, 0, len(reps))
				for _, index := range reps {
					if p.exitIPLocked(index) == want {
						sameExit = append(sameExit, index)
					}
				}
				if len(sameExit) > 0 {
					return lbcore.Rendezvous(members, keys, sameExit, key, lbcore.RendezvousOptions{})
				}
			}
		}
	}
	return best
}

// 每条路径所在落地的标识（按路径下标排），按访客固定算分用。
func (p *failoverProxy) lineLandingKeysLocked() []string {
	keys := make([]string, len(p.spec.Targets))
	for i := range p.spec.Targets {
		keys[i] = p.lineLandingLocked(i)
	}
	return keys
}

// indices 里有没有 index 那个落地的代表。
func (p *failoverProxy) lineHasLandingLocked(indices []int, index int) bool {
	landing := p.lineLandingLocked(index)
	for _, candidate := range indices {
		if p.lineLandingLocked(candidate) == landing {
			return true
		}
	}
	return false
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
