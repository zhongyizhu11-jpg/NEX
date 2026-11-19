package lbcore

import "math"

/*
候选：先决定「在哪些成员里挑」，再按分配方式在里面挑。做法是 Envoy 那一套 —— 摘除离群的成员，但摘除有上限，
健康的不够了就进入恐慌、不再相信健康判断。

每个成员的健康（Health）是四个信号，调用方按自己的探测结果填：

	Excluded        管理上排除（暂停、维护、流量停机）。任何时候都不挑；全都被排除就拒绝。
	Dead            硬信号：成员本身连不上（探测、握手不通）。只要还有一个连得上的，就不挑它。
	DownstreamDown  连得上，但它到下游不通（出口通、出口到目标不通 —— 多半是目标自己的问题）。
	Soft            软信号：不稳（抖动 / 丢包过门槛）、刚恢复还在观察。连得上，只是质量可疑。
	Cooling         Dead 的细分：刚判成连不上、还在冷却（退避）里。只有主备看它（见 First）。

Candidates 的规矩：

 1. 正常：在「连得上、下游也通」的成员里挑。带软信号的摘掉，但**最多摘掉这一组的 MaxSoftEject（默认五成，向下取整），
    而且至少留一个**。软信号是统计出来的，会误判；几个成员同时被判成不稳时（往往是入口自己那一段在抖），
    全摘掉等于把全部流量压到剩下的一两个上，把它们也压垮。超出上限的那几个照常参与（下标小的优先留下）。
 2. 恐慌：正常的那一组剩下不到 PanicBelow 个（默认 1，也就是一个都不剩）时，在所有**连得上**的成员里分 ——
    带软信号的、下游不通的都算，不再只盯着某一个。健康判断这时候多半已经不可信了，分散开比赌一个强。
 3. 一个连得上的都没有：在所有没被排除的成员里分。总得给一个，否则等于直接断服；判断也可能是错的。
    以前出口组在这一步优先挑「冷却到期」的那个，结果是全挂时每条连接都撞同一个；现在摊开。

为什么硬信号不设上限：连不上的成员接了连接就是失败（UDP 会话没有重放，挑中就钉死在上面，路线图 X1），
没有「可能误判所以留几成」的余地 —— 误判由后台探测去纠正，不拿用户的连接去试。

First 是「主备」：一次只用一个，按「稳的 → 带软信号的 → 下游不通的 → 连不上但冷却到期的 → 还在冷却的」找第一个，
同一类里按配置的先后。主备不受摘除上限限制：流量本来就全在一个成员上，跳过不稳的不会把谁压垮。
全都连不上时先试冷却到期的那个：它是「该再试一次了」的，还在冷却的是刚撞过墙的；主备不分摊，
所以这里可以有先后（分着用的时候不分这个先后，见上面第 3 条）。
*/
type Health struct {
	Excluded       bool
	Dead           bool
	DownstreamDown bool
	Soft           bool
	Cooling        bool
}

// EjectPolicy 是摘除的两个参数。零值 = 默认。
type EjectPolicy struct {
	// MaxSoftEject：软信号最多摘掉候选的几成（向下取整，至少留一个）。0 用 DefaultMaxSoftEject；负数表示不摘。
	MaxSoftEject float64
	// PanicBelow：正常那一组少于这么多个就进入恐慌。0 用 1。
	PanicBelow int
}

// DefaultMaxSoftEject：软信号最多摘掉一半。
const DefaultMaxSoftEject = 0.5

// Level 说明 Candidates 这一次是在哪一步给出的候选。
type Level uint8

const (
	// LevelNormal：连得上、下游也通的（软信号按上限摘过）。
	LevelNormal Level = iota
	// LevelPanic：恐慌 —— 所有连得上的。
	LevelPanic
	// LevelDead：一个连得上的都没有 —— 所有没被排除的。
	LevelDead
	// LevelNone：没有可挑的（全被排除，或者都试过了）。
	LevelNone
)

func skipped(skip map[int]bool, index int) bool { return skip != nil && skip[index] }

func (h Health) usable() bool { return !h.Excluded && !h.Dead && !h.DownstreamDown }

/*
Candidates 返回这一次可以挑的成员（追加到 dst，按下标顺序）和它们是在哪一步给出的。health 按成员下标排；
skip 里的成员（这条连接已经试过、拨失败的）不参与。
*/
func Candidates(dst []int, health []Health, skip map[int]bool, policy EjectPolicy) ([]int, Level) {
	usable, soft := 0, 0
	for index, h := range health {
		if skipped(skip, index) || !h.usable() {
			continue
		}
		usable++
		if h.Soft {
			soft++
		}
	}
	panicBelow := policy.PanicBelow
	if panicBelow < 1 {
		panicBelow = 1
	}
	if usable > 0 {
		eject := 0
		if soft > 0 {
			share := policy.MaxSoftEject
			if share == 0 {
				share = DefaultMaxSoftEject
			}
			if share > 0 {
				eject = int(math.Floor(share * float64(usable)))
				if eject > soft {
					eject = soft
				}
				if eject > usable-1 {
					eject = usable - 1
				}
			}
		}
		if usable-eject >= panicBelow {
			// 带软信号的从下标大的开始摘：留下的是配置里排在前面的。
			keepSoft := soft - eject
			mark := len(dst)
			for index, h := range health {
				if skipped(skip, index) || !h.usable() {
					continue
				}
				if h.Soft {
					if keepSoft == 0 {
						continue
					}
					keepSoft--
				}
				dst = append(dst, index)
			}
			if len(dst) > mark {
				return dst, LevelNormal
			}
		}
	}
	mark := len(dst)
	for index, h := range health {
		if !skipped(skip, index) && !h.Excluded && !h.Dead {
			dst = append(dst, index)
		}
	}
	if len(dst) > mark {
		return dst, LevelPanic
	}
	for index, h := range health {
		if !skipped(skip, index) && !h.Excluded {
			dst = append(dst, index)
		}
	}
	if len(dst) > mark {
		return dst, LevelDead
	}
	return dst, LevelNone
}

func (h Health) rank() int {
	switch {
	case h.Excluded:
		return 5
	case h.Dead && h.Cooling:
		return 4
	case h.Dead:
		return 3
	case h.DownstreamDown:
		return 2
	case h.Soft:
		return 1
	}
	return 0
}

// First 是「主备」该走哪个：最好的一类里排最前的。没有可挑的返回 -1。
func First(health []Health, skip map[int]bool) int {
	best, bestRank := -1, 5
	for index, h := range health {
		if skip != nil && skip[index] {
			continue
		}
		if rank := h.rank(); rank < bestRank {
			best, bestRank = index, rank
		}
	}
	return best
}
