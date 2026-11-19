package lbcore

import (
	"math"
	"time"
)

/*
PeakEWMA 是「自动」用的延迟估计：对变慢敏感、对变快迟钝的指数平均（Finagle 的 peak EWMA）。

  - 来一个比现在的读数大的样本：读数直接跳到样本（慢了立刻知道，不等平均慢慢爬上去）。
  - 来一个小的样本：按距上次的时间加权往样本靠，权重 e^(-间隔 ÷ Decay)。
  - 没有样本的时候：读数自己按 e^(-间隔 ÷ Decay) 落回去（Value）。

第三条是它不饿死成员的原因：被一次慢握手抬高的成员分不到连接、也就没有新样本，但它的读数会随时间落下来，
落到比别人低时又分到连接、拿到新样本，回到真实水平。（FXP 以前有过一版「只有来新样本才落」的峰值估计，
闲着的出口碰上一次 1 秒的重发就停在 1100ms 上再也分不到连接，路线图 X10。）

读数是给成本函数比大小用的，不是给人看的延迟：闲久了它会落到接近 0。要展示、要按绝对的毫秒门槛比（延迟优先）
的地方，调用方另留一份普通的平均。

Decay 默认 10 秒（DefaultPeakDecay）：一次尖峰大约半分钟后影响降到 5% 以下。零值可用（还没样本，Value 返回 0）。
*/
type PeakEWMA struct {
	cost float64
	at   time.Time
}

// DefaultPeakDecay：peak EWMA 的时间常数。
const DefaultPeakDecay = 10 * time.Second

func peakWeight(elapsed, decay time.Duration) float64 {
	if elapsed <= 0 {
		return 1
	}
	if decay <= 0 {
		decay = DefaultPeakDecay
	}
	return math.Exp(-float64(elapsed) / float64(decay))
}

// Observe 记一个样本（毫秒）。decay ≤ 0 用 DefaultPeakDecay。样本 ≤ 0 不记。
func (p *PeakEWMA) Observe(sample float64, now time.Time, decay time.Duration) {
	if sample <= 0 {
		return
	}
	if p.at.IsZero() || sample >= p.cost {
		p.cost, p.at = sample, now
		return
	}
	weight := peakWeight(now.Sub(p.at), decay)
	p.cost = p.cost*weight + sample*(1-weight)
	p.at = now
}

// Value now 这一刻的读数。还没有样本返回 0。
func (p PeakEWMA) Value(now time.Time, decay time.Duration) float64 {
	if p.at.IsZero() {
		return 0
	}
	return p.cost * peakWeight(now.Sub(p.at), decay)
}

// Reset 丢掉所有样本。
func (p *PeakEWMA) Reset() { *p = PeakEWMA{} }

/*
「延迟优先」：延迟最低的那个，和它差不到门槛的几个一起算「一样快」，只在这一组里分（组里用 Auto 的成本）。
不全压在最快的一个上，也不在几毫秒的差别上来回跳。圈这一组时延迟要用普通的平均（绝对的毫秒数），
不是 PeakEWMA 的读数。

比的是 Latency + Jitter（抖得厉害的路，按它慢的时候算）。

NearSet 记着每个成员上一次在不在「一样快」的那一组里、从什么时候进的组。门槛之外再加一道驻留（Hold）：
一个成员进了组，至少留这么久才会被请出去 —— 延迟卡在门槛上下时不会每条连接都换一次结论
（文档里写的「切过去至少用 1 分钟」）。进组不设驻留：一次慢样本把它挤出去，回到门槛以内马上就能回来，
不会因为一个尖峰空等一分钟（路线图 X10）；回来之后又得留满 Hold，所以来回翻最多每个 Hold 一次。
驻留不拦逃生：成员健不健康不归它管（那是 Candidates 的事，不健康的根本进不了 candidates），
组里一个都不剩时直接按这一刻的延迟重算。

参数：Margin 默认 50ms（DefaultLatencyMargin）；Hold 零值是不驻留，线路组和出口组都填 DefaultNearHold（1 分钟）。
状态按成员下标排，调用方自己加锁。成员表变了就换一个新的 NearSet（零值可用）。
*/
type NearSet struct {
	in    []bool
	since []time.Time
	known []bool
}

// DefaultLatencyMargin：差 50ms 以内当一样快。
const DefaultLatencyMargin = 50.0

// DefaultNearHold：进了「一样快」的那一组至少留 1 分钟（线路组、GOST 出口组、NEX 出口组都用它）。
const DefaultNearHold = time.Minute

// NearPolicy 是延迟优先的两个参数。
type NearPolicy struct {
	// Margin（毫秒）：比最快的慢不到这么多就算一样快。≤ 0 用 DefaultLatencyMargin。
	Margin float64
	// Hold：进组之后至少留这么久。0 表示不驻留（每次按这一刻的延迟算）。
	Hold time.Duration
}

func (p NearPolicy) margin() float64 {
	if p.Margin <= 0 {
		return DefaultLatencyMargin
	}
	return p.Margin
}

// Select 返回这一次「一样快」的那一组（追加到 dst），并更新状态。都还不知道延迟时返回全部候选 ——
// 没有依据就不排除谁。不知道延迟的成员不算「一样快」。
func (n *NearSet) Select(dst []int, members []Member, candidates []int, policy NearPolicy, now time.Time) []int {
	best := minDelay(members, candidates)
	if best <= 0 {
		return append(dst, candidates...)
	}
	n.grow(len(members))
	margin := policy.margin()
	mark := len(dst)
	for _, index := range candidates {
		latency := members[index].delay()
		near := latency > 0 && latency-best <= margin
		switch {
		case !n.known[index]:
			n.known[index], n.in[index], n.since[index] = true, near, now
		case near && !n.in[index]:
			n.in[index], n.since[index] = true, now
		case !near && n.in[index] && now.Sub(n.since[index]) >= policy.Hold:
			n.in[index] = false
		}
		if n.in[index] {
			dst = append(dst, index)
		}
	}
	if len(dst) > mark {
		return dst
	}
	// 组里一个都不剩（都在驻留期里被留在组外，或者组里的都不在候选里了）：按这一刻的延迟重算，状态跟着改。
	for _, index := range candidates {
		latency := members[index].delay()
		if latency > 0 && latency-best <= margin {
			n.in[index], n.since[index] = true, now
			dst = append(dst, index)
		}
	}
	if len(dst) == mark {
		return append(dst, candidates...)
	}
	return dst
}

// delay：延迟 + 抖动；不知道延迟返回 0。
func (m *Member) delay() float64 {
	if m.Latency <= 0 {
		return 0
	}
	if m.Jitter > 0 {
		return m.Latency + m.Jitter
	}
	return m.Latency
}

func minDelay(members []Member, candidates []int) float64 {
	min := 0.0
	for _, index := range candidates {
		if delay := members[index].delay(); delay > 0 && (min == 0 || delay < min) {
			min = delay
		}
	}
	return min
}

// Contains 成员 index 上一次算下来在不在「一样快」的那一组里（没算过返回 false）。
func (n *NearSet) Contains(index int) bool {
	return index >= 0 && index < len(n.in) && n.known[index] && n.in[index]
}

func (n *NearSet) grow(size int) {
	if len(n.in) >= size {
		return
	}
	in := make([]bool, size)
	since := make([]time.Time, size)
	known := make([]bool, size)
	copy(in, n.in)
	copy(since, n.since)
	copy(known, n.known)
	n.in, n.since, n.known = in, since, known
}
