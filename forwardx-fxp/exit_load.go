package main

import (
	"math"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
出口主机的实时负载和延迟，给挑出口用（挑选的算法在 lbcore，怎么喂进去见 exit_select.go 的 fillMembersLocked）。

以前选出口只看健康：轮流、随机、按权重都是数新连接，不管那台现在有多忙。可这里的连接多半很长
（代理、视频），连接数和负载对不上 —— 一条 4K 视频顶得上几十条闲着的长连接。所以按主机记：

  - active   现在挂在它上面的会话数（TCP 会话和 UDP 会话都算）
  - rate     最近的流量（字节/秒，10 秒时间常数的指数平均），每秒采一次
  - recent   刚挑中它的会话（5 秒时间常数衰减）：挑中的那一刻就记（不等拨通），拨不通再退回去。
             新连接还没跑起量，rate 里看不出来，不算它的话一波新连接会全压到同一台「看起来最闲」的上；
             以前拨通了才记，同时到的一批连接互相看不见（路线图 X5）
  - latency  握手耗时（按时间加权的指数平均，见 observeLatency）：给人看、给「延迟优先」按毫秒门槛比
  - peak     握手耗时的 peak EWMA（lbcore.PeakEWMA）：「自动」的成本用它 —— 慢样本立刻跳上去，之后按时间落回来
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
)

// fxpSlowStartWindow：出口刚恢复后慢慢加量的时长（lbcore 的默认：60 秒，从 10% 起）。
var fxpSlowStartWindow = lbcore.DefaultSlowStart.Window

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
	peak        lbcore.PeakEWMA
	recoveredAt time.Time
}

var fxpHostLoads = struct {
	mu    sync.Mutex
	loads map[string]*fxpHostLoad
}{loads: map[string]*fxpHostLoad{}}

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
	l.peak.Observe(ms, now, 0)
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

// latencyEstimate：量到的握手耗时（指数平均）；还没量过是 0。
func (l *fxpHostLoad) latencyEstimate() time.Duration {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return time.Duration(l.latency * float64(time.Millisecond))
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
	peak      float64
	slowStart float64
}

func (l *fxpHostLoad) snapshot(now time.Time) fxpHostLoadSnapshot {
	return l.snapshotOf(now, fxpSnapshotAll)
}

// 挑选路径上按需取：轮流 / 随机 / 按权重只要慢启动；按访客固定、按负载再要负载；自动 / 延迟优先才要延迟。
// 少取的那几项要算指数衰减，每次挑选、每个候选都算一遍不值得。
const (
	fxpSnapshotShare = iota
	fxpSnapshotLoad
	fxpSnapshotAll
)

func (l *fxpHostLoad) snapshotOf(now time.Time, want int) fxpHostLoadSnapshot {
	if l == nil {
		return fxpHostLoadSnapshot{slowStart: 1}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	snap := fxpHostLoadSnapshot{slowStart: lbcore.DefaultSlowStart.Factor(l.recoveredAt, now)}
	if want >= fxpSnapshotLoad {
		snap.active = float64(l.active.Load())
		snap.rate = l.rate
		if l.recent > 0 {
			snap.recent = l.recent * decay(now.Sub(l.recentAt), fxpLoadRecentTau)
		}
	}
	if want >= fxpSnapshotAll {
		snap.latency = l.latency
		snap.peak = l.peak.Value(now, 0)
	}
	return snap
}

// sampleFXPHostLoads 由端点维护循环每秒调一次：把每台这一秒的字节数折进 rate。
func sampleFXPHostLoads(now time.Time) {
	fxpHostLoads.mu.Lock()
	loads := make([]*fxpHostLoad, 0, len(fxpHostLoads.loads))
	for _, load := range fxpHostLoads.loads {
		loads = append(loads, load)
	}
	fxpHostLoads.mu.Unlock()
	for _, load := range loads {
		load.sample(now)
	}
}

// ---- 分量 ----

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
