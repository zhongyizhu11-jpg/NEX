package lbcore

/*
「自动」和「按负载」：P2C + peak EWMA（Finagle / Linkerd 的做法），一个成本函数。

	成本 = (Latency + Jitter) × Penalty × (Active + InFlight + 1) ÷ (Weight × Share × Headroom)

	Penalty  = (1 + 10 × 丢包率) × (1 + 10 × 连接失败率)        见 Quality.Penalty
	Headroom = 1 − 利用率（最多按 95% 算）                       见 Quality.Headroom

  - 自动（Auto）：整个式子。Latency 喂 PeakEWMA 的读数（latency.go）—— 来一个慢样本立刻跳上去，之后按时间衰减回来。
    慢的、过载的成员几条连接之内就被避开；读数自己会落回去，被避开的成员过一阵会再分到连接、拿到新样本，不会饿死。
  - 按负载（LeastLoad）：只留负载那一半 —— (Active + InFlight + 1) ÷ (Weight × Share × Headroom)，不看延迟、抖动、丢包。
  - 延迟优先：先按延迟圈出「一样快」的一组（NearSet），组里再用 Auto。

为什么选它：「延迟 × 在途数」是「这条连接放上去大概要等多久」的估计，一个数同时反映了线路远近、成员忙不忙、
刚才有没有卡过；丢包、利用率各是一个单调的系数乘上去，不需要给每一项配权重再调参。以前两边各有一套「自动」
（线路组：权重 × 延迟比 × 主机负载再随机挑两条；出口组：流量成本、慢出门槛才乘 sqrt、再少分一半），
界面上是同一个选项，分出来的比例不一样。

几个要点：
  - InFlight 要在挑中那一刻就记（不等拨通），不然同时到的一批连接互相看不见，全压到同一个「看起来最闲」的上
    （路线图 A8 / X5）。+1 是「这一条放上去之后」。
  - 不知道延迟的成员按候选里最快的那个算：不罚它，也不因为「没量过」就把连接都给它。都不知道时延迟、抖动这一项
    不起作用。丢包、成功率、利用率不知道（0）就是不罚。
  - 成本对每一项都是单调的：延迟、抖动、丢包、失败率、利用率、负载越大成本越高，分量越大成本越低。
  - 挑选路径上不分配内存。

怎么挑：
  - 候选 ≤ 3 个：全算一遍取成本最小的；成本一样时从轮转的起点往后数第一个（都闲着时轮着来，不总落在第一个上）。
  - 候选 > 3 个：按有效分量随机抽两个不同的，取成本小的（power of two choices）。好几台入口各自看到的负载
    都有延迟，全都去抢「看起来最闲」的那一个反而会把它压垮；抽两个比，既不会全涌到最好的，也不会让差的一直分到。
*/

// MinLatency 候选里已知延迟的最小值；都不知道返回 0。
func MinLatency(members []Member, candidates []int) float64 {
	min := 0.0
	for _, index := range candidates {
		if latency := members[index].Latency; latency > 0 && (min == 0 || latency < min) {
			min = latency
		}
	}
	return min
}

// costOf：loadOnly 时 minLatency 传 0。
func costOf(member *Member, mode weightMode, minLatency float64, loadOnly bool) (float64, bool) {
	weight := member.weightBy(mode)
	if weight <= 0 {
		return 0, false
	}
	cost := (member.Active + member.InFlight + 1) / (weight * member.Headroom())
	if loadOnly {
		return cost, true
	}
	if minLatency > 0 {
		latency := member.Latency
		if latency <= 0 {
			latency = minLatency
		}
		if member.Jitter > 0 {
			latency += member.Jitter
		}
		cost *= latency
	}
	return cost * member.Penalty(), true
}

// Cost 成员 index 在 candidates 里这一次的成本（ok 为 false 表示它这次不参与）。loadOnly 是「按负载」的那一半。
// 和 Auto / LeastLoad 用的是同一个数，调用方要在成本一样的几个里按自己的偏好取舍、或者要把成本报出去时用。
func Cost(members []Member, candidates []int, index int, loadOnly bool) (cost float64, ok bool) {
	minLatency := 0.0
	if !loadOnly {
		minLatency = MinLatency(members, candidates)
	}
	return costOf(&members[index], modeOf(members, candidates), minLatency, loadOnly)
}

// Auto 是「自动」：挑成本最低的。next 是调用方的轮转计数（成本一样时轮着来）；rnd 为 nil 时不抽签，总是全算。
func Auto(members []Member, candidates []int, next *int, rnd Rand) int {
	return lowestCost(members, candidates, next, rnd, false)
}

// LeastLoad 是「按负载」：同一个成本，只看负载那一半。
func LeastLoad(members []Member, candidates []int, next *int, rnd Rand) int {
	return lowestCost(members, candidates, next, rnd, true)
}

func lowestCost(members []Member, candidates []int, next *int, rnd Rand, loadOnly bool) int {
	n := len(candidates)
	if n == 0 {
		return -1
	}
	if n == 1 {
		return candidates[0]
	}
	mode := modeOf(members, candidates)
	minLatency := 0.0
	if !loadOnly {
		minLatency = MinLatency(members, candidates)
	}
	start := advance(next) % n
	if n > 3 && rnd != nil {
		first := drawByWeight(members, candidates, mode, -1, rnd.Float64())
		if first >= 0 {
			second := drawByWeight(members, candidates, mode, first, rnd.Float64())
			if second < 0 {
				return candidates[first]
			}
			costFirst, _ := costOf(&members[candidates[first]], mode, minLatency, loadOnly)
			costSecond, _ := costOf(&members[candidates[second]], mode, minLatency, loadOnly)
			if costSecond < costFirst {
				return candidates[second]
			}
			return candidates[first]
		}
	}
	best, bestCost := -1, 0.0
	for offset := 0; offset < n; offset++ {
		index := candidates[(start+offset)%n]
		cost, ok := costOf(&members[index], mode, minLatency, loadOnly)
		if !ok {
			continue
		}
		if best < 0 || cost < bestCost {
			best, bestCost = index, cost
		}
	}
	if best < 0 {
		return candidates[start]
	}
	return best
}
