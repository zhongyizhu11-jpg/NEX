package main

import (
	"net"
	"sort"
	"strconv"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
线路组「新连接怎么分」（spread）：算法在共用的 lbcore 里（和 NEX 隧道的出口选择器同一套函数，
lbcore/testdata/conformance 的用例卡住两边一致，这边由 lbcore_conformance_test.go 拿 pickTargetForKeyProto 跑）。
这里只做一件事：把每条路径此刻的样子填成 lbcore.Member（membersLocked），再调 lbcore.Pick。

	Weight       路径的权重（≤ 0 不分新连接，除非所有路径都是 0）
	Share        慢启动：刚从挂掉恢复的路径 60 秒内从 10% 慢慢加到满份
	Active       这条路径上挂着的连接；InFlight 已经挑中、还在拨的（A8）
	Latency      自动：探测耗时（和比它慢的真实拨号）加上面板给的下游延迟，整个喂进 peak EWMA 的读数；
	             延迟优先：探测延迟的指数平均 + 下游延迟
	Jitter、Loss 探测窗口（最近 10 分钟）的抖动（「比最低延迟高出多少」的 90 分位，见 routeProbeJitter）、丢包
	Success      最近 10 分钟真实连接的拨通率（不到 5 次不算）
	Utilisation  面板给的沿途主机负载（LoadPct）

八种分配方式的算法、参数和默认值见 lbcore 各文件开头。以前这里自己写了一份（按权重的平滑加权轮询、
(连接 + 1) ÷ 权重的按负载、FNV 的 rendezvous、权重 × 延迟比 × 负载系数再随机挑两条的自动），和出口组的不一样。

主备里的「整链最优」比的也是这里的 Quality（lbcore.QualityCost，failover_selection.go 的 fastestIndexLocked）；
给人看的 0–100 分是同一个成本换算的（route_group.go 的 scoreLocked），不参与任何决定。
*/

func (p *failoverProxy) markSlowStartLocked(index int, now time.Time) {
	if len(p.slowStartAt) != len(p.spec.Targets) {
		p.slowStartAt = make([]time.Time, len(p.spec.Targets))
	}
	if index >= 0 && index < len(p.slowStartAt) {
		p.slowStartAt[index] = now
	}
}

// 慢启动系数。给 UDP 会话挑（udp）而且规格两侧分开判时，看 UDP 那一侧的恢复时刻（A11）；
// 面板提示撤掉时两侧一起记，所以不用再取两者里晚的那个。
func (p *failoverProxy) slowStartLocked(index int, now time.Time, udp bool) float64 {
	marks := p.slowStartAt
	if udp && p.udpSeparateLocked() {
		marks = p.udpSide.slowStartAt
	}
	if index < 0 || index >= len(marks) {
		return 1
	}
	return lbcore.DefaultSlowStart.Factor(marks[index], now)
}

// routePeakSamples：算 peak EWMA 时往回看几个样本。探测 5 秒一次、时间常数 10 秒，8 个样本（40 秒）之前的
// 影响已经不到 2%。
const routePeakSamples = 8

/*
peakLatencyLocked：这条路径整链延迟的 peak EWMA 读数（毫秒，0 = 还没探通过）。整链 = 本机量到的那一段 +
面板给的下游延迟（ExtraLatencyMs），样本喂进去的就是这个和（lbcore.PeakEWMA 两次样本之间停在最近一个样本上，
读数和下游延迟不会一个落一个不落，排名不会在一个探测间隔里翻）。

样本是最近几次探通的探测耗时，加上最近几次真实拨号里**比当时读数慢**的那些。真实拨号只到拨号地址（第一跳），
快的拨号说明不了整条路快；但它慢了就是这条路此刻真的慢（握手包丢了、对端忙不过来），而且它比 5 秒一次的探测
来得勤 —— 过载的路几条连接之内就被避开，不用等下一轮探测。

每次现算（不另存状态）：样本都带着时刻，按时间先后过一遍就是那个读数；规格换了、路径挪了位置也不用搬。
*/
func (p *failoverProxy) peakLatencyLocked(index int, now time.Time) float64 {
	if index < 0 || index >= len(p.stats) || index >= len(p.spec.Targets) || p.stats[index] == nil {
		return 0
	}
	extra := float64(p.spec.Targets[index].ExtraLatencyMs)
	stats := p.stats[index]
	probes := stats.samples
	if len(probes) > routePeakSamples {
		probes = probes[len(probes)-routePeakSamples:]
	}
	dials := stats.dials
	if len(dials) > routePeakSamples {
		dials = dials[len(dials)-routePeakSamples:]
	}
	var peak lbcore.PeakEWMA
	for len(probes) > 0 || len(dials) > 0 {
		if len(dials) == 0 || (len(probes) > 0 && !probes[0].at.After(dials[0].at)) {
			if sample := probes[0]; sample.ok {
				// 不到 1 毫秒按 1 算（和 latencyEwmaMs 一样）：0 留给「还没探通过」。
				peak.Observe(maxFloat(1, float64(sample.latencyMs))+extra, sample.at, 0)
			}
			probes = probes[1:]
			continue
		}
		if sample := dials[0]; sample.ok {
			if current, chain := peak.Value(sample.at, 0), float64(sample.ms)+extra; current > 0 && chain > current {
				peak.Observe(chain, sample.at, 0)
			}
		}
		dials = dials[1:]
	}
	return peak.Value(now, 0)
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// plainLatencyLocked：探测延迟的指数平均（还没探通就用最近一次探到的）；0 = 不知道。
func (p *failoverProxy) plainLatencyLocked(index int) float64 {
	if index >= 0 && index < len(p.stats) && p.stats[index] != nil && p.stats[index].latencyEwmaMs > 0 {
		return p.stats[index].latencyEwmaMs
	}
	if index >= 0 && index < len(p.lastLatencyMs) && p.lastLatencyMs[index] > 0 {
		return float64(p.lastLatencyMs[index])
	}
	return 0
}

// routeJitterMinSamples：探通的样本不到这么多，不算抖动（样本少时 90 分位就是最大值，一次尖峰就把它带飞）。
const routeJitterMinSamples = 10

/*
routeProbeJitter：探测窗口里「比这条路最低延迟高出多少」的 90 分位（毫秒）—— 排队造成的那部分，和出口组
「出口到目标」的抖动是同一个算法（forwardx-fxp/target_health.go）。样本不够返回 0（不知道）。

为什么不用评分里那个抖动（相邻两次的差的平均）：那个数一次 2 秒的尖峰就拉高几十毫秒，而且要等尖峰滑出
10 分钟的窗口才落回去。成本里的延迟（peak EWMA）半分钟就把尖峰忘了，抖动却还要罚它十分钟，这条路就白白少分十分钟。
*/
func routeProbeJitter(samples []routeProbeSample) float64 {
	latencies := make([]int, 0, len(samples))
	for _, sample := range samples {
		if sample.ok {
			latencies = append(latencies, sample.latencyMs)
		}
	}
	if len(latencies) < routeJitterMinSamples {
		return 0
	}
	sort.Ints(latencies)
	index := (len(latencies)*9+9)/10 - 1
	return float64(latencies[index] - latencies[0])
}

// routeQualityCache：一条路径算好的抖动，探测窗口没变就不重算（每条新连接、每条候选都排一遍序不值得）。
type routeQualityCache struct {
	stats   *routeTargetStats
	probeAt time.Time
	samples int
	jitter  float64
}

func (p *failoverProxy) probeJitterLocked(index int) float64 {
	stats := p.stats[index]
	if len(p.lbQuality) != len(p.spec.Targets) {
		p.lbQuality = make([]routeQualityCache, len(p.spec.Targets))
	}
	cache := &p.lbQuality[index]
	if cache.stats != stats || !cache.probeAt.Equal(stats.lastProbeAt) || cache.samples != len(stats.samples) {
		*cache = routeQualityCache{stats: stats, probeAt: stats.lastProbeAt, samples: len(stats.samples), jitter: routeProbeJitter(stats.samples)}
	}
	return cache.jitter
}

// routeSuccessMinDials：真实拨号不到这么多次，不拿拨通率说事（一两次失败说明不了什么）。
// routeAllFailedSuccess：全失败时的拨通率。Success 的 0 是「不知道」，全失败给一个最小的正数，按「几乎全失败」罚。
const (
	routeSuccessMinDials  = 5
	routeAllFailedSuccess = 0.01
)

/*
qualityLocked：这条路径有多好（lbcore.Quality）。peak 为 true 时延迟取整链的 peak EWMA 读数（自动），
否则取指数平均（延迟优先要按毫秒门槛比）。两种都是本机探出了延迟才加面板给的下游延迟 ExtraLatencyMs
（和整链评分一个口径：没探出就是不知道，不能靠下游那几段凑一个数）。
*/
func (p *failoverProxy) qualityLocked(index int, now time.Time, peak bool) lbcore.Quality {
	quality := lbcore.Quality{}
	if index < 0 || index >= len(p.spec.Targets) {
		return quality
	}
	target := p.spec.Targets[index]
	if peak {
		quality.Latency = p.peakLatencyLocked(index, now)
	}
	if quality.Latency <= 0 {
		if plain := p.plainLatencyLocked(index); plain > 0 {
			quality.Latency = plain + float64(target.ExtraLatencyMs)
		}
	}
	if index < len(p.stats) && p.stats[index] != nil {
		quality.Jitter = p.probeJitterLocked(index)
		quality.Loss = p.stats[index].summary().lossPct / 100
		if dials := p.stats[index].dialSummary(now); dials.ok+dials.failed >= routeSuccessMinDials {
			quality.Success = float64(dials.ok) / float64(dials.ok+dials.failed)
			if quality.Success <= 0 {
				quality.Success = routeAllFailedSuccess
			}
		}
	}
	if target.LoadPct > 0 {
		quality.Utilisation = float64(target.LoadPct) / 100
	}
	return quality
}

/*
membersLocked：把候选此刻的样子填成 lbcore.Member（按路径下标排，长度 = 路径数；只有候选那几格有意义）。
conns / inflight 给每条候选此刻挂着的、在途的连接数：整组分时就是这条路径上的，线路里几个落地分时是同一个落地
合起来的。strategy 决定要不要算质量（只有自动、延迟优先看）；udp 决定慢启动看哪一侧。
*/
func (p *failoverProxy) membersLocked(candidates []int, strategy string, now time.Time, udp bool, load func(index int) (active, inflight int)) []lbcore.Member {
	members := make([]lbcore.Member, len(p.spec.Targets))
	for _, index := range candidates {
		active, inflight := load(index)
		member := lbcore.Member{
			Weight:   float64(p.spec.Targets[index].Weight),
			Share:    p.slowStartLocked(index, now, udp),
			Active:   float64(active),
			InFlight: float64(inflight),
		}
		switch strategy {
		case lbcore.StrategyAuto:
			member.Quality = p.qualityLocked(index, now, true)
		case lbcore.StrategyLatency:
			member.Quality = p.qualityLocked(index, now, false)
		default:
			// 按负载只看负载那一半：利用率是负载，照给。
			if loadPct := p.spec.Targets[index].LoadPct; loadPct > 0 {
				member.Utilisation = float64(loadPct) / 100
			}
		}
		members[index] = member
	}
	return members
}

// pathLoadLocked：这条路径上挂着的、在途的连接数。
func (p *failoverProxy) pathLoadLocked(index int) (active, inflight int) {
	active = p.connectionsLocked(index)
	if index >= 0 && index < len(p.inflight) {
		inflight = p.inflight[index]
	}
	return active, inflight
}

/*
spreadStateLocked：lbcore 要的三样跨连接状态，都在代理自己身上（p.mu 管着）。

按权重的计数第一次用时才开，并且空转随机步定一个起步位置（lbcore.SmoothWRR.Spin，路线图 X4）：以前每个线路组
都从第一条路径起步，入口上几百条规则一起启动时，每条规则的第一条连接都落在同一条路径上。换规格时计数跟着路径
搬（route_group.go 的 rebuildForSpecLocked），不会重新转。
*/
func (p *failoverProxy) spreadStateLocked(members []lbcore.Member, candidates []int, weighted bool) lbcore.State {
	if weighted && len(p.wrrCurrent) != len(p.spec.Targets) {
		p.wrrCurrent = make([]int, len(p.spec.Targets))
		lbcore.SmoothWRR(p.wrrCurrent).Spin(members, candidates, uint64(p.randLocked().Int63()))
	}
	return lbcore.State{WRR: p.wrrCurrent, Near: &p.lbNear, Next: &p.roundRobinNext}
}

func (p *failoverProxy) randLocked() failoverRandSource {
	if p.rng == nil {
		p.rng = newFailoverRand(p.ruleID, p.sourcePort)
	}
	return p.rng
}

// failoverRandSource 是代理的随机数来源（*math/rand.Rand）要用到的那几个方法。
type failoverRandSource interface {
	Float64() float64
	Int63() int64
	Intn(n int) int
}

// randomSpreadStartRange：轮转计数随机初值的范围。比路径数大得多就行（对路径数取模后各条机会一样）。
const randomSpreadStartRange = 1 << 16

// randomSpreadStart：轮流、平手时从谁数起的随机初值（起代理时给 roundRobinNext，路线图 X4）。
func randomSpreadStart(ruleID int, sourcePort int) int {
	return newFailoverRand(ruleID, sourcePort).Intn(randomSpreadStartRange)
}

/*
spreadPickLocked：整组按 strategy 在候选里挑一条。hashKey 是访客（按访客固定用；不知道访客是谁时按轮流，
不把所有人钉在同一条路径上）。

按访客固定时每条路径的标识见 rendezvousKeyLocked。
*/
func (p *failoverProxy) spreadPickLocked(strategy string, candidates []int, hashKey string, udp bool) int {
	if len(candidates) == 0 {
		return -1
	}
	now := time.Now()
	members := p.membersLocked(candidates, strategy, now, udp, p.pathLoadLocked)
	var keys []string
	if strategy == lbcore.StrategyIPHash && hashKey != "" {
		keys = make([]string, len(p.spec.Targets))
		for _, index := range candidates {
			keys[index] = p.rendezvousKeyLocked(index)
		}
	}
	state := p.spreadStateLocked(members, candidates, strategy == lbcore.StrategyWeighted)
	return lbcore.Pick(strategy, state, members, keys, candidates, hashKey, now, p.randLocked(), p.pickOptionsLocked())
}

// pickOptionsLocked：整组分、线路里几个落地分都用这一份（F5：线路里以前传空的，门槛永远 50ms、不驻留）。
// 延迟优先的门槛是规格的 LatencyMarginMs（GOST 出口组带面板「检测与切换」里的那个数），和 NEX 出口组一样留组 1 分钟。
func (p *failoverProxy) pickOptionsLocked() lbcore.Options {
	return lbcore.Options{Near: lbcore.NearPolicy{Margin: p.latencyMarginLocked(), Hold: lbcore.DefaultNearHold}}
}

// ---- 在途计数（A8，见 failover_pick.go 的 pickReserved） ----

// failoverReservation 一笔在途：记在哪条路径上、是哪一代的下标（换规格以后旧下标作废，不退）。
type failoverReservation struct {
	index int
	gen   uint64
	held  bool
}

// loadLocked 这条路径此刻的负载：挂着的连接 + 已经挑中、还在拨的。「按负载」「自动」「按访客固定」的上限按它算；
// 报给面板的连接数仍然只是挂着的（connectionsLocked）。
func (p *failoverProxy) loadLocked(index int) int {
	active, inflight := p.pathLoadLocked(index)
	return active + inflight
}

// 调用方持有 p.mu（写锁）。
func (p *failoverProxy) reserveLocked(index int) failoverReservation {
	if len(p.inflight) != len(p.spec.Targets) {
		p.inflight = make([]int, len(p.spec.Targets))
	}
	if index < 0 || index >= len(p.inflight) {
		return failoverReservation{}
	}
	p.inflight[index]++
	return failoverReservation{index: index, gen: p.inflightGen, held: true}
}

func (p *failoverProxy) releaseReservationLocked(reservation failoverReservation) {
	if !reservation.held || reservation.gen != p.inflightGen {
		return
	}
	if reservation.index >= 0 && reservation.index < len(p.inflight) && p.inflight[reservation.index] > 0 {
		p.inflight[reservation.index]--
	}
}

// releaseReservation 退掉一笔在途：拨失败、竞速输了、或者已经转成连接。零值可以随便退。
func (p *failoverProxy) releaseReservation(reservation failoverReservation) {
	if !reservation.held {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.releaseReservationLocked(reservation)
}

// moveConnReserved 保护期里换了路：在途转成连接，客户端连接从原来那条路径名下挪到 index 上，一把锁里做完。
func (p *failoverProxy) moveConnReserved(client net.Conn, index int, reservation failoverReservation) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.releaseReservationLocked(reservation)
	for i := range p.conns {
		delete(p.conns[i], client)
	}
	p.trackConnLocked(index, client)
}

// trackConnReserved 拨通了：在途转成连接，一把锁里做完（中间不会被别的挑选看到少算或多算一条）。
func (p *failoverProxy) trackConnReserved(index int, conn net.Conn, reservation failoverReservation) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.releaseReservationLocked(reservation)
	p.trackConnLocked(index, conn)
}

/*
rendezvousKeyLocked：按访客固定时这条路径在哈希里的名字。

  - 出口组：出口的主机号。访客跟着「那台机器」走 —— 出口换个顺序、面板重新分一次本机端口（每台出口在入口上是
    127.0.0.1:<端口>），访客都不换出口。
  - 线路组：「地址:端口#下标」。两条路径可以拨同一个地址（经不同的中转），下标把它们分开。

名字只差末尾几个字符也不会偏：lbcore.Rendezvous 在 FNV 后面有一道终混（rendezvous.go）。
*/
func (p *failoverProxy) rendezvousKeyLocked(index int) string {
	if report := p.spec.BalanceReport; report != nil && index < len(report.HostIDs) {
		return "exit-host-" + strconv.Itoa(report.HostIDs[index])
	}
	target := p.spec.Targets[index]
	return target.TargetIP + ":" + strconv.Itoa(target.TargetPort) + "#" + strconv.Itoa(index)
}
