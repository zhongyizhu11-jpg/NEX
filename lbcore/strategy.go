package lbcore

import "time"

/*
八种分配方式的名字和总入口。线路组和出口组都从 Pick 进来，同一个名字在两边就是同一段代码：

	auto         自动：P2C + peak EWMA 的成本（load.go）
	least_load   按负载：同一个成本只留负载那一半（load.go）
	latency      延迟优先：先圈出「一样快」的一组，只在组里用自动的成本（latency.go）
	weighted     按权重：平滑加权轮询（wrr.go）
	round_robin  轮流（wrr.go）
	random       随机（wrr.go）
	ip_hash      按访客固定：加权 rendezvous 哈希 + 有界负载（rendezvous.go）
	fallback     主备：一次只用一个（tier.go 的 First）。它不在候选里「分」，所以不走 Pick ——
	             出口组每次用 First 现挑；线路组有自己的「现在走哪条」状态机（粘性、切回、时段表）。

认不出的名字按轮流。按访客固定而调用方不知道访客是谁（key 为空）时也按轮流：把所有人钉在同一个成员上
比不固定更糟。
*/
const (
	StrategyAuto       = "auto"
	StrategyLeastLoad  = "least_load"
	StrategyLatency    = "latency"
	StrategyWeighted   = "weighted"
	StrategyRoundRobin = "round_robin"
	StrategyRandom     = "random"
	StrategyIPHash     = "ip_hash"
	StrategyFallback   = "fallback"
)

// Strategies 是全部八种，按界面上的顺序。
var Strategies = []string{
	StrategyAuto, StrategyFallback, StrategyIPHash, StrategyLatency,
	StrategyLeastLoad, StrategyWeighted, StrategyRoundRobin, StrategyRandom,
}

// ValidStrategy 是不是八种之一。
func ValidStrategy(name string) bool {
	for _, strategy := range Strategies {
		if strategy == name {
			return true
		}
	}
	return false
}

/*
State 是一个挑选器（一条规则 / 一个线路组）跨连接留着的状态，都由调用方持有、自己加锁：

	WRR   按权重的计数（长度 = 成员数）
	Near  延迟优先里「一样快」那一组的状态
	Next  轮转计数：轮流的位置、成本一样时从谁数起。给它一个随机初值，各条规则就不会都从第一个成员起步

State 本身只是三个引用，每次挑选时现拼一个就行。
*/
type State struct {
	WRR  SmoothWRR
	Near *NearSet
	Next *int
}

// Options 是各分配方式的参数，零值 = 全用默认（见各文件开头）。
type Options struct {
	// Near：延迟优先的门槛和驻留。
	Near NearPolicy
	// HashLoadFactor：按访客固定的有界负载上限（0 = 1.25，负数 = 不设上限）。
	HashLoadFactor float64
	// Scratch：按访客固定用的临时区（按成员下标，长度 ≥ 成员数）。不给就现分配。
	Scratch []float64
	// NearScratch：延迟优先用来放「一样快」那一组的临时区。不给就现分配。
	NearScratch []int
}

/*
Pick 在 candidates 里按 strategy 挑一个成员，返回下标；没有候选返回 -1。

members、keys 按成员下标排；key 是访客标识（只有按访客固定用）；now 只有延迟优先的驻留用；
rnd 为 nil 时凡是要抽签的地方都退成确定的选择。fallback 不该走到这里（见上），走到了按候选里的第一个。
*/
func Pick(strategy string, state State, members []Member, keys []string, candidates []int, key string, now time.Time, rnd Rand, opts Options) int {
	if len(candidates) == 0 {
		return -1
	}
	next := state.Next
	if next == nil {
		next = new(int)
	}
	switch strategy {
	case StrategyAuto:
		return Auto(members, candidates, next, rnd)
	case StrategyLeastLoad:
		return LeastLoad(members, candidates, next, rnd)
	case StrategyLatency:
		near := state.Near
		if near == nil {
			near = &NearSet{}
		}
		return Auto(members, near.Select(opts.NearScratch[:0], members, candidates, opts.Near, now), next, rnd)
	case StrategyWeighted:
		if len(state.WRR) < len(members) {
			return candidates[advance(next)%len(candidates)]
		}
		return state.WRR.Pick(members, candidates)
	case StrategyRandom:
		return Random(members, candidates, rnd)
	case StrategyIPHash:
		if key != "" {
			return Rendezvous(members, keys, candidates, key, RendezvousOptions{LoadFactor: opts.HashLoadFactor, Scratch: opts.Scratch})
		}
	case StrategyFallback:
		return candidates[0]
	}
	return RoundRobin(next, members, candidates, rnd)
}
