package lbcore

import "math"

/*
SmoothWRR 是「按权重」：平滑加权轮询（nginx 那套）。每个成员一个计数，按成员下标排；长度要够放下最大的下标
（不够的那几个候选当没有）。就是个 []int —— 调用方可以把它直接放在自己的结构里、自己加锁、自己落盘。

每挑一次：每个候选的计数加上自己的步长，挑计数最大的，再把它减去这一轮的总步长。权重 5:3 排成交错的序列
（A B A A B A B A），不是先连着给 5 个再连着给 3 个；按权重随机在短时间里会连着几条都落在同一个上。

步长 = 有效分量 × 10 取整（至少 1）：乘 10 是给慢启动留精度（10% 起步），不在慢启动里时序列和直接按权重
一模一样。只在候选里算：坏了的成员这一轮不加计数，恢复后也不会一口气补发欠它的连接。
*/
type SmoothWRR []int

func wrrStep(weight float64) int {
	return int(math.Max(1, math.Round(weight*10)))
}

// Pick 挑一个，并推进计数。
func (w SmoothWRR) Pick(members []Member, candidates []int) int {
	if len(candidates) == 0 {
		return -1
	}
	mode := modeOf(members, candidates)
	total, best := 0, -1
	for _, index := range candidates {
		if index >= len(w) {
			continue
		}
		weight := members[index].weightBy(mode)
		if weight <= 0 {
			continue
		}
		step := wrrStep(weight)
		total += step
		w[index] += step
		if best < 0 || w[index] > w[best] {
			best = index
		}
	}
	if best < 0 {
		return candidates[0]
	}
	w[best] -= total
	return best
}

/*
Spin 把序列空转若干步，定一个随机的起步位置（路线图 X4）。seed 是调用方给的随机数。

不转的话每个选择器都从第一个成员起步：入口上几百条规则一起启动（重启、重载）时，每条规则的第一条连接都落在
同一个成员上；连接少的规则（一两条长连接）更是永远只用第一个。空转不改变一整圈里各成员的份额，只是起点不同。
最多转 4096 步（一圈的长度是步长之和，权重很大时不必转满）。
*/
func (w SmoothWRR) Spin(members []Member, candidates []int, seed uint64) {
	if len(candidates) < 2 {
		return
	}
	mode := modeOf(members, candidates)
	total := 0
	for _, index := range candidates {
		if weight := members[index].weightBy(mode); weight > 0 {
			total += wrrStep(weight)
		}
	}
	if total > 4096 {
		total = 4096
	}
	if total <= 0 {
		return
	}
	for steps := int(seed % uint64(total)); steps > 0; steps-- {
		w.Pick(members, candidates)
	}
}

/*
Remap 成员表变了（加了、删了、换了顺序）以后把计数搬到新下标上：同一个标识的成员带着自己的计数走，新来的从 0 起。
返回新的状态（长度 = len(newKeys)），原来的不动。

不搬的话，前面插一个成员，后面每个成员的计数都算到了别人头上，序列从一个不相干的位置接着走。
*/
func (w SmoothWRR) Remap(oldKeys, newKeys []string) SmoothWRR {
	next := make(SmoothWRR, len(newKeys))
	if len(w) == 0 {
		return next
	}
	at := make(map[string]int, len(oldKeys))
	for index, key := range oldKeys {
		if _, seen := at[key]; !seen {
			at[key] = index
		}
	}
	for index, key := range newKeys {
		if old, ok := at[key]; ok && old < len(w) {
			next[index] = w[old]
		}
	}
	return next
}

// rotationWrap：轮转计数到这儿回卷（两边原来都是这个数，沿用）。
const rotationWrap = 1000000

func advance(next *int) int {
	current := *next
	if current < 0 {
		current = 0
	}
	*next = (current + 1) % rotationWrap
	return current
}

/*
RoundRobin 是「轮流」：候选里按轮转计数挑，计数每次加一。next 是调用方的轮转计数（给它一个随机初值，
各条规则就不会都从第一个起步）。

不看 Weight。Share 不到 1 的成员轮到时按它的几成收（少分的四次里收一次），没收就看下一个 —— 刚恢复的、
不稳的在轮流里也少分。members 传 nil 表示都按整份。rnd 为 nil 时总是收下。
*/
func RoundRobin(next *int, members []Member, candidates []int, rnd Rand) int {
	n := len(candidates)
	if n == 0 {
		return -1
	}
	if members != nil && rnd != nil {
		for attempt := 0; attempt < n*4; attempt++ {
			index := candidates[advance(next)%n]
			if share := members[index].Share; share >= 1 || (share > 0 && rnd.Float64() < share) {
				return index
			}
		}
	}
	return candidates[advance(next)%n]
}

/*
Random 是「随机」：候选里随机一个。不看 Weight；Share 不到 1 的按它的几成算（都是 1 时就是均匀随机）。
members 传 nil 表示都按整份。rnd 为 nil 时返回第一个候选。
*/
func Random(members []Member, candidates []int, rnd Rand) int {
	n := len(candidates)
	if n == 0 {
		return -1
	}
	if rnd == nil {
		return candidates[0]
	}
	u := rnd.Float64()
	if members == nil {
		return candidates[int(u*float64(n))%n]
	}
	total := 0.0
	for _, index := range candidates {
		if share := members[index].Share; share > 0 {
			total += math.Min(share, 1)
		}
	}
	if total <= 0 {
		return candidates[int(u*float64(n))%n]
	}
	point := u * total
	last := candidates[0]
	for _, index := range candidates {
		share := members[index].Share
		if share <= 0 {
			continue
		}
		last = index
		point -= math.Min(share, 1)
		if point < 0 {
			return index
		}
	}
	return last
}
