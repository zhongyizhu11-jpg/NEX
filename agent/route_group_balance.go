package main

import (
	"hash/fnv"
	"math"
	"strconv"
	"time"
)

/*
线路组「新连接怎么分」（spread）里几种要算一算的：按权重、按负载、按访客固定，以及恢复后的慢启动。

  - 按权重：平滑加权轮询（nginx 那套）。以前是按权重随机，短时间里会连着几条都落在同一条路上，
    和 NEX 隧道出口组的「按权重」也对不上。
  - 按负载：(这条路上的活动连接 + 1) ÷ (权重 × 慢启动系数)，挑最小的；一样就轮着来。连接很长时
    （代理、视频）看「现在挂着多少」比数「新开了多少」准得多（HAProxy / nginx 的 least_conn）。
  - 按访客固定：加权 rendezvous 哈希。一条路挂了只有原来落在它上面的访客换路，其余人不动
    （以前是「哈希 % 健康的条数」，挂一条几乎所有人都换，要保持登录的服务全掉线）。
  - 慢启动：刚从挂掉恢复的路径 60 秒内从 10% 慢慢加到满份，免得新连接一下子全涌过去。

权重 ≤ 0 的路径不分新连接（和以前一样），除非所有路径都是 0。
*/

const (
	routeSlowStartWindow = 60 * time.Second
	routeSlowStartMin    = 0.1
)

func (p *failoverProxy) markSlowStartLocked(index int, now time.Time) {
	if len(p.slowStartAt) != len(p.spec.Targets) {
		p.slowStartAt = make([]time.Time, len(p.spec.Targets))
	}
	if index >= 0 && index < len(p.slowStartAt) {
		p.slowStartAt[index] = now
	}
}

func (p *failoverProxy) slowStartLocked(index int, now time.Time) float64 {
	if index < 0 || index >= len(p.slowStartAt) || p.slowStartAt[index].IsZero() {
		return 1
	}
	since := now.Sub(p.slowStartAt[index])
	if since >= routeSlowStartWindow {
		return 1
	}
	return math.Max(routeSlowStartMin, float64(since)/float64(routeSlowStartWindow))
}

// spreadWeightsLocked 每个候选的分量：权重 × 慢启动（slowStart 为 false 时不乘）。权重都 ≤ 0 时一律当 1。
func (p *failoverProxy) spreadWeightsLocked(candidates []int, now time.Time, slowStart ...bool) []float64 {
	applySlowStart := len(slowStart) == 0 || slowStart[0]
	weights := make([]float64, len(candidates))
	any := false
	for _, index := range candidates {
		if p.spec.Targets[index].Weight > 0 {
			any = true
			break
		}
	}
	for i, index := range candidates {
		weight := float64(p.spec.Targets[index].Weight)
		if !any {
			weight = 1
		}
		if weight > 0 && applySlowStart {
			weight *= p.slowStartLocked(index, now)
		}
		weights[i] = weight
	}
	return weights
}

// weightedPickLocked：按权重，平滑加权轮询。权重乘 10 再乘慢启动系数取整（至少 1），
// 不在慢启动里时序列和直接按权重一模一样。
func (p *failoverProxy) weightedPickLocked(candidates []int) int {
	if len(candidates) == 0 {
		return -1
	}
	if len(p.wrrCurrent) != len(p.spec.Targets) {
		p.wrrCurrent = make([]int, len(p.spec.Targets))
	}
	weights := p.spreadWeightsLocked(candidates, time.Now())
	total, best := 0, -1
	for i, index := range candidates {
		if weights[i] <= 0 {
			continue
		}
		weight := int(math.Max(1, math.Round(weights[i]*10)))
		total += weight
		p.wrrCurrent[index] += weight
		if best < 0 || p.wrrCurrent[index] > p.wrrCurrent[best] {
			best = index
		}
	}
	if best < 0 {
		return candidates[0]
	}
	p.wrrCurrent[best] -= total
	return best
}

// leastLoadPickLocked：按负载，(活动连接 + 1) ÷ 分量 最小的；一样就从轮转的起点往后数第一个。
func (p *failoverProxy) leastLoadPickLocked(candidates []int) int {
	if len(candidates) == 0 {
		return -1
	}
	weights := p.spreadWeightsLocked(candidates, time.Now())
	start := p.roundRobinNext % len(candidates)
	p.roundRobinNext = (p.roundRobinNext + 1) % 1000000
	best, bestCost := -1, 0.0
	for offset := range candidates {
		i := (start + offset) % len(candidates)
		if weights[i] <= 0 {
			continue
		}
		cost := float64(p.connectionsLocked(candidates[i])+1) / weights[i]
		if best < 0 || cost < bestCost {
			best, bestCost = candidates[i], cost
		}
	}
	if best < 0 {
		return candidates[start]
	}
	return best
}

// rendezvousPickLocked：按访客固定。每条路径按「访客 + 路径」算一个分（按权重加权），分最高的拿走。
// 不乘慢启动：乘了的话恢复那一分钟里访客会先被挪走、再被挪回来，正是按访客固定要避免的。
func (p *failoverProxy) rendezvousPickLocked(candidates []int, key string) int {
	if len(candidates) == 0 {
		return -1
	}
	weights := p.spreadWeightsLocked(candidates, time.Now(), false)
	best, bestScore := -1, 0.0
	for i, index := range candidates {
		if weights[i] <= 0 {
			continue
		}
		target := p.spec.Targets[index]
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(key))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(target.TargetIP + ":" + strconv.Itoa(target.TargetPort) + "#" + strconv.Itoa(index)))
		u := (float64(hash.Sum64()>>11) + 0.5) / float64(uint64(1)<<53)
		score := -weights[i] / math.Log(u)
		if best < 0 || score > bestScore {
			best, bestScore = index, score
		}
	}
	if best < 0 {
		return candidates[0]
	}
	return best
}
