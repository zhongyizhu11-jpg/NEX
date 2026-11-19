package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
下一跳端点的共享状态：健康、预热连接池、主动探测。

以前每个出口选择器各记各的健康，入口组里几十条规则指向同一个出口，就有几十份
互不相通的「它挂没挂」；而且只有用户连接撞上去才知道它挂了。现在同一个进程里
（同一 host:port:key）只有一份状态，所有选择器、连接池、探测都读写它。

连接池里放的是已经握完手、确认过的安全连接。用户连接来了直接取一条写 hello，
这一跳的 TCP 握手和 FXP 握手（两个往返）都提前在后台做完了。
*/

const (
	fxpPoolMinSize = 2
	// 池子的上限。池子按最近 30 秒里最忙的那一秒取了几条来备，16 条在突发时
	// 不够：网页、测速、多条规则共用一个出口时，一秒内几十条新连接很常见，
	// 第 17 条起就得现拨（多一个往返）。抬到 64：只有真被取得这么快才会备这么
	// 多，平时还是按峰值备；空闲连接照旧在 fxpPoolMaxIdleAge 后换新，没人用了
	// （fxpPoolActiveWindow）整个池子清空。对端每个上一跳 IP 给待定连接留了
	// fxpListenerMaxPendingPerIP 条，够十几个端点各备满 64 条。
	fxpPoolMaxSize = 64
	// 池里的连接空闲超过这个时长就换新：对端等 hello 的时长（fxpServerHelloWait）
	// 要比它长，中间设备的空闲超时一般也远大于它。
	fxpPoolMaxIdleAge = 25 * time.Second
	// 这么久没人取过，就不再维持预热连接，让池子自然清空。
	fxpPoolActiveWindow = 5 * time.Minute
	fxpPoolFillRetryMax = 30 * time.Second
	// 对端在认证过的连接上等 hello 的时长。预热连接会空闲地等在这里。
	fxpServerHelloWait = 45 * time.Second

	fxpEndpointTick = time.Second
	// 被盯着的健康端点，这么久没有任何东西证明它活着，就主动探一次。
	fxpHealthyProbeEvery = 10 * time.Second
	// 下面三个是探测参数的默认值，规则带了「检测与切换」时按规则的来（fxpProbeTuning）：
	// 挂过的端点要连续这么多次探测成功才算恢复（回切保护），两次之间隔 fxpRecoverProbeGap；
	// 健康端点探测连续失败 fxpSuspectProbes 次才判死，一次抖动不切线路。
	fxpRecoverProbes   = 3
	fxpRecoverProbeGap = 2 * time.Second
	fxpSuspectProbes   = 2
	// UDP 探活（udp_ping.go）多久一轮：端点上挂着 UDP 会话时 fxpUDPProbeActiveEvery，闲着的 fxpUDPProbeEvery。
	fxpUDPProbeEvery       = 5 * time.Second
	fxpUDPProbeActiveEvery = time.Second
	// 对端从没回过 UDP 探活包（版本过旧，或者 UDP 一直不通）时，隔这么久再问一次。
	fxpUDPUnverifiedProbeEvery = 30 * time.Second
	// 问过这么多轮都没回过，就当它「没验证过」：打一条日志、报给面板，UDP 新会话优先给验证过的出口。
	fxpUDPUnverifiedRounds = 2
)

/*
fxpProbeTuning：出口本身通不通的探测参数。默认值见上面的常量；规则带了「检测与切换」（balanceDetectConfig，
面板的灵敏 / 均衡 / 稳定就是它的几组取值）时，用规则的「几次不通算坏」「恢复要连续通几次」「多久探一次」。
端点状态是整个进程共享的，几条规则给的不一样时以最后登记的为准（同一条隧道上的规则用的是同一组）。
*/
type fxpProbeTuning struct {
	fail       int
	recover    int
	recoverGap time.Duration
}

func defaultFXPProbeTuning() fxpProbeTuning {
	return fxpProbeTuning{fail: fxpSuspectProbes, recover: fxpRecoverProbes, recoverGap: fxpRecoverProbeGap}
}

func fxpProbeTuningFor(cfg config) fxpProbeTuning {
	tuning := defaultFXPProbeTuning()
	if cfg.BalanceDetect == nil {
		return tuning
	}
	detect := resolveBalanceDetect(cfg.BalanceDetect)
	tuning.fail, tuning.recover, tuning.recoverGap = detect.fail, detect.recover, detect.interval
	return tuning
}

/*
出口本身来回断的抖动抑制（lbcore.FlapDamper，和线路组、「出口到目标」是同一套计数）：一小时里断了 4 次起，
下一次恢复要从断开算起坏满 30 秒才算，每多断一次翻一倍，最多 5 分钟。恢复本身很快（连着 3 次探通、间隔 2 秒），
不压的话一台每隔十几秒断一下的出口会被反复放回来，每次都带走一批新连接。别的出口都连不上时不受它限制
（lbcore.Candidates 的恐慌：连不上的也会被用）。
*/
var fxpEndpointFlapPolicy = lbcore.FlapPolicy{Window: time.Hour, Threshold: 4, Base: 30 * time.Second, Max: 5 * time.Minute}

/*
sideHealth：出口一侧判好判坏的账。TCP 那一侧（握手、后台探测、用户连接）和 UDP 那一侧（UDP 探活）各一份，各判各的。

  - 健康时连着失败 tuning.fail 次（suspect 数到够）才判坏；fail 是当场判坏（用户连接握手失败）。
  - 判坏之后每隔 tuning.recoverGap 再试（retryAfter），连着成功 tuning.recover 次、而且抖动抑制不压着才恢复。
  - 抖动抑制（flap）也各记各的：以前两侧的中断记在同一份账上，一次真正的断开（TCP、UDP 一起断）记两次，
    断两次就凑够「一小时 4 次」，之后每次恢复都要多等 30 秒起（F3）。
*/
type sideHealth struct {
	down bool
	// failures：判坏之后又失败了几次；successes：判坏之后连着成功了几次；suspect：健康时连着失败了几次。
	failures   int
	successes  int
	suspect    int
	downAt     time.Time
	retryAfter time.Time
	flap       lbcore.FlapDamper
}

func newSideHealth() sideHealth {
	return sideHealth{flap: lbcore.FlapDamper{Policy: fxpEndpointFlapPolicy}}
}

// sideEvent：observe / fail 这一下有没有让这一侧变了状态。
type sideEvent uint8

const (
	sideUnchanged sideEvent = iota
	sideWentDown
	sideRecovered
)

// observe 记一次探测的结果（ok = 通了）。
func (h *sideHealth) observe(ok bool, now time.Time, tuning fxpProbeTuning) sideEvent {
	if ok {
		h.suspect = 0
		if !h.down {
			return sideUnchanged
		}
		h.successes++
		if h.successes >= tuning.recover && !h.flap.Holding(now, h.downAt, 0, false) {
			h.up()
			return sideRecovered
		}
		h.retryAfter = now.Add(tuning.recoverGap)
		return sideUnchanged
	}
	if !h.down {
		h.suspect++
		if h.suspect < tuning.fail {
			return sideUnchanged
		}
	}
	return h.fail(now, tuning)
}

/*
fail：当场判坏（用户连接握手失败；或者 observe 数够了可疑）。

多久之后再探：固定的 recoverGap（默认 2 秒），不再越探越慢（阶段 2）。以前每多失败一次翻一倍、最长 2 分钟，
出口恢复之后要等退避到期才探第一下，实验室里恢复了 20 秒的出口 9 条新连接一条都没分到。
当初放慢是因为探测压在用户连接上、一次要等满握手超时；现在探测都在后台协程里，等多久只是那个协程的事。
来回断的出口由抖动抑制管（fxpEndpointFlapPolicy），不靠探得慢。
*/
func (h *sideHealth) fail(now time.Time, tuning fxpProbeTuning) sideEvent {
	wasUp := !h.down
	h.down = true
	h.failures++
	h.successes = 0
	h.suspect = 0
	h.retryAfter = now.Add(tuning.recoverGap)
	if !wasUp {
		return sideUnchanged
	}
	h.downAt = now
	h.flap.Note(now)
	return sideWentDown
}

// up：恢复（探测连着通够了，或者用户流量走通了 —— 后者不受抖动抑制限制，那是真凭实据）。
func (h *sideHealth) up() {
	h.down = false
	h.failures = 0
	h.successes = 0
	h.suspect = 0
	h.retryAfter = time.Time{}
}

// cooling：判坏了，而且还没到下一次该试的时候。
func (h *sideHealth) cooling(now time.Time) bool {
	return h.down && !h.retryAfter.IsZero() && now.Before(h.retryAfter)
}

type fxpEndpointID struct {
	host string
	port int
	key  string
	// lossTolerant：走抗丢包承载。同一个出口的 TCP 连接和抗丢包连接各有各的池和健康。
	lossTolerant bool
	// transport：V3 外层选项（见 exitEndpoint.transport）。
	transport string
}

type pooledSecureConn struct {
	conn      net.Conn
	sec       *secureConn
	createdAt time.Time
}

type fxpEndpointState struct {
	id fxpEndpointID

	mu sync.Mutex
	// dialCfg 带着握手要用的隧道号和密钥，第一次有人拿着配置来用它时记下。
	dialCfg      config
	dialCfgKnown bool

	// tcp：TCP 那一侧的好坏（握手、后台探测、用户连接，sideHealth）。
	tcp         sideHealth
	probing     bool
	confirmedAt time.Time
	watchers    int
	// resolveFailed：上一次失败是「地址解析不出来」造成的（只有这种失败，解析成功才清得掉）。
	resolveFailed bool
	// index：这个端点在出口列表里排第几（打日志用）。
	index      int
	indexKnown bool
	// load：这个端点的负载记在哪一份上（exit_load.go）。
	load *fxpHostLoad
	// tuning：探测参数（fxpProbeTuning），两侧共用。
	tuning fxpProbeTuning
	/*
		UDP 那一侧（阶段 2 起单独记）：有几个 UDP 运行时在盯、对端的 UDP 端口、挂着几条 UDP 会话。
		udpPongSeen 对端回过探活包 —— 回过之后 UDP 通不通就以探活为准（udp，sideHealth），和 TCP 那一侧各判各的：
		只有 UDP 被拦的出口，TCP 照常用、UDP 新会话不给它；反过来也一样。udpConfirmedAt / udpMissAt 是最近一次
		收到应答 / 一轮没等到应答的时刻（UDP 会话据此判断「我没回包」是出口的事还是应用协议本来就单向）。
	*/
	udp            sideHealth
	udpWatchers    int
	udpPort        int
	udpSessions    int
	udpPongSeen    bool
	udpProbing     bool
	udpProbedAt    time.Time
	udpRounds      int
	udpConfirmedAt time.Time
	udpMissAt      time.Time
	udpUnverified  bool

	idle         []pooledSecureConn
	dialing      int
	lastTake     time.Time
	takeCounts   [30]int
	takeSeconds  [30]int64
	fillFailures int
	fillRetryAt  time.Time
}

var fxpEndpoints = struct {
	mu     sync.Mutex
	states map[fxpEndpointID]*fxpEndpointState
	once   sync.Once
}{states: map[fxpEndpointID]*fxpEndpointState{}}

var fxpProbeHello, _ = json.Marshal(helloFrame{Network: "probe"})

func fxpEndpointStateFor(endpoint exitEndpoint) *fxpEndpointState {
	id := fxpEndpointID{host: strings.TrimSpace(endpoint.Host), port: endpoint.Port, key: endpoint.Key, lossTolerant: endpoint.lossTolerant, transport: endpoint.transport}
	fxpEndpoints.mu.Lock()
	state := fxpEndpoints.states[id]
	if state == nil {
		state = newFXPEndpointState(id)
		fxpEndpoints.states[id] = state
	}
	fxpEndpoints.mu.Unlock()
	fxpEndpoints.once.Do(func() { go fxpEndpointMaintenanceLoop() })
	return state
}

func newFXPEndpointState(id fxpEndpointID) *fxpEndpointState {
	return &fxpEndpointState{id: id, tcp: newSideHealth(), udp: newSideHealth(), tuning: defaultFXPProbeTuning()}
}

// resetFXPEndpointRegistry 丢掉所有端点状态并关掉池里的连接。只给测试用：
// 状态是整个进程共享的，测试之间不清掉就会互相串。
func resetFXPEndpointRegistry() {
	resetFXPHostLoads()
	fxpEndpoints.mu.Lock()
	states := fxpEndpoints.states
	fxpEndpoints.states = map[fxpEndpointID]*fxpEndpointState{}
	fxpEndpoints.mu.Unlock()
	for _, state := range states {
		state.mu.Lock()
		idle := state.idle
		state.idle = nil
		state.lastTake = time.Time{}
		state.watchers = 0
		state.mu.Unlock()
		for _, pooled := range idle {
			_ = pooled.conn.Close()
		}
	}
}

func (s *fxpEndpointState) noteDialConfigLocked(cfg config) {
	if s.dialCfgKnown {
		return
	}
	s.dialCfg = cfg
	s.dialCfg.Key = s.id.key
	// 预热、探测拨的承载方式按端点自己的身份，不按头一个来取连接的配置。
	s.dialCfg.LossTolerant = s.id.lossTolerant
	s.dialCfgKnown = true
}

func (s *fxpEndpointState) label() string {
	return net.JoinHostPort(s.id.host, strconv.Itoa(s.id.port))
}

// ---- 健康 ----

func (s *fxpEndpointState) isHealthy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.tcp.down
}

// markResolveFailure：地址解析不出来。和别的失败一样记，但记下「是解析造成的」—— 只有这种失败，
// 之后解析成功才能把它清掉（resolveSucceeded）。
func (s *fxpEndpointState) markResolveFailure(err error) {
	s.markFailure(err)
	s.mu.Lock()
	if s.tcp.down {
		s.resolveFailed = true
	}
	s.mu.Unlock()
}

// resolveSucceeded：地址解析出来了。只说明 DNS 好了，不说明对端活着：上一次失败是解析造成的才恢复。
func (s *fxpEndpointState) resolveSucceeded() {
	s.mu.Lock()
	clear := s.tcp.down && s.resolveFailed
	s.mu.Unlock()
	if clear {
		s.markHealthy()
	}
}

// noteIndex 记下这个端点在出口列表里排第几（只用来打日志；几条规则里位置不同时以第一个登记的为准）。
func (s *fxpEndpointState) noteIndex(index int) {
	s.mu.Lock()
	if !s.indexKnown {
		s.index = index
		s.indexKnown = true
	}
	s.mu.Unlock()
}

// bindLoad 记下这个端点的负载记在哪一份上（exit_load.go 的 endpointLoadKey），探测量到的延迟、恢复后的慢启动都记给它。
func (s *fxpEndpointState) bindLoad(load *fxpHostLoad) {
	s.mu.Lock()
	s.load = load
	s.mu.Unlock()
}

func (s *fxpEndpointState) hostLoad() *fxpHostLoad {
	s.mu.Lock()
	load := s.load
	s.mu.Unlock()
	if load == nil {
		load = fxpHostLoadFor(endpointLoadKey(exitEndpoint{Host: s.id.host, Port: s.id.port}))
	}
	return load
}

// markHealthy 是用户流量走通了：立刻算健康。
func (s *fxpEndpointState) markHealthy() {
	s.mu.Lock()
	event := sideUnchanged
	if s.tcp.down {
		event = sideRecovered
	}
	s.tcp.up()
	s.confirmedAt = time.Now()
	s.noteTCPEventLocked(event, nil)
}

// confirmedHealthy：这个端点现在健康，而且最近 within 之内有东西证明它活着（探测、握手、预热）。
// UDP 会话据此区分「出口好好的，只是应用协议不回包」和「不知道出口还在不在」（udp_direct.go 的换出口）。
func (s *fxpEndpointState) confirmedHealthy(now time.Time, within time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.tcp.down && !s.confirmedAt.IsZero() && now.Sub(s.confirmedAt) <= within
}

func (s *fxpEndpointState) claimProbe(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.tcp.down || s.probing || s.tcp.retryAfter.IsZero() || now.Before(s.tcp.retryAfter) {
		return false
	}
	s.probing = true
	return true
}

func (s *fxpEndpointState) releaseProbe() {
	s.mu.Lock()
	s.probing = false
	s.mu.Unlock()
}

// prewarm 让池子现在就开始预热，第一条用户连接不必自己握手。
func (s *fxpEndpointState) prewarm(cfg config) {
	s.mu.Lock()
	s.noteDialConfigLocked(cfg)
	if s.lastTake.IsZero() {
		s.lastTake = time.Now()
	}
	s.mu.Unlock()
	s.ensureFill()
}

// ---- 连接池 ----

// take 取一条预热好的连接；没有就返回 false，并让池子按需补充。
func (s *fxpEndpointState) take(cfg config) (net.Conn, *secureConn, bool) {
	now := time.Now()
	s.mu.Lock()
	s.noteDialConfigLocked(cfg)
	s.recordTakeLocked(now)
	for len(s.idle) > 0 {
		pooled := s.idle[0]
		copy(s.idle, s.idle[1:])
		s.idle[len(s.idle)-1] = pooledSecureConn{}
		s.idle = s.idle[:len(s.idle)-1]
		if now.Sub(pooled.createdAt) > fxpPoolMaxIdleAge {
			_ = pooled.conn.Close()
			continue
		}
		s.mu.Unlock()
		if pooledSecureConnAlive(pooled.conn) {
			s.ensureFill()
			return pooled.conn, pooled.sec, true
		}
		_ = pooled.conn.Close()
		s.mu.Lock()
	}
	s.mu.Unlock()
	s.ensureFill()
	return nil, nil, false
}

// markUsed 记一次「有人用了这个端点」，不从池里取连接（V3 多路复用时走会话池），
// 让预热和维护循环知道它是活跃的。
func (s *fxpEndpointState) markUsed(cfg config) {
	s.mu.Lock()
	s.noteDialConfigLocked(cfg)
	s.recordTakeLocked(time.Now())
	s.mu.Unlock()
	s.ensureFill()
}

// pooledSecureConnAlive：抗丢包承载没有套接字可偷看，问它自己（对端复位、关了、失联都知道）。
func pooledSecureConnAlive(conn net.Conn) bool {
	if carrier, ok := conn.(*lossCarrierConn); ok {
		return carrier.alive()
	}
	return pooledConnAlive(conn)
}

func (s *fxpEndpointState) recordTakeLocked(now time.Time) {
	second := now.Unix()
	slot := int(second % int64(len(s.takeSeconds)))
	if s.takeSeconds[slot] != second {
		s.takeSeconds[slot] = second
		s.takeCounts[slot] = 0
	}
	s.takeCounts[slot]++
	s.lastTake = now
}

// poolTargetLocked：最近 30 秒里最忙的那一秒取了几条，就备几条（再多一条），
// 夹在 [fxpPoolMinSize, fxpPoolMaxSize] 之间。
func (s *fxpEndpointState) poolTargetLocked(now time.Time) int {
	second := now.Unix()
	peak := 0
	for i, at := range s.takeSeconds {
		if at > second-int64(len(s.takeSeconds)) && s.takeCounts[i] > peak {
			peak = s.takeCounts[i]
		}
	}
	target := peak + 1
	if target < fxpPoolMinSize {
		target = fxpPoolMinSize
	}
	if target > fxpPoolMaxSize {
		target = fxpPoolMaxSize
	}
	return target
}

func (s *fxpEndpointState) ensureFill() {
	now := time.Now()
	s.mu.Lock()
	if !s.dialCfgKnown || s.tcp.down || now.Before(s.fillRetryAt) || s.lastTake.IsZero() || now.Sub(s.lastTake) > fxpPoolActiveWindow {
		s.mu.Unlock()
		return
	}
	// V3 多路复用时会话池就是连接池（v3SessionPool）：不备空闲连接，备一条认证好的会话。
	if v3MuxEnabled(s.dialCfg) {
		cfg := s.dialCfg
		s.mu.Unlock()
		v3Outbound.warm(s.id.host, s.id.port, cfg)
		return
	}
	need := s.poolTargetLocked(now) - len(s.idle) - s.dialing
	if need <= 0 {
		s.mu.Unlock()
		return
	}
	s.dialing += need
	cfg := s.dialCfg
	s.mu.Unlock()
	for i := 0; i < need; i++ {
		go s.fillOne(cfg)
	}
}

func (s *fxpEndpointState) fillOne(cfg config) {
	started := time.Now()
	conn, sec, err := dialSecureTCPFresh(s.id.host, s.id.port, cfg)
	now := time.Now()
	if err == nil {
		// 补池子的握手也是一次延迟样本（路线图 X10）：池子被取得勤的时候（比如一直在探目标），
		// 「多久没确认」的计时一直被补连接清掉，专门量延迟的探测永远轮不到，延迟就停在旧值上。
		s.hostLoad().observeLatency(now.Sub(started), now)
	}
	s.mu.Lock()
	s.dialing--
	if err != nil {
		s.fillFailures++
		backoff := 500 * time.Millisecond << minInt(s.fillFailures, 6)
		if backoff > fxpPoolFillRetryMax {
			backoff = fxpPoolFillRetryMax
		}
		s.fillRetryAt = now.Add(backoff)
		s.mu.Unlock()
		// 预热失败只退避，不改健康：整条隧道刚部署时入口常比出口先起来，
		// 拿它判死会让首选白白让出十几秒。健康只看主动探测和真实流量。
		return
	}
	s.fillFailures = 0
	s.fillRetryAt = time.Time{}
	s.confirmedAt = now
	s.tcp.suspect = 0
	if s.tcp.down || len(s.idle) >= fxpPoolMaxSize {
		s.mu.Unlock()
		_ = conn.Close()
		return
	}
	s.idle = append(s.idle, pooledSecureConn{conn: conn, sec: sec, createdAt: now})
	s.mu.Unlock()
}

// ---- 维护循环 ----

func fxpEndpointMaintenanceLoop() {
	ticker := time.NewTicker(fxpEndpointTick)
	defer ticker.Stop()
	for now := range ticker.C {
		sampleFXPHostLoads(now)
		fxpEndpoints.mu.Lock()
		states := make([]*fxpEndpointState, 0, len(fxpEndpoints.states))
		for _, state := range fxpEndpoints.states {
			states = append(states, state)
		}
		fxpEndpoints.mu.Unlock()
		for _, state := range states {
			state.maintain(now)
		}
		// 负载均衡的「出口连得上目标吗」：按各条规则的「多久探一次」派探测（target_health.go）。
		maintainTargetProbes(now)
	}
}

func (s *fxpEndpointState) maintain(now time.Time) {
	var expired []pooledSecureConn
	s.mu.Lock()
	active := !s.lastTake.IsZero() && now.Sub(s.lastTake) <= fxpPoolActiveWindow
	kept := s.idle[:0]
	for _, pooled := range s.idle {
		if !active || now.Sub(pooled.createdAt) > fxpPoolMaxIdleAge {
			expired = append(expired, pooled)
			continue
		}
		kept = append(kept, pooled)
	}
	for i := len(kept); i < len(s.idle); i++ {
		s.idle[i] = pooledSecureConn{}
	}
	s.idle = kept
	load := s.load
	// TCP 那一侧：有 TCP 运行时在盯才探。
	probe := false
	if s.watchers > 0 && s.dialCfgKnown && !s.probing {
		switch {
		case s.tcp.down:
			probe = !s.tcp.retryAfter.IsZero() && !now.Before(s.tcp.retryAfter)
		case s.tcp.suspect > 0:
			probe = true
		default:
			// 延迟样本旧了也探（路线图 X10）：「多久没确认」会被池子补连接清掉，不能只看它。
			probe = now.Sub(s.confirmedAt) >= fxpHealthyProbeEvery || load.latencyProbeDue(now)
		}
	}
	if probe {
		s.probing = true
	}
	// UDP 那一侧：有 UDP 运行时在盯就探，和 TCP 各探各的（见 watchUDP）。
	udpProbe := false
	if s.udpWatchers > 0 && s.dialCfgKnown && !s.udpProbing && s.udpPort > 0 {
		since := now.Sub(s.udpProbedAt)
		switch {
		case !s.udpPongSeen:
			// 对端还没回过探活包：头几轮照常问，一直不回就隔久一点再问（它升级了、UDP 放行了就能发现）。
			udpProbe = s.udpProbedAt.IsZero() || since >= fxpUDPUnverifiedProbeEvery || (s.udpRounds < fxpUDPUnverifiedRounds && since >= s.tuning.recoverGap)
		case s.udp.down:
			udpProbe = !now.Before(s.udp.retryAfter)
		case s.udp.suspect > 0:
			udpProbe = true
		case s.udpSessions > 0:
			udpProbe = since >= fxpUDPProbeActiveEvery
		default:
			udpProbe = since >= fxpUDPProbeEvery
		}
	}
	if udpProbe {
		s.udpProbing = true
	}
	udpPort := s.udpPort
	cfg := s.dialCfg
	s.mu.Unlock()
	for _, pooled := range expired {
		_ = pooled.conn.Close()
	}
	if active {
		s.ensureFill()
	}
	if probe {
		go s.runProbe(cfg)
	}
	if udpProbe {
		go s.runUDPProbe(cfg, udpPort)
	}
}

// ---- 健康：TCP 那一侧 ----

/*
reachable：这个端点此刻连不连得上（挑出口用）。cooling：连不上，而且还在等下一次探测（刚判的；主备全挂时
先试等够了的，见 lbcore.First）。

udp 为 true 是给 UDP 会话问的：对端回过 UDP 探活包，就以探活为准（udpDown）；从没回过（版本过旧，或者 UDP 一直
不通）就没有 UDP 自己的结论，按 TCP 那一侧的来 —— 没有信号时不乱判，但会被标成「没验证过」（udpUnverifiedNow）。
*/
func (s *fxpEndpointState) reachable(udp bool, now time.Time) (ok bool, cooling bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	side := &s.tcp
	if udp && s.udpPongSeen {
		side = &s.udp
	}
	return !side.down, side.cooling(now)
}

func (s *fxpEndpointState) markFailure(err error) {
	s.mu.Lock()
	// 不是解析造成的失败：之后解析成功也清不掉它（markResolveFailure 在这之后再标上）。
	s.resolveFailed = false
	s.noteTCPEventLocked(s.tcp.fail(time.Now(), s.tuning), err)
}

/*
noteTCPEventLocked：TCP 那一侧刚变坏 / 刚恢复时的善后。调用方持锁，这里放锁。

变坏：池里那些连接多半也是死的，关掉，别再发给用户。恢复：刚恢复的出口慢慢加量（exit_load.go），别一下子把新连接
全塞给它。两种都打一行日志（Agent 按它记出口事件，格式串抄在 agent/testdata/fxp_endpoint_log_sample.txt，改了要一起改）。
*/
func (s *fxpEndpointState) noteTCPEventLocked(event sideEvent, err error) {
	var idle []pooledSecureConn
	switch event {
	case sideWentDown:
		idle = s.idle
		s.idle = nil
	case sideRecovered:
		s.resolveFailed = false
	}
	index, delay := s.index, s.tuning.recoverGap
	s.mu.Unlock()
	for _, pooled := range idle {
		_ = pooled.conn.Close()
	}
	// index= 是这个端点在出口列表里排第几，给人看的；Agent 的正则有没有它都认。
	switch event {
	case sideWentDown:
		log.Printf("exit endpoint unhealthy index=%d endpoint=%s retryIn=%s reason=%v", index, s.label(), delay, err)
	case sideRecovered:
		log.Printf("exit endpoint recovered index=%d endpoint=%s", index, s.label())
		s.hostLoad().markRecovered(time.Now())
	}
}

// probeSucceeded 是后台探测走通了。挂过的端点要连着几次都通才放回去：
// 抖动的节点一通就切回去、再断再切，每次都让一批新连接卡在它身上。来回断的还要坏满抖动抑制要求的时长。
func (s *fxpEndpointState) probeSucceeded() {
	now := time.Now()
	s.mu.Lock()
	s.confirmedAt = now
	s.noteTCPEventLocked(s.tcp.observe(true, now, s.tuning), nil)
}

// probeFailed 是后台探测失败（或者等不到出口回结果）。健康的端点要连着失败几次才判死，一次丢包不切线路。
func (s *fxpEndpointState) probeFailed(err error) {
	s.mu.Lock()
	event := s.tcp.observe(false, time.Now(), s.tuning)
	if s.tcp.down {
		s.resolveFailed = false
	}
	s.noteTCPEventLocked(event, err)
}

// runProbe 在后台完整握一次手、发一个 probe hello 就关。对端认得 probe，
// 不会去连目标，也不会把它当成出错的会话记日志。
//
// 端点还连不上、而且有人盯着它时，这个协程接着探：每隔 recoverGap 发起一次（从上一次发起算，探测本身花掉的时间
// 不另外等），直到它恢复或者没人盯了。不交回维护循环去等下一个 1 秒的节拍 —— 那样三次探测之间各多等不到一秒，
// 出口恢复到重新接连接要 9 秒上下，贴着 10 秒的线。
func (s *fxpEndpointState) runProbe(cfg config) {
	defer s.releaseProbe()
	for {
		started := time.Now()
		conn, sec, err := dialEndpointProbe(s.id.host, s.id.port, cfg)
		if err == nil {
			// 探测的握手耗时也算进延迟：闲着的出口没有用户连接，靠它保持样本新鲜。
			s.hostLoad().observeLatency(time.Since(started), time.Now())
			err = writeSecureFramesWithDeadline(sec, fxpProbeHello)
			_ = conn.Close()
		}
		if err != nil {
			s.probeFailed(err)
		} else {
			s.probeSucceeded()
		}
		s.mu.Lock()
		again, gap := s.tcp.down && s.watchers > 0, s.tuning.recoverGap
		s.mu.Unlock()
		if !again {
			return
		}
		if wait := gap - time.Since(started); wait > 0 {
			time.Sleep(wait)
		}
	}
}

/*
dialEndpointProbe：探测用的拨号。和 dialSecureTCPFresh 一样现拨、握完手，只是握手确认最多等 fxpPipelinedAckFast
（4 秒），不等满 10 秒：对端接了连接却不回话（进程卡住、回程黑洞）时，一次探测卡 10 秒，出口恢复的那一刻
正好有一次探测卡在半路的话，要多等这 10 秒才轮到下一次。V3 的外层 + 内层握手也一样最多等 fxpPipelinedAckFast。
*/
func dialEndpointProbe(host string, port int, cfg config) (net.Conn, *secureConn, error) {
	if v3Enabled(cfg) {
		cfg.v3HandshakeTimeout = fxpPipelinedAckFast
		return dialV3Fresh(host, port, cfg)
	}
	conn, err := dialNextHop(host, port, secureDialTimeout(cfg), cfg)
	if err != nil {
		return nil, nil, err
	}
	sec, err := newPipelinedClientSecureConn(conn, cfg, fxpWireCurrent)
	if err == nil {
		sec.ackTimeout = fxpPipelinedAckFast
		err = sec.consumeHandshakeAck()
	}
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	return conn, sec, nil
}

// watch 让维护循环主动探测这个端点的 TCP 那一侧（有备选时才有意义）。返回的函数撤销。
func (s *fxpEndpointState) watch(cfg config) func() {
	s.mu.Lock()
	s.noteDialConfigLocked(cfg)
	// 被盯着的端点都有备选：预热的 V3 物理会话握手也只等 fxpPipelinedAckFast（用户连接可能正等着它）。
	s.dialCfg.v3HandshakeTimeout = fxpPipelinedAckFast
	s.tuning = fxpProbeTuningFor(cfg)
	s.watchers++
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			if s.watchers > 0 {
				s.watchers--
			}
			s.mu.Unlock()
		})
	}
}

// ---- 健康：UDP 那一侧 ----

/*
watchUDP 让维护循环替 UDP 直连盯着这个端点（路线图 X3，阶段 2 改成和 TCP 各判各的）。udpPort 是对端收 UDP 直连的端口。

UDP 直连没有握手，靠 UDP 探活（udp_ping.go）：发一个认证过的探活包，出口 / 中转原样回一个。

  - 多久一轮：端点上挂着 UDP 会话时每秒一轮，闲着的每 5 秒一轮。一轮最多发 3 个包、等 1 秒，丢一两个包不算没回。
  - 连着 2 轮没回（「几次不通算坏」）判成 UDP 不通；第一轮没回就紧接着发第二轮，不等下一个节拍 ——
    挂着会话的出口从断掉到判坏约 3 秒，会话当场换出口（udp_direct.go 的 repickReason）。
  - 判坏之后每 2 秒一轮，连着 3 轮回了才算恢复（来回断的另有抖动抑制）；恢复后 60 秒慢慢加量。
  - 和 TCP 那一侧各判各的：同一条规则 TCP+UDP 都开时，只有 UDP 被拦的出口 TCP 照常用、UDP 新会话不给它
    （以前这种规则只跑 TCP 探测，UDP 单独被封发现不了）。

对端从没回过探活包（版本过旧 —— 这一版要求各台都升级；或者 UDP 从一开始就不通）：没有信号，不判它坏，
UDP 按 TCP 那一侧的结论走；问过两轮还不回就打一条日志、报给面板（「对端版本过旧」），UDP 新会话优先给验证过的出口。
以前这种情况悄悄退回去探它的 TCP 端口，看不出来。
*/
func (s *fxpEndpointState) watchUDP(cfg config, udpPort int) func() {
	s.mu.Lock()
	s.noteDialConfigLocked(cfg)
	s.tuning = fxpProbeTuningFor(cfg)
	s.udpWatchers++
	if udpPort > 0 {
		s.udpPort = udpPort
	}
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			if s.udpWatchers > 0 {
				s.udpWatchers--
			}
			s.mu.Unlock()
		})
	}
}

// udpSessionOpened / udpSessionClosed：一条 UDP 会话挂到这个端点上 / 结束了。挂着会话的端点探得勤。
func (s *fxpEndpointState) udpSessionOpened() {
	s.mu.Lock()
	s.udpSessions++
	s.mu.Unlock()
}

func (s *fxpEndpointState) udpSessionClosed() {
	s.mu.Lock()
	if s.udpSessions > 0 {
		s.udpSessions--
	}
	s.mu.Unlock()
}

// udpVerifiedUp：对端回过 UDP 探活包，而且 UDP 那一侧此刻是通的。
func (s *fxpEndpointState) udpVerifiedUp() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.udpPongSeen && !s.udp.down
}

// udpUnverifiedNow：有 UDP 规则在用这个端点，可它从没回过 UDP 探活包（问过至少两轮）。
func (s *fxpEndpointState) udpUnverifiedNow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.udpWatchers > 0 && s.udpUnverified
}

/*
udpSilenceConfirmed：一条 UDP 会话从 since 起一直没收到回包 —— 这是不是出口的事？

是：对端会回探活包，可是 since 之后有一轮探活没等到应答，而且 since 之后一次应答都没收到。
不是：since 之后收到过应答（出口好好的，是应用协议本来就单向，不能因为没回包换出口），或者还没来得及探。
verified 为 false 表示对端从没回过探活包，这个问题答不了。
*/
func (s *fxpEndpointState) udpSilenceConfirmed(since time.Time) (confirmed bool, verified bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.udpPongSeen {
		return false, false
	}
	return s.udpMissAt.After(since) && !s.udpConfirmedAt.After(since), true
}

// runUDPProbe 在后台发 UDP 探活：一轮没回而且还没到判坏的次数，紧接着再发一轮；判坏之后（还有人盯着时）
// 每隔 recoverGap 发起一轮，直到恢复 —— 和 runProbe 一样不交回维护循环去等节拍。
func (s *fxpEndpointState) runUDPProbe(cfg config, udpPort int) {
	for {
		started := time.Now()
		err := fxpUDPPing(s.id.host, udpPort, cfg)
		again, gap := s.udpProbeResult(err)
		if !again {
			return
		}
		if wait := gap - time.Since(started); wait > 0 {
			time.Sleep(wait)
		}
	}
}

// udpProbeResult 记一轮 UDP 探活的结果，返回要不要这个协程接着探、以及两轮发起之间隔多久（0 = 紧接着）。
func (s *fxpEndpointState) udpProbeResult(err error) (again bool, gap time.Duration) {
	now := time.Now()
	var logLine string
	recovered := false
	s.mu.Lock()
	s.udpProbedAt = now
	s.udpRounds++
	switch {
	case err == nil:
		if s.udpUnverified {
			logLine = fmt.Sprintf("exit endpoint answers udp pings now index=%d endpoint=%s", s.index, s.label())
		}
		s.udpPongSeen, s.udpUnverified = true, false
		s.udpConfirmedAt = now
		if s.udp.observe(true, now, s.tuning) == sideRecovered {
			recovered = true
			logLine = fmt.Sprintf("exit endpoint udp recovered index=%d endpoint=%s", s.index, s.label())
		}
	case !s.udpPongSeen:
		// 从没回过：没有结论。问够了轮数就标成「没验证过」，说一次。
		if s.udpRounds >= fxpUDPUnverifiedRounds && !s.udpUnverified {
			s.udpUnverified = true
			logLine = fmt.Sprintf("exit endpoint never answered a udp ping index=%d endpoint=%s: peer runs an outdated FXP or UDP is blocked; UDP health follows the TCP probe", s.index, s.label())
		}
	default:
		s.udpMissAt = now
		if s.udp.observe(false, now, s.tuning) == sideWentDown {
			logLine = fmt.Sprintf("exit endpoint udp unreachable index=%d endpoint=%s reason=%v", s.index, s.label(), err)
		} else if !s.udp.down {
			// 一轮没回、还没到判坏的次数：紧接着再发一轮。
			again = true
		}
	}
	if !again && s.udp.down && s.udpWatchers > 0 {
		// 还不通、还有人盯着：这个协程接着探。
		again, gap = true, s.tuning.recoverGap
	}
	if !again {
		s.udpProbing = false
	}
	s.mu.Unlock()
	if logLine != "" {
		log.Print(logLine)
	}
	if recovered {
		// 刚恢复的出口慢慢加量（exit_load.go）。
		s.hostLoad().markRecovered(now)
	}
	return again, gap
}

// udpReportState：报给面板的 UDP 那一侧状态（没有 UDP 规则在用它时是空的）。
func (s *fxpEndpointState) udpReportState() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.udpWatchers == 0:
		return ""
	case s.udpUnverified:
		return "unverified"
	case !s.udpPongSeen:
		return ""
	case s.udp.down:
		return "down"
	}
	return "ok"
}
