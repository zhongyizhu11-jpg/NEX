package main

import (
	"hash/fnv"
	"math"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

/*
出口主机的实时负载，给「按负载」和「按访客固定」挑出口用。

以前选出口只看健康：轮流、随机、按权重都是数新连接，不管那台现在有多忙。可这里的连接多半很长
（代理、视频），连接数和负载对不上 —— 一条 4K 视频顶得上几十条闲着的长连接。所以按主机记：

  - active   现在挂在它上面的会话数
  - rate     最近的流量（字节/秒，10 秒时间常数的指数平均），每秒采一次
  - recent   刚开的会话（5 秒时间常数衰减）：新连接还没跑起量，rate 里看不出来，不算它的话
             一波新连接会全压到同一台「看起来最闲」的上
  - latency  握手耗时（峰值敏感的指数平均：变慢立刻跟上，变快慢慢回落，Finagle 的 peak EWMA）
  - recoveredAt  从挂掉恢复的时刻：之后 60 秒按比例慢慢加量（Envoy / HAProxy 的 slow start），
             免得刚恢复、一条连接都没有的出口被新连接一下子塞满

按主机而不是按端点记：同一台出口机被几条规则、几个端口用着时，线路带宽是它们共用的。整个进程一份。
*/

const (
	fxpLoadRateTau      = 10 * time.Second
	fxpLoadRecentTau    = 5 * time.Second
	fxpLoadLatencyTau   = 10 * time.Second
	fxpSlowStartWindow  = 60 * time.Second
	fxpSlowStartMin     = 0.1
	fxpLatencyTolerance = 50.0 // ms：差得不多就当一样快，免得来回跳
	fxpHashLoadFactor   = 1.25 // 按访客固定时，一台最多比它该分的多 25%，再多就往下一台放
	// 还没测出每条连接大概多少流量时，先当它 512 KiB/s：只影响「刚开的连接」那一项的分量。
	fxpLoadDefaultPerConn = 512 * 1024.0
)

type fxpHostLoad struct {
	host string

	active atomic.Int64
	bytes  atomic.Int64

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

// open 记一条会话开始用这台。
func (l *fxpHostLoad) open(now time.Time) {
	if l == nil {
		return
	}
	l.active.Add(1)
	l.mu.Lock()
	l.recent = l.recent*decay(now.Sub(l.recentAt), fxpLoadRecentTau) + 1
	l.recentAt = now
	l.mu.Unlock()
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

// observeLatency 记一次握手耗时（毫秒）。变慢立刻跟上，变快按 10 秒慢慢回落。
func (l *fxpHostLoad) observeLatency(d time.Duration, now time.Time) {
	if l == nil || d <= 0 {
		return
	}
	ms := float64(d) / float64(time.Millisecond)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.latency == 0 || ms > l.latency {
		l.latency = ms
	} else {
		keep := decay(now.Sub(l.latencyAt), fxpLoadLatencyTau)
		l.latency = l.latency*keep + ms*(1-keep)
	}
	l.latencyAt = now
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

// pickLeastLoad：「按负载」。分数 = (最近流量 + 刚开的连接 × 每条连接的估计流量) ÷ (分量 × 慢启动系数) × 延迟系数，
// 挑分数最小的。候选多于 3 个时用「随机挑两个比一比」（P2C）：好几台入口各自看到的负载有延迟，
// 全都去抢「看起来最闲」的那一台反而会把它压垮。调用方持锁。
func (s *exitEndpointSelector) pickLeastLoad(candidates []int, now time.Time) int {
	if len(candidates) == 1 {
		return candidates[0]
	}
	snaps := make(map[int]fxpHostLoadSnapshot, len(candidates))
	minLatency := 0.0
	for _, index := range candidates {
		snap := s.loads[index].snapshot(now)
		snaps[index] = snap
		if snap.latency > 0 && (minLatency == 0 || snap.latency < minLatency) {
			minLatency = snap.latency
		}
	}
	perConn := fxpLoadPerConn()
	cost := func(index int) float64 {
		snap := snaps[index]
		capacity := s.capacities[index] * snap.slowStart
		if capacity <= 0 {
			capacity = fxpSlowStartMin
		}
		value := (snap.rate + perConn*(snap.recent+1)) / capacity
		if minLatency > 0 && snap.latency > 0 && snap.latency-minLatency > fxpLatencyTolerance {
			value *= math.Sqrt(snap.latency / minLatency)
		}
		return value
	}
	// 分数一样（比如刚启动都没量）时轮着来，不总落在第一个上。
	start := s.next % len(candidates)
	s.next = (s.next + 1) % 1000000
	if len(candidates) <= 3 {
		best, bestCost := -1, 0.0
		for offset := range candidates {
			index := candidates[(start+offset)%len(candidates)]
			if c := cost(index); best < 0 || c < bestCost {
				best, bestCost = index, c
			}
		}
		return best
	}
	first := s.pickByCapacity(candidates, -1)
	second := s.pickByCapacity(candidates, first)
	if cost(second) < cost(first) {
		return second
	}
	return first
}

// pickByCapacity 按分量随机挑一个（跳过 skip）。
func (s *exitEndpointSelector) pickByCapacity(candidates []int, skip int) int {
	total := 0.0
	for _, index := range candidates {
		if index != skip {
			total += s.capacities[index]
		}
	}
	value, err := randomUint64()
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

// rendezvousScore：加权 rendezvous 哈希的分数，只由「键 + 出口地址 + 容量」决定，哪台机器算都一样。调用方持锁。
func (s *exitEndpointSelector) rendezvousScore(index int, key string) float64 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(key))
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(s.endpoints[index].Host + ":" + strconv.Itoa(s.endpoints[index].Port)))
	u := (float64(hash.Sum64()>>11) + 0.5) / float64(uint64(1)<<53)
	return -s.capacities[index] / math.Log(u)
}

// pickRendezvous：「按访客固定」。加权的最高随机权重哈希（rendezvous hashing）：每个出口按
// 「访客 + 出口」算一个分，分最高的拿走。一台出口挂了只有原来落在它上面的访客要换，其余人不动
// （以前是「哈希 % 健康的个数」，挂一台几乎所有人都换出口，要保持登录的服务全掉线）。
// 再加一条上限：一台已经比它该分的多 25% 了，就往分数第二的放，免得一个大 NAT 出口把一台压垮。
// 调用方持锁。
func (s *exitEndpointSelector) pickRendezvous(candidates []int, key string, now time.Time) int {
	type scored struct {
		index int
		score float64
	}
	order := make([]scored, 0, len(candidates))
	totalActive, totalCap := 0.0, 0.0
	for _, index := range candidates {
		order = append(order, scored{index: index, score: s.rendezvousScore(index, key)})
		totalActive += float64(s.loads[index].active.Load())
		totalCap += s.capacities[index]
	}
	for i := 1; i < len(order); i++ {
		for j := i; j > 0 && order[j].score > order[j-1].score; j-- {
			order[j], order[j-1] = order[j-1], order[j]
		}
	}
	for _, item := range order {
		limit := math.Ceil(fxpHashLoadFactor * (totalActive + 1) * s.capacities[item.index] / totalCap)
		if float64(s.loads[item.index].active.Load()) < limit {
			return item.index
		}
	}
	return order[0].index
}
