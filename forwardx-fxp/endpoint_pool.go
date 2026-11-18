package main

import (
	"encoding/json"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
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
	// 挂过的端点要连续这么多次探测成功才算恢复（回切保护），两次之间隔 fxpRecoverProbeGap。
	fxpRecoverProbes   = 3
	fxpRecoverProbeGap = 5 * time.Second
	// 健康端点探测连续失败这么多次才判死，一次抖动不切线路。
	fxpSuspectProbes = 2
	// 只有 UDP 规则盯着的端点，这么久发一轮 UDP 探活（udp_ping.go）。
	fxpUDPProbeEvery = 5 * time.Second
	// 还不知道对端认不认（UDP 探活包 / TCP 监听）的时候，隔这么久试一次。
	fxpSoftProbeEvery = 30 * time.Second
)

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

	healthy     bool
	failures    int
	successes   int
	suspect     int
	retryAfter  time.Time
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
	// tcpSeen：到它的 TCP 握手成功过（它有 TCP 监听）。tcpProbedAt：上一次派 TCP 探测的时刻。
	tcpSeen     bool
	tcpProbedAt time.Time
	// UDP 直连的探活（watchUDP）：有几个 UDP 运行时在盯、对端的 UDP 端口、回没回过探活包。
	udpWatchers int
	udpPort     int
	udpPongSeen bool
	udpProbing  bool
	udpProbedAt time.Time

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
		state = &fxpEndpointState{id: id, healthy: true}
		fxpEndpoints.states[id] = state
	}
	fxpEndpoints.mu.Unlock()
	fxpEndpoints.once.Do(func() { go fxpEndpointMaintenanceLoop() })
	return state
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
	return s.healthy
}

// tier 给选择器分档：1 健康，2 挂过但冷却到期，3 其余。
func (s *fxpEndpointState) tier(now time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.healthy:
		return 1
	case s.retryAfter.IsZero() || !now.Before(s.retryAfter):
		return 2
	default:
		return 3
	}
}

func (s *fxpEndpointState) markFailure(err error) {
	s.mu.Lock()
	wasHealthy := s.healthy
	s.healthy = false
	s.failures++
	s.successes = 0
	s.suspect = 0
	s.resolveFailed = false
	delay := fallbackRetryDelay(s.failures)
	s.retryAfter = time.Now().Add(delay)
	// 死掉的端点，池里那些连接多半也是死的，别再发给用户。
	idle := s.idle
	s.idle = nil
	index := s.index
	s.mu.Unlock()
	for _, pooled := range idle {
		_ = pooled.conn.Close()
	}
	if wasHealthy {
		// index 是这个端点在出口列表里的位置（Agent 按这行日志记出口事件，格式里要有 index=）。
		log.Printf("exit endpoint unhealthy index=%d endpoint=%s retryIn=%s reason=%v", index, s.label(), delay, err)
	}
}

// markResolveFailure：地址解析不出来。和别的失败一样记，但记下「是解析造成的」—— 只有这种失败，
// 之后解析成功才能把它清掉（resolveSucceeded）。
func (s *fxpEndpointState) markResolveFailure(err error) {
	s.markFailure(err)
	s.mu.Lock()
	if !s.healthy {
		s.resolveFailed = true
	}
	s.mu.Unlock()
}

// resolveSucceeded：地址解析出来了。只说明 DNS 好了，不说明对端活着：上一次失败是解析造成的才恢复。
func (s *fxpEndpointState) resolveSucceeded() {
	s.mu.Lock()
	clear := !s.healthy && s.resolveFailed
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

// noteTCPSeen：到这个端点的 TCP 握手成功过，说明它有 TCP 监听 —— 之后 TCP 探测不通才能算它挂了（见 watchUDP）。
func (s *fxpEndpointState) noteTCPSeen() {
	s.mu.Lock()
	s.tcpSeen = true
	s.mu.Unlock()
}

// markHealthy 是用户流量走通了：立刻算健康。
func (s *fxpEndpointState) markHealthy() {
	s.mu.Lock()
	wasHealthy := s.healthy
	s.healthy = true
	s.failures = 0
	s.successes = 0
	s.suspect = 0
	s.resolveFailed = false
	s.retryAfter = time.Time{}
	s.confirmedAt = time.Now()
	index := s.index
	s.mu.Unlock()
	if !wasHealthy {
		log.Printf("exit endpoint recovered index=%d endpoint=%s", index, s.label())
		// 刚恢复的出口慢慢加量（exit_load.go），别一下子把新连接全塞给它。
		s.hostLoad().markRecovered(time.Now())
	}
}

// confirmedHealthy：这个端点现在健康，而且最近 within 之内有东西证明它活着（探测、握手、预热）。
// UDP 会话据此区分「出口好好的，只是应用协议不回包」和「不知道出口还在不在」（udp_direct.go 的换出口）。
func (s *fxpEndpointState) confirmedHealthy(now time.Time, within time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.healthy && !s.confirmedAt.IsZero() && now.Sub(s.confirmedAt) <= within
}

// probeSucceeded 是后台探测走通了。挂过的端点要连着几次都通才放回去：
// 抖动的节点一通就切回去、再断再切，每次都让一批新连接卡在它身上。
func (s *fxpEndpointState) probeSucceeded() {
	s.mu.Lock()
	s.confirmedAt = time.Now()
	s.suspect = 0
	if s.healthy {
		s.mu.Unlock()
		return
	}
	s.successes++
	if s.successes < fxpRecoverProbes {
		s.retryAfter = time.Now().Add(fxpRecoverProbeGap)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.markHealthy()
}

// probeFailed 是后台探测失败。健康的端点要连着失败几次才判死，一次丢包不切线路。
func (s *fxpEndpointState) probeFailed(err error) {
	s.mu.Lock()
	if s.healthy {
		s.suspect++
		if s.suspect < fxpSuspectProbes {
			s.mu.Unlock()
			return
		}
	}
	s.mu.Unlock()
	s.markFailure(err)
}

func (s *fxpEndpointState) claimProbe(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.healthy || s.probing || s.retryAfter.IsZero() || now.Before(s.retryAfter) {
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

// runProbe 在后台完整握一次手、发一个 probe hello 就关。对端认得 probe，
// 不会去连目标，也不会把它当成出错的会话记日志。
func (s *fxpEndpointState) runProbe(cfg config) {
	s.runTCPProbe(cfg, false)
}

// runTCPProbe：soft 表示「不确定对端有没有 TCP 监听」（只有 UDP 规则在用它、TCP 握手从没成功过）：
// 通了照常算，不通不下结论 —— 只开 UDP 的老出口不能因为 TCP 端口没人听就被判死。
func (s *fxpEndpointState) runTCPProbe(cfg config, soft bool) {
	defer s.releaseProbe()
	started := time.Now()
	conn, sec, err := dialSecureTCPFresh(s.id.host, s.id.port, cfg)
	if err == nil {
		// 探测的握手耗时也算进延迟：闲着的出口没有用户连接，靠它保持样本新鲜。
		s.hostLoad().observeLatency(time.Since(started), time.Now())
		err = writeSecureFramesWithDeadline(sec, fxpProbeHello)
		_ = conn.Close()
	}
	if err != nil {
		if !soft {
			s.probeFailed(err)
		}
		return
	}
	s.noteTCPSeen()
	s.probeSucceeded()
}

/*
watchUDP 让维护循环替 UDP 直连盯着这个端点（路线图 X3）。udpPort 是对端收 UDP 直连的端口。

UDP 直连没有握手，以前也就没有探测：纯 UDP 的规则、中转的 UDP 选择器，出口机没了也照样往上发。现在：

 1. UDP 探活（udp_ping.go）：发一个认证过的探活包，新版出口 / 中转原样回一个。只要回过一次，
    之后就以它为准：连着两轮不回算挂，挂了之后连着三轮回了算恢复（和 TCP 探测同一套计数）。
 2. 对端是老版本，不认识探活包（直接丢，不回）：退回去探它的 TCP 端口。同一条隧道同时开着 TCP 时
    出口上有监听，探得到；TCP 握手从没成功过的（出口只开了 UDP）不下「挂了」的结论，和以前一样没有信号。

同一个端点还有 TCP 规则在用（watch）时只走 TCP 探测：出口机挂了两边都不通，TCP 那套已经在盯。
*/
func (s *fxpEndpointState) watchUDP(cfg config, udpPort int) func() {
	s.mu.Lock()
	s.noteDialConfigLocked(cfg)
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

// runUDPProbe 在后台发一轮 UDP 探活。
func (s *fxpEndpointState) runUDPProbe(cfg config, udpPort int) {
	err := fxpUDPPing(s.id.host, udpPort, cfg)
	s.mu.Lock()
	s.udpProbing = false
	s.udpProbedAt = time.Now()
	answeredBefore := s.udpPongSeen
	if err == nil {
		s.udpPongSeen = true
	}
	s.mu.Unlock()
	if err == nil {
		s.probeSucceeded()
		return
	}
	// 从没回过探活包的（老版本）不下结论，交给 TCP 探测。
	if answeredBefore {
		s.probeFailed(err)
	}
}

// watch 让维护循环主动探测这个端点（有备选时才有意义）。返回的函数撤销。
func (s *fxpEndpointState) watch(cfg config) func() {
	s.mu.Lock()
	s.noteDialConfigLocked(cfg)
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
	if !s.dialCfgKnown || !s.healthy || now.Before(s.fillRetryAt) || s.lastTake.IsZero() || now.Sub(s.lastTake) > fxpPoolActiveWindow {
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
	s.suspect = 0
	s.tcpSeen = true
	if !s.healthy || len(s.idle) >= fxpPoolMaxSize {
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
	// 只有 UDP 规则在盯它：先靠 UDP 探活；对端没回过探活包（老版本）时再加上 TCP 探测，
	// 而且 TCP 握手从没成功过就不拿探测失败下结论（见 watchUDP）。
	udpOnly := s.watchers == 0 && s.udpWatchers > 0
	tcpProbing := s.watchers > 0 || (udpOnly && !s.udpPongSeen)
	softTCP := udpOnly && !s.tcpSeen
	probe := false
	if tcpProbing && s.dialCfgKnown && !s.probing {
		switch {
		case softTCP:
			// 不知道对端有没有 TCP 监听：隔久一点试一次，通了才开始按它判断。
			probe = now.Sub(s.tcpProbedAt) >= fxpSoftProbeEvery
		case !s.healthy:
			probe = !s.retryAfter.IsZero() && !now.Before(s.retryAfter)
		case s.suspect > 0:
			probe = true
		default:
			// 延迟样本旧了也探（路线图 X10）：「多久没确认」会被池子补连接清掉，不能只看它。
			probe = now.Sub(s.confirmedAt) >= fxpHealthyProbeEvery || (s.watchers > 0 && load.latencyProbeDue(now))
		}
	}
	if probe {
		s.probing = true
		s.tcpProbedAt = now
	}
	udpProbe := false
	if udpOnly && s.dialCfgKnown && !s.udpProbing && s.udpPort > 0 {
		switch {
		case !s.udpPongSeen:
			// 还不知道对端认不认探活包：隔一阵问一次。
			udpProbe = now.Sub(s.udpProbedAt) >= fxpSoftProbeEvery
		case !s.healthy:
			udpProbe = !s.retryAfter.IsZero() && !now.Before(s.retryAfter)
		case s.suspect > 0:
			udpProbe = true
		default:
			udpProbe = now.Sub(s.udpProbedAt) >= fxpUDPProbeEvery
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
		go s.runTCPProbe(cfg, softTCP)
	}
	if udpProbe {
		go s.runUDPProbe(cfg, udpPort)
	}
}
