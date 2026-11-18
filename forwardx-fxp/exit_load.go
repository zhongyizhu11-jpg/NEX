package main

import (
	"math"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

/*
出口主机的实时负载，给「按负载」和「按访客固定」挑出口用。

以前选出口只看健康：轮流、随机、按权重都是数新连接，不管那台现在有多忙。可这里的连接多半很长
（代理、视频），连接数和负载对不上 —— 一条 4K 视频顶得上几十条闲着的长连接。所以按主机记：

  - active   现在挂在它上面的会话数（TCP 会话和 UDP 会话都算）
  - rate     最近的流量（字节/秒，10 秒时间常数的指数平均），每秒采一次
  - recent   刚挑中它的会话（5 秒时间常数衰减）：挑中的那一刻就记（不等拨通），拨不通再退回去。
             新连接还没跑起量，rate 里看不出来，不算它的话一波新连接会全压到同一台「看起来最闲」的上；
             以前拨通了才记，同时到的一批连接互相看不见（路线图 X5）
  - latency  握手耗时（按时间加权的指数平均，见 observeLatency）
  - recoveredAt  从挂掉恢复的时刻：之后 60 秒按比例慢慢加量（Envoy / HAProxy 的 slow start），
             免得刚恢复、一条连接都没有的出口被新连接一下子塞满

按主机而不是按端点记：同一台出口机被几条规则、几个端口用着时，线路带宽是它们共用的。整个进程一份。
「主机」是什么见 endpointLoadKey：V2（用户态 WireGuard）下出口全是 127.0.0.1:端口，不能按主机名合并。
*/

const (
	fxpLoadRateTau   = 10 * time.Second
	fxpLoadRecentTau = 5 * time.Second
	// 延迟的时间常数：两次样本隔得越久，新样本占得越重。新样本的分量夹在 [0.1, 0.6]：
	// 连接很密时（间隔几毫秒）每个样本也占一成，不至于几乎不动；隔了很久才来的一个样本最多占六成，
	// 一次 1 秒的重发不会把记下的延迟整个换掉，下一两次正常的探测就把它拉回来。
	fxpLoadLatencyTau      = 3 * time.Second
	fxpLoadLatencyMinAlpha = 0.1
	fxpLoadLatencyMaxAlpha = 0.6
	// 有选择器在用延迟挑出口时，一台出口这么久没有新的延迟样本就主动量一次；
	// 因为延迟被排到后面（少分 / 不分）的，每 fxpLatencyRecheckEvery 量一次，不让它靠一个旧样本一直饿着。
	fxpLatencyProbeEvery   = 10 * time.Second
	fxpLatencyRecheckEvery = 3 * time.Second
	fxpLatencyStarvedFor   = 10 * time.Second
	fxpLatencyUsedWindow   = time.Minute
	fxpSlowStartWindow     = 60 * time.Second
	fxpSlowStartMin        = 0.1
	fxpLatencyTolerance    = 50.0 // ms：差得不多就当一样快，免得来回跳
	fxpHashLoadFactor      = 1.25 // 按访客固定时，一台最多比它该分的多 25%，再多就往下一台放
	// 还没测出每条连接大概多少流量时，先当它 512 KiB/s：只影响「刚开的连接」那一项的分量。
	fxpLoadDefaultPerConn = 512 * 1024.0
	// 每条挂着的会话（不管有没有流量）折成这么多流量算进成本：闲着的长连接也占出口的连接表、内存，
	// 界面上写的也是「连接数」。取得小（约默认每连接流量的 1/32）：有流量的时候还是流量说了算。
	fxpLoadPerStream = 16 * 1024.0
)

type fxpHostLoad struct {
	host string

	active atomic.Int64
	bytes  atomic.Int64
	// latencyUsedAt / latencyStarvedAt（Unix 纳秒）：最近一次有选择器拿它的延迟去比、
	// 最近一次它因为延迟被排到后面。端点维护循环据此决定要不要主动量一次（endpoint_pool.go）。
	latencyUsedAt    atomic.Int64
	latencyStarvedAt atomic.Int64

	mu          sync.Mutex
	rate        float64
	sampledAt   time.Time
	recent      float64
	recentAt    time.Time
	latency     float64
	latencyAt   time.Time
	recoveredAt time.Time
}

var fxpHostLoads = struct {
	mu      sync.Mutex
	loads   map[string]*fxpHostLoad
	perConn float64
}{loads: map[string]*fxpHostLoad{}, perConn: fxpLoadDefaultPerConn}

func fxpHostLoadFor(host string) *fxpHostLoad {
	fxpHostLoads.mu.Lock()
	defer fxpHostLoads.mu.Unlock()
	load := fxpHostLoads.loads[host]
	if load == nil {
		load = &fxpHostLoad{host: host}
		fxpHostLoads.loads[host] = load
	}
	return load
}

/*
endpointLoadKey：这个端点的负载记在哪一份上（路线图 X2）。

  - 配置里写了 loadKey（面板知道几个端点其实是同一台机器、或者同一个地址后面是几台机器时给）就用它；
  - 否则按主机名：同一台出口的几个端口共用线路带宽；
  - 主机是本机环回时按「主机:端口」：V2（用户态 WireGuard）把每台出口都改写成 127.0.0.1:<端口>，
    按主机名记就全算在一份上 —— 「按负载」「自动」全压容量最大的那台，「按访客固定」的上限也失效。
*/
func endpointLoadKey(endpoint exitEndpoint) string {
	if key := strings.TrimSpace(endpoint.LoadKey); key != "" {
		return key
	}
	host := strings.TrimSpace(endpoint.Host)
	if isLoopbackHost(host) {
		return net.JoinHostPort(host, strconv.Itoa(endpoint.Port))
	}
	return host
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// resetFXPHostLoads 只给测试用。
func resetFXPHostLoads() {
	fxpHostLoads.mu.Lock()
	fxpHostLoads.loads = map[string]*fxpHostLoad{}
	fxpHostLoads.perConn = fxpLoadDefaultPerConn
	fxpHostLoads.mu.Unlock()
}

func decay(dt, tau time.Duration) float64 {
	if dt <= 0 {
		return 1
	}
	return math.Exp(-float64(dt) / float64(tau))
}

// notePick：选择器刚把一条新会话给了这台（还没拨）。马上算进「刚开的连接」，同时到的下一条就看得见。
func (l *fxpHostLoad) notePick(now time.Time) {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.recent = l.recent*decay(now.Sub(l.recentAt), fxpLoadRecentTau) + 1
	l.recentAt = now
	l.mu.Unlock()
}

// unpick：挑中了却没拨通（或者会话没建起来），把 notePick 记的那一条退回去。
func (l *fxpHostLoad) unpick(now time.Time) {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.recent = l.recent*decay(now.Sub(l.recentAt), fxpLoadRecentTau) - 1
	if l.recent < 0 {
		l.recent = 0
	}
	l.recentAt = now
	l.mu.Unlock()
}

// open 记一条会话开始挂在这台上（「刚开的连接」那一项在挑中时已经由 notePick 记过）。
func (l *fxpHostLoad) open(time.Time) {
	if l == nil {
		return
	}
	l.active.Add(1)
}

func (l *fxpHostLoad) close() {
	if l == nil {
		return
	}
	if l.active.Add(-1) < 0 {
		l.active.Store(0)
	}
}

func (l *fxpHostLoad) addBytes(n int) {
	if l == nil || n <= 0 {
		return
	}
	l.bytes.Add(int64(n))
}

// sample 每秒一次：把这一秒的字节数折进 rate。
func (l *fxpHostLoad) sample(now time.Time) {
	bytes := l.bytes.Swap(0)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.sampledAt.IsZero() {
		l.sampledAt = now
		l.rate = 0
		return
	}
	dt := now.Sub(l.sampledAt)
	if dt <= 0 {
		l.bytes.Add(bytes)
		return
	}
	l.sampledAt = now
	instant := float64(bytes) / dt.Seconds()
	keep := decay(dt, fxpLoadRateTau)
	l.rate = l.rate*keep + instant*(1-keep)
}

/*
observeLatency 记一次握手耗时（毫秒）：按时间加权的指数平均，往新样本靠（路线图 X10）。

以前是「峰值敏感」：变慢立刻整个跟上、变快只能按 10 秒慢慢落，而且只有来新样本时才落 —— 闲着的出口
碰上一次 1 秒的重发，记下的延迟就停在 1100ms，「延迟优先 / 自动」下它分不到连接，也就没有新样本把它拉回来。
现在涨和落用同一个式子：新样本的分量 = 1 - e^(-间隔/3s)，夹在 [0.1, 0.6]。
*/
func (l *fxpHostLoad) observeLatency(d time.Duration, now time.Time) {
	if l == nil || d <= 0 {
		return
	}
	ms := float64(d) / float64(time.Millisecond)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.latency == 0 || l.latencyAt.IsZero() {
		l.latency = ms
	} else {
		alpha := 1 - decay(now.Sub(l.latencyAt), fxpLoadLatencyTau)
		if alpha < fxpLoadLatencyMinAlpha {
			alpha = fxpLoadLatencyMinAlpha
		}
		if alpha > fxpLoadLatencyMaxAlpha {
			alpha = fxpLoadLatencyMaxAlpha
		}
		l.latency += (ms - l.latency) * alpha
	}
	l.latencyAt = now
}

// noteLatencyUsed：有选择器正拿这台的延迟去比（按负载 / 自动 / 延迟优先）。
func (l *fxpHostLoad) noteLatencyUsed(now time.Time) {
	if l != nil {
		l.latencyUsedAt.Store(now.UnixNano())
	}
}

// noteLatencyStarved：这台因为延迟被排到后面了。
func (l *fxpHostLoad) noteLatencyStarved(now time.Time) {
	if l != nil {
		l.latencyStarvedAt.Store(now.UnixNano())
	}
}

// latencyProbeDue：该不该主动量一次到这台的握手延迟。只有最近有选择器用它的延迟时才量；
// 正因为延迟吃亏的那台量得勤（fxpLatencyRecheckEvery），其余的隔 fxpLatencyProbeEvery 没样本才量。
func (l *fxpHostLoad) latencyProbeDue(now time.Time) bool {
	if l == nil {
		return false
	}
	used := l.latencyUsedAt.Load()
	if used == 0 || now.Sub(time.Unix(0, used)) > fxpLatencyUsedWindow {
		return false
	}
	l.mu.Lock()
	at := l.latencyAt
	l.mu.Unlock()
	age := fxpLatencyProbeEvery
	if !at.IsZero() {
		age = now.Sub(at)
	}
	if starved := l.latencyStarvedAt.Load(); starved != 0 && now.Sub(time.Unix(0, starved)) <= fxpLatencyStarvedFor {
		return age >= fxpLatencyRecheckEvery
	}
	return age >= fxpLatencyProbeEvery
}

func (l *fxpHostLoad) markRecovered(now time.Time) {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.recoveredAt = now
	l.mu.Unlock()
}

type fxpHostLoadSnapshot struct {
	active    float64
	rate      float64
	recent    float64
	latency   float64
	slowStart float64
}

func (l *fxpHostLoad) snapshot(now time.Time) fxpHostLoadSnapshot {
	if l == nil {
		return fxpHostLoadSnapshot{slowStart: 1}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	snap := fxpHostLoadSnapshot{
		active:    float64(l.active.Load()),
		rate:      l.rate,
		recent:    l.recent * decay(now.Sub(l.recentAt), fxpLoadRecentTau),
		latency:   l.latency,
		slowStart: 1,
	}
	if !l.recoveredAt.IsZero() {
		if since := now.Sub(l.recoveredAt); since < fxpSlowStartWindow {
			snap.slowStart = math.Max(fxpSlowStartMin, float64(since)/float64(fxpSlowStartWindow))
		}
	}
	return snap
}

// sampleFXPHostLoads 由端点维护循环每秒调一次；顺便更新「每条活动连接大概多少流量」。
func sampleFXPHostLoads(now time.Time) {
	fxpHostLoads.mu.Lock()
	loads := make([]*fxpHostLoad, 0, len(fxpHostLoads.loads))
	for _, load := range fxpHostLoads.loads {
		loads = append(loads, load)
	}
	fxpHostLoads.mu.Unlock()
	var rate, active float64
	for _, load := range loads {
		load.sample(now)
		load.mu.Lock()
		rate += load.rate
		load.mu.Unlock()
		active += float64(load.active.Load())
	}
	if active >= 1 && rate > 0 {
		perConn := math.Max(64*1024, rate/active)
		fxpHostLoads.mu.Lock()
		fxpHostLoads.perConn = fxpHostLoads.perConn*0.9 + perConn*0.1
		fxpHostLoads.mu.Unlock()
	}
}

func fxpLoadPerConn() float64 {
	fxpHostLoads.mu.Lock()
	defer fxpHostLoads.mu.Unlock()
	return fxpHostLoads.perConn
}

// ---- 选择器里用到的算法 ----

// endpointCapacities 每个端点的分量：都写了线路带宽就按带宽；否则都写了权重就按权重；否则一样大。
// 混着比（有的按 Mbps 有的按份数）没有意义，所以要么全用一种，要么都当 1。
func endpointCapacities(endpoints []exitEndpoint) []float64 {
	caps := make([]float64, len(endpoints))
	allCap, allWeight := true, true
	for _, endpoint := range endpoints {
		if endpoint.CapacityMbps <= 0 {
			allCap = false
		}
		if endpoint.Weight <= 0 {
			allWeight = false
		}
	}
	for i, endpoint := range endpoints {
		switch {
		case allCap:
			caps[i] = float64(endpoint.CapacityMbps)
		case allWeight:
			caps[i] = float64(endpoint.Weight)
		default:
			caps[i] = 1
		}
	}
	return caps
}

/*
pickLeastLoad：「按负载」。挑分数最小的：

		分数 = (最近流量 + 每条连接的估计流量 × (刚挑中的连接数 + 1) + fxpLoadPerStream × 挂着的会话数)
		       ÷ (分量 × 慢启动系数 × 到目标的健康折算) × 延迟系数

	  - 最近流量：忙的连接按它实际跑的量算（一条 4K 视频顶几十条闲连接）。
	  - 刚挑中的连接：挑中那一刻就记，5 秒衰减（它们的流量很快会出现在「最近流量」里）。+1 是「这一条放上去之后」。
	  - 挂着的会话数：闲着的长连接没有流量，但也占着出口；每条折 16 KiB/s（路线图 X5）。
	    两台都没什么流量时，新连接给会话少的那台；有流量时这一项只是个小修正。
	  - 延迟系数：比最快的慢出门槛时乘 sqrt(延迟比)。

候选多于 3 个时用「随机挑两个比一比」（P2C）：好几台入口各自看到的负载有延迟，全都去抢「看起来最闲」
的那一台反而会把它压垮。调用方持锁。

factors：到目标的健康折算（target_health.go，少分的按几成算）。endToEnd（「自动」）：延迟按「入口到出口的握手
+ 出口到目标的中位数 + 抖动」算整条，门槛用面板设的「比最快的慢多少就少分」；「按负载」只看到出口的握手。
*/
func (s *exitEndpointSelector) pickLeastLoad(candidates []int, now time.Time, factors []float64, endToEnd bool) int {
	if len(candidates) == 1 {
		return candidates[0]
	}
	s.ensureBuffersLocked()
	snaps, latencies := s.snapBuf, s.latBuf
	minLatency := 0.0
	tolerance := fxpLatencyTolerance
	if endToEnd && s.targetAware() {
		tolerance = s.target.detect.margin
	}
	for _, index := range candidates {
		snap := s.loads[index].snapshot(now)
		s.loads[index].noteLatencyUsed(now)
		snaps[index] = snap
		latency := snap.latency
		if endToEnd {
			if median, jitter := s.targetLatencyLocked(index); median > 0 {
				latency += median + jitter
			}
		}
		latencies[index] = latency
		if latency > 0 && (minLatency == 0 || latency < minLatency) {
			minLatency = latency
		}
	}
	perConn := fxpLoadPerConn()
	for _, index := range candidates {
		snap := snaps[index]
		capacity := s.capacities[index] * snap.slowStart * factorOf(factors, index)
		if capacity <= 0 {
			capacity = fxpSlowStartMin
		}
		value := (snap.rate + perConn*(snap.recent+1) + fxpLoadPerStream*snap.active) / capacity
		if latency := latencies[index]; minLatency > 0 && latency > 0 && latency-minLatency > tolerance {
			value *= math.Sqrt(latency / minLatency)
			// 它因为延迟吃亏了：让维护循环勤量几次，别靠一个旧样本一直排在后面。
			s.loads[index].noteLatencyStarved(now)
		}
		s.costBuf[index] = value
	}
	// 分数一样（比如刚启动都没量）时轮着来，不总落在第一个上。
	start := s.next % len(candidates)
	s.next = (s.next + 1) % 1000000
	if len(candidates) <= 3 {
		best, bestCost := -1, 0.0
		for offset := range candidates {
			index := candidates[(start+offset)%len(candidates)]
			if c := s.costBuf[index]; best < 0 || c < bestCost {
				best, bestCost = index, c
			}
		}
		return best
	}
	first := s.pickByCapacity(candidates, -1)
	second := s.pickByCapacity(candidates, first)
	if s.costBuf[second] < s.costBuf[first] {
		return second
	}
	return first
}

// pickLowestLatency：「延迟优先」。整条延迟（入口到出口的握手 + 出口到目标的中位数 + 抖动）最低的那台，
// 和它差不到门槛的几台一起按负载分（不全压在一台上，也不在几毫秒的差别上来回跳）。调用方持锁。
func (s *exitEndpointSelector) pickLowestLatency(candidates []int, now time.Time, factors []float64) int {
	if len(candidates) == 1 {
		return candidates[0]
	}
	s.ensureBuffersLocked()
	margin := fxpLatencyTolerance
	if s.targetAware() {
		margin = s.target.detect.margin
	}
	scores := s.scoreBuf
	best := 0.0
	for _, index := range candidates {
		score := s.loads[index].snapshot(now).latency
		s.loads[index].noteLatencyUsed(now)
		if median, jitter := s.targetLatencyLocked(index); median > 0 {
			score += median + jitter
		}
		scores[index] = score
		if score > 0 && (best == 0 || score < best) {
			best = score
		}
	}
	if best == 0 {
		return s.pickLeastLoad(candidates, now, factors, false)
	}
	near := s.nearBuf[:0]
	for _, index := range candidates {
		if score := scores[index]; score > 0 && score-best <= margin {
			near = append(near, index)
		} else if score > 0 {
			// 这台因为延迟这一轮不分：记下来，维护循环会勤量它（路线图 X10）。
			s.loads[index].noteLatencyStarved(now)
		}
	}
	s.nearBuf = near
	if len(near) == 0 {
		return s.pickLeastLoad(candidates, now, factors, false)
	}
	return s.pickLeastLoad(near, now, factors, false)
}

// pickByCapacity 按分量随机挑一个（跳过 skip）。
func (s *exitEndpointSelector) pickByCapacity(candidates []int, skip int) int {
	total := 0.0
	for _, index := range candidates {
		if index != skip {
			total += s.capacities[index]
		}
	}
	value, err := s.randomValue()
	if err != nil || total <= 0 {
		for _, index := range candidates {
			if index != skip {
				return index
			}
		}
		return candidates[0]
	}
	target := float64(value%1_000_000) / 1_000_000 * total
	for _, index := range candidates {
		if index == skip {
			continue
		}
		target -= s.capacities[index]
		if target < 0 {
			return index
		}
	}
	for i := len(candidates) - 1; i >= 0; i-- {
		if candidates[i] != skip {
			return candidates[i]
		}
	}
	return candidates[0]
}

const (
	fnv64aOffset = 14695981039346656037
	fnv64aPrime  = 1099511628211
)

func fnv64aAddString(hash uint64, value string) uint64 {
	for i := 0; i < len(value); i++ {
		hash ^= uint64(value[i])
		hash *= fnv64aPrime
	}
	return hash
}

// rendezvousScore：加权 rendezvous 哈希的分数，只由「键 + 出口地址 + 容量」决定，哪台机器算都一样。调用方持锁。
// 哈希是 FNV-1a 64（键、一个 0 字节、「主机:端口」），手写是为了不在挑选路径上分配；算出来的值和
// 以前用 hash/fnv 的一模一样 —— 叠加连接靠各台中继算出同一个结果（见 pickSessionAffinity），新旧版本混着也要一致。
func (s *exitEndpointSelector) rendezvousScore(index int, key string) float64 {
	return s.rendezvousScoreOf(s.rendezvousHash(index, key), index)
}

func (s *exitEndpointSelector) rendezvousHash(index int, key string) uint64 {
	hash := fnv64aAddString(fnv64aOffset, key)
	hash *= fnv64aPrime // 分隔用的 0 字节：异或 0 不变，只乘一次
	if index < len(s.hashAddrs) {
		return fnv64aAddString(hash, s.hashAddrs[index])
	}
	return fnv64aAddString(hash, s.endpoints[index].Host+":"+strconv.Itoa(s.endpoints[index].Port))
}

func (s *exitEndpointSelector) rendezvousScoreOf(hash uint64, index int) float64 {
	u := (float64(hash>>11) + 0.5) / float64(uint64(1)<<53)
	return -s.capacities[index] / math.Log(u)
}

/*
mixHash64：把哈希再搅一遍（splitmix64 的收尾）。

FNV-1a 最后一步是「异或一个字节、乘一个常数」：两个出口地址只差最后一两个字符时（同一台机器的两个端口 ——
V2 下的 127.0.0.1:端口 正是这样；或者只差 IP 最后一段），同一个访客对这两台算出来的哈希只差在低位，
换算成 0~1 的数几乎相等，加权之后永远是容量大的那台赢：900:100 的两台出口，「按访客固定」把所有访客
都固定到 900 那台上，另一台一个都分不到（路线图 X2 的回归测试跑出来的）。搅过之后各位都参与，才是真的按容量分。

只给入口本机的「按访客固定」用（pickRendezvous）。叠加连接的 pickSessionAffinity 不搅：那个结果要和别的中继
算出来的一致，新旧版本混着跑时不能一边搅一边不搅。
*/
func mixHash64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

// pickRendezvous：「按访客固定」。加权的最高随机权重哈希（rendezvous hashing）：每个出口按
// 「访客 + 出口」算一个分，分最高的拿走。一台出口挂了只有原来落在它上面的访客要换，其余人不动
// （以前是「哈希 % 健康的个数」，挂一台几乎所有人都换出口，要保持登录的服务全掉线）。
// 再加一条上限：一台已经比它该分的多 25% 了，就往分数第二的放，免得一个大 NAT 出口把一台压垮。
// 从高到低一个个找（每轮扫一遍取最大的），不排序、不分配。调用方持锁。
func (s *exitEndpointSelector) pickRendezvous(candidates []int, key string, _ time.Time) int {
	s.ensureBuffersLocked()
	scores := s.scoreBuf
	totalActive, totalCap := 0.0, 0.0
	for _, index := range candidates {
		scores[index] = s.rendezvousScoreOf(mixHash64(s.rendezvousHash(index, key)), index)
		totalActive += float64(s.loads[index].active.Load())
		totalCap += s.capacities[index]
	}
	top := -1
	for range candidates {
		best := -1
		for _, index := range candidates {
			if scores[index] >= 0 && (best < 0 || scores[index] > scores[best]) {
				best = index
			}
		}
		if best < 0 {
			break
		}
		if top < 0 {
			top = best
		}
		limit := math.Ceil(fxpHashLoadFactor * (totalActive + 1) * s.capacities[best] / totalCap)
		if float64(s.loads[best].active.Load()) < limit {
			return best
		}
		scores[best] = -1 // 这台满了，看下一个
	}
	if top < 0 {
		return candidates[0]
	}
	return top
}
