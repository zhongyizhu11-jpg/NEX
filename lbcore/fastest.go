package lbcore

import "time"

/*
「延迟优先 · 只走最快的一台」（面板「检测与切换」里的 fastestOnly，2026-11 用户要求）：不在「一样快」的几台里分，
所有新连接（和新 UDP 会话）只给一台 —— 整链延迟最低的那台，别的都是候补。

和 NearSet 用同一个数比：Member 的 Latency + Jitter（整链：入口到出口 + 出口到目标，调用方填的就是这个）。
换不换是 SwitchPolicy 那一把尺（switch.go，线路组主备择优用的同一把），驻留统一 60 秒：

  - 还没有「在用的」（刚起来），或者在用的那台不在候选里（连不上了 / 被摘了）：当场换到候选里最快的那台，不等。
    一台都不知道延迟时取候选里的第一个。
  - 在用的那台没量出延迟、别的量出来了：当场换到最快的（没量过不能拿来守）—— 只在刚起来、探测还没回的时候会碰到。
  - 否则：最快的那台要比在用的快出门槛（Margin，就是延迟优先「差多少算一样快」那个数）而且快两成，并且连着领先
    Hold（默认 60 秒，「好得多」也不提前：FastHold 和 Hold 一样）才换过去；中间一次不够格就重新计时（Challenger）。

commit 为 false 的挑选只挑、不改状态：这一条连接拨在用的那台失败了（调用方给了排除），换一台重拨，是这一条连接的事，
不能因此把整条规则的「在用」挪走 —— 真坏了由健康判断摘掉，下一次 commit 的挑选再换。

手动指定、按访客固定不经过这里（调用方先处理手动指定；按访客固定是另一种分配方式）。
状态按成员下标记，成员表变了用 Remap 搬（不搬就当刚起来，当场重新挑最快的）。零值可用。调用方自己加锁。
*/
type Fastest struct {
	current    int
	set        bool
	challenger Challenger
}

// DefaultFastestHold：「只走最快的一台」换过去之前，挑战者要连着领先多久。
const DefaultFastestHold = time.Minute

// FastestPolicy 是「只走最快的一台」的两个参数。
type FastestPolicy struct {
	// Margin（毫秒）：要快出这么多才换（还要快两成）。≤ 0 用 DefaultLatencyMargin。
	Margin float64
	// Hold：挑战者要连着领先这么久。≤ 0 用 DefaultFastestHold。
	Hold time.Duration
}

func (p FastestPolicy) switchPolicy() SwitchPolicy {
	hold := p.Hold
	if hold <= 0 {
		hold = DefaultFastestHold
	}
	// FastHold = Hold：好得多也等满（用户要的是「稳住 60 秒才换过去」）。
	return SwitchPolicy{Margin: p.Margin, Hold: hold, FastHold: hold}
}

// Current 现在在用的是谁（还没挑过返回 -1, false）。
func (f *Fastest) Current() (int, bool) {
	if f == nil || !f.set {
		return -1, false
	}
	return f.current, true
}

// Select 在 candidates 里挑这一次给谁（返回成员下标；没有候选返回 -1）。commit 为 true 时同时更新「在用的」和挑战者。
func (f *Fastest) Select(members []Member, candidates []int, policy FastestPolicy, now time.Time, commit bool) int {
	if len(candidates) == 0 {
		return -1
	}
	best, bestDelay := -1, 0.0
	present := false
	for _, index := range candidates {
		if f.set && index == f.current {
			present = true
		}
		if delay := members[index].delay(); delay > 0 && (best < 0 || delay < bestDelay) {
			best, bestDelay = index, delay
		}
	}
	take := func(index int) int {
		if commit {
			f.current, f.set = index, true
			f.challenger.Reset()
		}
		return index
	}
	if !present {
		if best < 0 {
			return take(candidates[0])
		}
		return take(best)
	}
	current := f.current
	if best < 0 || best == current {
		if commit {
			f.challenger.Reset()
		}
		return current
	}
	currentDelay := members[current].delay()
	if currentDelay <= 0 {
		return take(best)
	}
	switchPolicy := policy.switchPolicy()
	better, much := switchPolicy.Better(currentDelay, bestDelay)
	if !commit {
		return current
	}
	if !better {
		f.challenger.Reset()
		return current
	}
	if f.challenger.Ready(best, now, switchPolicy.HoldFor(much)) {
		return take(best)
	}
	return current
}

// Remap 成员表变了：新的第 i 个接旧的第 from[i] 个（from[i] < 0 是新成员）。在用的那台不在了就当刚起来。
func (f Fastest) Remap(from []int) Fastest {
	var out Fastest
	if !f.set {
		return out
	}
	for i, j := range from {
		if j == f.current {
			out.current, out.set = i, true
			if f.challenger.Since.IsZero() {
				return out
			}
			for k, l := range from {
				if l == f.challenger.Index {
					out.challenger = Challenger{Index: k, Since: f.challenger.Since}
				}
			}
			return out
		}
	}
	return out
}
