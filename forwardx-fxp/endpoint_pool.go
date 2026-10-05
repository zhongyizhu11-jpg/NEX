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
)

type fxpEndpointID struct {
	host string
	port int
	key  string
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
	id := fxpEndpointID{host: strings.TrimSpace(endpoint.Host), port: endpoint.Port, key: endpoint.Key}
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
	delay := fallbackRetryDelay(s.failures)
	s.retryAfter = time.Now().Add(delay)
	// 死掉的端点，池里那些连接多半也是死的，别再发给用户。
	idle := s.idle
	s.idle = nil
	s.mu.Unlock()
	for _, pooled := range idle {
		_ = pooled.conn.Close()
	}
	if wasHealthy {
		log.Printf("exit endpoint unhealthy endpoint=%s retryIn=%s reason=%v", s.label(), delay, err)
	}
}

// markHealthy 是用户流量走通了：立刻算健康。
func (s *fxpEndpointState) markHealthy() {
	s.mu.Lock()
	wasHealthy := s.healthy
	s.healthy = true
	s.failures = 0
	s.successes = 0
	s.suspect = 0
	s.retryAfter = time.Time{}
	s.confirmedAt = time.Now()
	s.mu.Unlock()
	if !wasHealthy {
		log.Printf("exit endpoint recovered endpoint=%s", s.label())
	}
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
	defer s.releaseProbe()
	conn, sec, err := dialSecureTCPFresh(s.id.host, s.id.port, cfg)
	if err == nil {
		err = writeSecureFramesWithDeadline(sec, fxpProbeHello)
		_ = conn.Close()
	}
	if err != nil {
		s.probeFailed(err)
		return
	}
	s.probeSucceeded()
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
		if pooledConnAlive(pooled.conn) {
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
	conn, sec, err := dialSecureTCPFresh(s.id.host, s.id.port, cfg)
	now := time.Now()
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
		fxpEndpoints.mu.Lock()
		states := make([]*fxpEndpointState, 0, len(fxpEndpoints.states))
		for _, state := range fxpEndpoints.states {
			states = append(states, state)
		}
		fxpEndpoints.mu.Unlock()
		for _, state := range states {
			state.maintain(now)
		}
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
	probe := false
	if s.watchers > 0 && s.dialCfgKnown && !s.probing {
		switch {
		case !s.healthy:
			probe = !s.retryAfter.IsZero() && !now.Before(s.retryAfter)
		case s.suspect > 0:
			probe = true
		default:
			probe = now.Sub(s.confirmedAt) >= fxpHealthyProbeEvery
		}
	}
	if probe {
		s.probing = true
	}
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
}
