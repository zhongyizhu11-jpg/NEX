package lbcore

/*
Member 是一个候选此刻的样子，调用方每次挑选前填好。有什么填什么，量不到的留 0（0 = 不知道，按中性处理）。

Weight 和 Share 分开，是因为它们的用处不同：按访客固定只看 Weight（乘了慢启动，访客会先被挪走再挪回来）；
轮流、随机不看 Weight（本来就是平均分），但看 Share（刚恢复、不稳的少分）；按权重、按负载、自动两个都看。
*/
type Member struct {
	// Weight 静态分量：权重，或者线路带宽。≤ 0 表示不分新连接；候选的 Weight 全都 ≤ 0 时一律当 1。
	Weight float64
	// Share 这一次按几成算，(0, 1]：慢启动系数 × 调用方自己的折算（比如「不稳的少分」），没有就填 1。
	// ≤ 0 表示这一次不给它；候选全都分不到时退一步不看 Share。
	Share float64
	// Active 挂在它上面的会话数；InFlight 已经挑中、还没跑起来的（拨号中 / 刚开的）。
	Active   float64
	InFlight float64
	// Quality 这个候选有多好（延迟、抖动、丢包、成功率、利用率），「自动」「延迟优先」「按负载」的成本从它算。
	Quality
}

/*
Quality 是「这个候选有多好」的唯一一份定义：两边把各自量到的填进来，成本只有一个算法（load.go 的 Cost）。
全部可选，0 = 不知道 —— 不知道的一律按中性处理（不罚、也不占便宜）。

	Latency      延迟（毫秒）。「自动」填 PeakEWMA 的读数，「延迟优先」圈「一样快」的一组时填普通的平均。
	Jitter       抖动（毫秒）。加在延迟上：延迟 30ms、抖动 40ms 的路，按 70ms 算。
	Loss         丢包率，0–1。
	Success      最近一段时间真实连接的成功率，0–1；0 = 不知道（不是「全失败」—— 全失败的成员该由健康判断摘掉）。
	Utilisation  利用率，0–1：主机负载，或者 流量 ÷ 线路带宽。

Loss 和 Success 不要拿同一批探测结果各填一遍，那样同一次失败会被罚两次。
*/
type Quality struct {
	Latency     float64
	Jitter      float64
	Loss        float64
	Success     float64
	Utilisation float64
}

const (
	// LossPenaltySlope：丢包（和连接失败）每多 10%，成本多一倍（1 + 10 × 比例）。丢包对 TCP 的伤害远超线性，
	// 2% 的丢包就该看得出来（成本 × 1.2），8% 时这条路只分到别人的一半多一点（× 1.8）。
	LossPenaltySlope = 10.0
	// MaxUtilisation：利用率按最多 95% 算。再满也留 5% 的余量：不让成本变成无穷大，
	// 也让一台跑满的机器在别人都更糟时仍然分得到。
	MaxUtilisation = 0.95
)

func clampUnit(value float64) float64 {
	if !(value > 0) { // 含 NaN
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// Penalty 丢包和连接失败的惩罚系数，≥ 1：(1 + 10 × 丢包率) × (1 + 10 × 失败率)。不知道的那一项是 1。
func (q Quality) Penalty() float64 {
	penalty := 1 + LossPenaltySlope*clampUnit(q.Loss)
	if q.Success > 0 {
		penalty *= 1 + LossPenaltySlope*(1-clampUnit(q.Success))
	}
	return penalty
}

// Headroom 还剩几成余量：1 − 利用率，利用率最多按 MaxUtilisation 算，所以在 [0.05, 1] 里。不知道利用率是 1。
func (q Quality) Headroom() float64 {
	utilisation := clampUnit(q.Utilisation)
	if utilisation > MaxUtilisation {
		utilisation = MaxUtilisation
	}
	return 1 - utilisation
}

// Rand 是 [0, 1) 上的均匀随机数来源，*math/rand.Rand 直接满足。传 nil 时凡是要抽签的地方都退成确定的
// 选择（全扫、总是收下），测试里不想要随机性时用。
type Rand interface {
	Float64() float64
}

// 候选的分量怎么取。equal：候选的 Weight 全都 ≤ 0，一律当 1。noShare：这一次谁都分不到（Share 全都 ≤ 0，
// 或者只看 Weight 的场合），不乘 Share。
type weightMode struct {
	equal   bool
	noShare bool
}

func modeOf(members []Member, candidates []int) weightMode {
	mode := staticModeOf(members, candidates)
	mode.noShare = true
	for _, index := range candidates {
		member := &members[index]
		if member.Share > 0 && (mode.equal || member.Weight > 0) {
			mode.noShare = false
			break
		}
	}
	return mode
}

// staticModeOf：只看 Weight 的场合（按访客固定）用。
func staticModeOf(members []Member, candidates []int) weightMode {
	for _, index := range candidates {
		if members[index].Weight > 0 {
			return weightMode{noShare: true}
		}
	}
	return weightMode{equal: true, noShare: true}
}

func (m *Member) weightBy(mode weightMode) float64 {
	weight := 1.0
	if !mode.equal {
		if m.Weight <= 0 {
			return 0
		}
		weight = m.Weight
	}
	if mode.noShare {
		return weight
	}
	if m.Share <= 0 {
		return 0
	}
	return weight * m.Share
}

// EffectiveWeight 这个成员在 candidates 里这一次的有效分量（Weight × Share，按上面的退让规矩）。
// 上报「现在各占几成」之类的地方用，和挑选时用的是同一个数。
func EffectiveWeight(members []Member, candidates []int, index int) float64 {
	return members[index].weightBy(modeOf(members, candidates))
}

// drawByWeight 按分量抽一个候选（返回它在 candidates 里的位置，跳过 skip 那个位置）。u 是 [0,1) 的随机数。
// 没有可抽的返回 -1。
func drawByWeight(members []Member, candidates []int, mode weightMode, skip int, u float64) int {
	total := 0.0
	for position, index := range candidates {
		if position != skip {
			total += members[index].weightBy(mode)
		}
	}
	if total <= 0 {
		return -1
	}
	point := u * total
	last := -1
	for position, index := range candidates {
		if position == skip {
			continue
		}
		weight := members[index].weightBy(mode)
		if weight <= 0 {
			continue
		}
		last = position
		point -= weight
		if point < 0 {
			return position
		}
	}
	// 浮点误差：落到最后一个有份的。
	return last
}
