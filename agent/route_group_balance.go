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
  - 自动（动态权重，2.2.251）：有效权重 = 静态权重 × 延迟系数 × 负载系数 × 慢启动。延迟系数是「几条里最快的
    那条的延迟 ÷ 这条的延迟」（探测延迟的指数平均再加面板给的下游延迟，压到 0.1–1），负载系数是 1 − 面板给的
    沿途主机负载（也压到 0.1–1）。挑的时候不是按权重随机一条，而是按权重随机挑**两条**，取「活动连接 + 1 ÷
    有效权重」更小的那条（power of two choices）：既不会全涌到最好的那条，又不会让一条慢路一直分到连接。

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

/*
「自动」分法的有效权重：静态权重 × 慢启动（spreadWeightsLocked）× 延迟系数 × 负载系数。

延迟取每条探测延迟的指数平均（routeTargetStats.latencyEwmaMs，还没探通就用最近一次探到的）再加面板给的下游
延迟 ExtraLatencyMs，和整链评分一个口径；几条里有一条还不知道延迟时，那条的延迟系数当 1（不罚它，探到再说）。
负载是面板给的 LoadPct（0 = 不知道，系数 1）。两个系数都压在 0.1–1：再慢、再忙也留一成，别把一条好端端的路彻底饿死。
*/
const routeAutoFactorMin = 0.1

func (p *failoverProxy) autoLatencyLocked(index int) float64 {
	latency := 0.0
	if index >= 0 && index < len(p.stats) && p.stats[index] != nil && p.stats[index].latencyEwmaMs > 0 {
		latency = p.stats[index].latencyEwmaMs
	} else if index >= 0 && index < len(p.lastLatencyMs) && p.lastLatencyMs[index] > 0 {
		latency = float64(p.lastLatencyMs[index])
	}
	if latency <= 0 {
		return 0
	}
	if index >= 0 && index < len(p.spec.Targets) {
		latency += float64(p.spec.Targets[index].ExtraLatencyMs)
	}
	return latency
}

func clampFactor(value float64) float64 {
	if math.IsNaN(value) || value < routeAutoFactorMin {
		return routeAutoFactorMin
	}
	if value > 1 {
		return 1
	}
	return value
}

func (p *failoverProxy) autoWeightsLocked(candidates []int, now time.Time) []float64 {
	weights := p.spreadWeightsLocked(candidates, now)
	best := 0.0
	for _, index := range candidates {
		if latency := p.autoLatencyLocked(index); latency > 0 && (best <= 0 || latency < best) {
			best = latency
		}
	}
	for i, index := range candidates {
		if weights[i] <= 0 {
			continue
		}
		if latency := p.autoLatencyLocked(index); latency > 0 && best > 0 {
			weights[i] *= clampFactor(best / latency)
		}
		if load := p.spec.Targets[index].LoadPct; load > 0 {
			weights[i] *= clampFactor(1 - float64(load)/100)
		}
	}
	return weights
}

/*
powerOfTwoPickLocked：按 weights 随机挑两条不同的候选，取 (连接数 + 1) ÷ 权重 更小的那条；只有一条有份就是它。
两条一样好时取先挑中的那条（它是按权重随机到的，不偏向下标小的）。conns 给每条此刻的连接数：整组分时就是
这条路径上的，线路里几个落地分时是同一个落地合起来的。
*/
func (p *failoverProxy) powerOfTwoPickLocked(candidates []int, weights []float64, conns func(index int) int) int {
	if len(candidates) == 0 {
		return -1
	}
	if p.rng == nil {
		p.rng = newFailoverRand(p.ruleID, p.sourcePort)
	}
	draw := func(skip int) int {
		total := 0.0
		for i, weight := range weights {
			if i != skip && weight > 0 {
				total += weight
			}
		}
		if total <= 0 {
			return -1
		}
		point := p.rng.Float64() * total
		for i, weight := range weights {
			if i == skip || weight <= 0 {
				continue
			}
			point -= weight
			if point < 0 {
				return i
			}
		}
		// 浮点误差落到最后一个有份的
		for i := len(weights) - 1; i >= 0; i-- {
			if i != skip && weights[i] > 0 {
				return i
			}
		}
		return -1
	}
	first := draw(-1)
	if first < 0 {
		return candidates[0]
	}
	second := draw(first)
	if second < 0 {
		return candidates[first]
	}
	costFirst := float64(conns(candidates[first])+1) / weights[first]
	costSecond := float64(conns(candidates[second])+1) / weights[second]
	if costSecond < costFirst {
		return candidates[second]
	}
	return candidates[first]
}

// autoPickLocked：整组按「自动」分；连接数就是这条路径上挂着的。
func (p *failoverProxy) autoPickLocked(candidates []int) int {
	if len(candidates) == 0 {
		return -1
	}
	return p.powerOfTwoPickLocked(candidates, p.autoWeightsLocked(candidates, time.Now()), p.connectionsLocked)
}
