package lbcore

import "time"

/*
主备 + 择优：「候选 B 比正在走的 A 好到值得换过去」。线路组的「整链最优」（主备里开了择优）用它；
和「延迟优先」是同一把尺 —— 门槛就是延迟优先里「一样快」的那个门槛（NearPolicy.Margin），
在延迟优先里算一样快的两条，这里也不换。

比的是 QualityCost：自动的成本去掉负载那一半。

	QualityCost = (Latency + Jitter) × Penalty ÷ Headroom          （见 load.go，单位仍是毫秒）

去掉负载是因为主备的流量全在正在走的那一条上：把挂着的连接算进去，正在走的那条永远显得更差，切过去以后
对面又显得更差，来回换。

B 算「明显更好」要同时满足：

  - 绝对值：A 的成本 − B 的成本 > Margin（默认 DefaultLatencyMargin，50ms）；
  - 比例：B 的成本 ≤ A 的成本 × (1 − Ratio)（默认 20%）—— 900ms 和 840ms 差了 60ms，对人没有区别。

再加驻留（Challenger）：同一个 B 要连着「明显更好」Hold 那么久才换（调用方配置，线路组默认 180 秒、
「整链最优」模板 30 秒）；好得多的 —— B 的成本不到 A 的一半、而且差出 2 × Margin —— 只等 FastHold（10 秒）：
557ms 的线路旁边摆着 3ms 的，等三分钟只会让人以为择优没生效。

切过去以后的来回由调用方的 FlapDamper 压（flap.go）：门槛和驻留挡单次误判，频率挡来回漂。
不知道延迟（Latency = 0）的不比：没量过不能当成「好得不得了」，正在走的那条没量过也不换。
*/
type SwitchPolicy struct {
	// Margin（毫秒）：成本差不到这么多不换。≤ 0 用 DefaultLatencyMargin。
	Margin float64
	// Ratio：还要快出这么多成。≤ 0 用 DefaultSwitchRatio。
	Ratio float64
	// Hold：同一个候选要连着领先多久。FastHold：好得多时只等这么久（≤ 0 用 DefaultSwitchFastHold；比 Hold 长时按 Hold）。
	Hold     time.Duration
	FastHold time.Duration
}

const (
	// DefaultSwitchRatio：除了快出 Margin，还要快出两成。
	DefaultSwitchRatio = 0.2
	// DefaultSwitchFastHold：好得多（不到一半、差出两个门槛）时只等 10 秒。
	DefaultSwitchFastHold = 10 * time.Second
)

// QualityCost 只看质量的成本（毫秒）：(Latency + Jitter) × Penalty ÷ Headroom。不知道延迟返回 0。
func QualityCost(q Quality) float64 {
	if !(q.Latency > 0) {
		return 0
	}
	latency := q.Latency
	if q.Jitter > 0 {
		latency += q.Jitter
	}
	return latency * q.Penalty() / q.Headroom()
}

func (p SwitchPolicy) margin() float64 {
	if p.Margin <= 0 {
		return DefaultLatencyMargin
	}
	return p.Margin
}

func (p SwitchPolicy) ratio() float64 {
	if p.Ratio <= 0 {
		return DefaultSwitchRatio
	}
	return p.Ratio
}

// Better：成本 candidate 比成本 active 明显更好吗；much 是「好得多」（只等 FastHold）。成本 ≤ 0（不知道）不比。
func (p SwitchPolicy) Better(active, candidate float64) (better, much bool) {
	if !(active > 0) || !(candidate > 0) {
		return false, false
	}
	gain := active - candidate
	margin := p.margin()
	better = gain > margin && candidate <= active*(1-p.ratio())
	much = better && gain >= 2*margin && candidate*2 <= active
	return better, much
}

// HoldFor 这一次要等多久：much 时 FastHold 和 Hold 取短的。
func (p SwitchPolicy) HoldFor(much bool) time.Duration {
	if !much {
		return p.Hold
	}
	fast := p.FastHold
	if fast <= 0 {
		fast = DefaultSwitchFastHold
	}
	if fast < p.Hold {
		return fast
	}
	return p.Hold
}

/*
Challenger 记着「谁在挑战正在走的那条、从什么时候起」。零值 = 没有挑战者。

Ready 第一次见到一个候选只开始计时（返回 false），之后连着都是它、够了 hold 才返回 true；中间换了人重新计时。
挑战不成立（没有明显更好的）时调用方 Reset。
*/
type Challenger struct {
	Index int
	Since time.Time
}

// Ready index 已经连着领先 hold 了吗（第一次见到它时开始计时）。
func (c *Challenger) Ready(index int, now time.Time, hold time.Duration) bool {
	// Since 是零值时一定当成「还没开始计时」：Index 的零值 0 是一个合法下标，只看 Index 会把「第一次就是第 0 条」
	// 当成已经领先了很久，一上来就切。
	if c.Since.IsZero() || c.Index != index {
		c.Index, c.Since = index, now
		return false
	}
	return now.Sub(c.Since) >= hold
}

// Reset 没有挑战者了。
func (c *Challenger) Reset() { *c = Challenger{} }

/*
DisplayScore 给人看的 0–100：同一个 QualityCost 换算过来，成本 ≤ 40ms 满分、≥ 400ms 零分、中间线性。
只用来显示（「92 优」），不参与任何决定 —— 决定都按成本比（Better、Auto）。分数高低和成本高低永远一致。
ok 为 false 表示还没法打分（不知道延迟）。
*/
func DisplayScore(q Quality) (score int, ok bool) {
	cost := QualityCost(q)
	if cost <= 0 {
		return 0, false
	}
	value := (DisplayScoreZeroMs - cost) / (DisplayScoreZeroMs - DisplayScoreFullMs)
	if value >= 1 {
		return 100, true
	}
	if !(value > 0) {
		return 0, true
	}
	return int(value*100 + 0.5), true
}

const (
	// DisplayScoreFullMs、DisplayScoreZeroMs：显示分数的两头（成本，毫秒）。和 shared/routeScore.ts 一样。
	DisplayScoreFullMs = 40.0
	DisplayScoreZeroMs = 400.0
)
