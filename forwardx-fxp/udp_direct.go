package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	fxpUDPMagic = "FXPU"
	// 4：包头 8~12 字节从隧道号换成发出时间（Unix 秒，参与认证），出口按它
	// 拒收过期的包（见 udp_replay_guard.go）。隧道号本来就在密钥派生里，
	// 收包方用自己配置里的隧道号，包头里那份是多余的。
	fxpUDPVersion    = byte(4)
	fxpUDPTypeData   = byte(1)
	fxpUDPTypeReturn = byte(2)
	fxpUDPHeaderSize = 32
	fxpUDPReplayBits = 64
	// 回程地址迁移：新地址要在这个时间内连着送来 fxpUDPPeerMigratePackets 个
	// 认证过、序号递增的最新包，才把回程挪过去（见 udpPeerMigration）。
	fxpUDPPeerMigrateWindow  = 10 * time.Second
	fxpUDPPeerMigratePackets = 2
)

/*
udpPeerMigration 决定出口/中转什么时候把会话的回程挪到新的来源地址。

以前一个认证过的最新包从新地址来就立刻挪。能看到流量的人把截到的包抢先从
自己的地址转发一份（包是真的，序号也是最新的），回程就整个被拐走了。现在
要求同一个新地址在短时间内连着送来至少两个不同的、序号递增的最新包；期间
旧地址又送来最新包就作废。NAT 重新映射后入口的包全从新地址来，第二个包就会
挪过去（中间最多有一个回包还发往旧地址）；抢发要连着赢两次才行。
不改协议，两边版本不同也照常工作。

会话是被第一个认证过的包建起来的，那个包未必过得了重放窗口（比如出口重启
监听后、有人把录下的旧包换个地址重放）。所以会话收下的第一个包直接定下回程
地址，不受上面的限制 —— 建会话那个地址本身还没被任何收下的包证实过。
*/
type udpPeerMigration struct {
	mu        sync.Mutex
	confirmed bool
	// candidate 无效（零值）表示眼下没有候选地址。
	candidate netip.AddrPort
	lastSeq   uint64
	firstSeen time.Time
	count     int
}

// observe 在一个包过了认证、时间窗和重放窗口之后调用。highest 表示它是这个
// 会话目前序号最高的包。返回 true 时回程应该改到 addr。
func (m *udpPeerMigration) observe(addr, current *net.UDPAddr, sequence uint64, highest bool, now time.Time) bool {
	if addr == nil {
		return false
	}
	return m.observeAddrPort(fxpUDPAddrPortOf(addr), fxpUDPAddrPortOf(current), sequence, highest, now)
}

// observeAddrPort 是 observe 的热路径版本：地址用 netip.AddrPort（值类型，可以
// 直接比较），读循环里每个包都走这里，不再为比较地址分配 *net.UDPAddr。
// 两个地址都要先经过 fxpUDPNormalizeAddrPort。
func (m *udpPeerMigration) observeAddrPort(addr, current netip.AddrPort, sequence uint64, highest bool, now time.Time) bool {
	if !addr.IsValid() {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.confirmed {
		m.confirmed = true
		return addr != current
	}
	if !highest {
		return false
	}
	if addr == current {
		m.candidate = netip.AddrPort{}
		m.count = 0
		return false
	}
	if m.candidate.IsValid() && addr == m.candidate && sequence > m.lastSeq && now.Sub(m.firstSeen) <= fxpUDPPeerMigrateWindow {
		m.count++
		m.lastSeq = sequence
		if m.count >= fxpUDPPeerMigratePackets {
			m.candidate = netip.AddrPort{}
			m.count = 0
			return true
		}
		return false
	}
	m.candidate = addr
	m.lastSeq = sequence
	m.firstSeen = now
	m.count = 1
	return false
}

// udpPeer 是会话当前的回程地址，两种形式各存一份：写 socket 用 *net.UDPAddr，
// 和收到的包比较用 netip.AddrPort。整个结构只在回程迁移时整体替换（原子指针），
// 读循环和回程写协程各自读，不用加锁，也不用每包分配。
type udpPeer struct {
	addr     *net.UDPAddr
	addrPort netip.AddrPort
}

func newUDPPeer(addr *net.UDPAddr) *udpPeer {
	return &udpPeer{addr: addr, addrPort: fxpUDPAddrPortOf(addr)}
}

func newUDPPeerFromAddrPort(addrPort netip.AddrPort) *udpPeer {
	return &udpPeer{addr: net.UDPAddrFromAddrPort(addrPort), addrPort: addrPort}
}

type fxpUDPPacket struct {
	packetType byte
	tunnelID   int
	ruleID     int
	sessionID  uint64
	sequence   uint64
	fragment   uint8
	fragments  uint8
	// sentAt 是发出时间（Unix 秒），写在包头里、参与认证；封包时为 0 就填当前时间。
	sentAt  uint32
	payload []byte
}

type fxpUDPCodec struct {
	packetType byte
	tunnelID   int
	ruleID     int
	sessionID  uint64
	aead       cipher.AEAD
}

// udpReplayWindow admits each authenticated datagram sequence once while allowing
// bounded UDP reordering. Fragments share that sequence and use their index in
// the AEAD nonce, so a nonce is never reused within the session direction.
type udpReplayWindow struct {
	mu          sync.Mutex
	initialized bool
	highest     uint64
	seen        uint64
}

func (w *udpReplayWindow) accept(sequence uint64) bool {
	if sequence == 0 {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.initialized {
		w.initialized = true
		w.highest = sequence
		w.seen = 1
		return true
	}
	if sequence > w.highest {
		shift := sequence - w.highest
		if shift >= fxpUDPReplayBits {
			w.seen = 1
		} else {
			w.seen = (w.seen << shift) | 1
		}
		w.highest = sequence
		return true
	}
	distance := w.highest - sequence
	if distance >= fxpUDPReplayBits {
		return false
	}
	bit := uint64(1) << distance
	if w.seen&bit != 0 {
		return false
	}
	w.seen |= bit
	return true
}

// highestSequence 是窗口里收过的最大序号。
func (w *udpReplayWindow) highestSequence() uint64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.highest
}

type udpDirectEntrySession struct {
	// key 是客户端地址（规整过的），也是会话表的键。
	key        netip.AddrPort
	sessionID  uint64
	clientAddr *net.UDPAddr
	// sourceIP 是按来源 IP 计数用的键（见 fxpUDPSourceIP）。
	sourceIP   netip.Addr
	conn       *net.UDPConn
	remoteAddr *net.UDPAddr
	// remoteAddrPort 和 remoteAddr 是同一个地址，读循环用它判断回包是不是从
	// 出口来的，不用每包比较 net.IP。
	remoteAddrPort  netip.AddrPort
	endpoint        exitEndpoint
	endpointIndex   int
	cfg             config
	inLimiter       *limiter
	outLimiter      *limiter
	counter         *trafficCounter
	send            *fxpUDPQueue
	recv            *fxpUDPQueue
	done            chan struct{}
	closeOnce       sync.Once
	lastActivity    atomic.Int64
	inFlight        atomic.Int64
	sendSequence    atomic.Uint64
	returnReplay    udpReplayWindow
	returnFragments udpFragmentReassembler
	dataSealer      *fxpUDPCodec
	returnOpener    *fxpUDPCodec
	remove          func(*udpDirectEntrySession)
	// releaseGate 归还这条会话在规则连接闸（maxConnections / maxIPs）上的份额。
	// 只在会话登记表的锁里读写。
	releaseGate func()
}

type udpDirectExitSession struct {
	key           udpRuleSessionKey
	sessionID     uint64
	peerRef       atomic.Pointer[udpPeer]
	peerMigration udpPeerMigration
	conn          *net.UDPConn
	target        *net.UDPConn
	send          *fxpUDPQueue
	cfg           config
	ruleID        int
	targetIP      string
	targetPort    int
	done          chan struct{}
	closeOnce     sync.Once
	lastActivity  atomic.Int64
	inFlight      atomic.Int64
	sendSequence  atomic.Uint64
	replayKey     udpReplayKey
	replay        *udpReplayState
	dataFragments udpFragmentReassembler
	dataOpener    *fxpUDPCodec
	returnSealer  *fxpUDPCodec
	// counter 是这条规则在这个出口监听上的流量计数（按规则共用一个），nil 表示不记。
	counter *trafficCounter
	remove  func(*udpDirectExitSession)
}

type udpDirectRelaySession struct {
	key                    udpRuleSessionKey
	sessionID              uint64
	upstreamRef            atomic.Pointer[udpPeer]
	upstreamMigration      udpPeerMigration
	downstreamAddr         *net.UDPAddr
	downstreamAddrPort     netip.AddrPort
	conn                   *net.UDPConn
	cfg                    config
	ruleID                 int
	endpoint               exitEndpoint
	endpointIndex          int
	downstreamSend         *fxpUDPQueue
	upstreamSend           *fxpUDPQueue
	done                   chan struct{}
	closeOnce              sync.Once
	lastActivity           atomic.Int64
	inFlight               atomic.Int64
	downstreamSeq          atomic.Uint64
	upstreamSeq            atomic.Uint64
	replayKey              udpReplayKey
	replay                 *udpReplayState
	returnReplay           udpReplayWindow
	dataFragments          udpFragmentReassembler
	returnFragments        udpFragmentReassembler
	upstreamDataOpener     *fxpUDPCodec
	downstreamDataSealer   *fxpUDPCodec
	downstreamReturnOpener *fxpUDPCodec
	upstreamReturnSealer   *fxpUDPCodec
	remove                 func(*udpDirectRelaySession)
}

func udpDirectEntrySessionSnapshot(session *udpDirectEntrySession) fxpUDPSessionSnapshot {
	state := fxpUDPSessionSnapshot{}
	if session == nil {
		return state
	}
	if session.clientAddr != nil {
		state.sourceIP = session.clientAddr.IP.String()
	}
	state.lastActivity = session.lastActivity.Load()
	if session.send != nil {
		state.pending += session.send.pending()
	}
	if session.recv != nil {
		state.pending += session.recv.pending()
	}
	state.pending += session.returnFragments.pendingCount()
	state.pending += int(session.inFlight.Load())
	return state
}

func udpDirectExitSessionSnapshot(session *udpDirectExitSession) fxpUDPSessionSnapshot {
	state := fxpUDPSessionSnapshot{}
	if session == nil {
		return state
	}
	state.lastActivity = session.lastActivity.Load()
	if session.send != nil {
		state.pending = session.send.pending()
	}
	state.pending += session.dataFragments.pendingCount()
	state.pending += int(session.inFlight.Load())
	return state
}

func udpDirectRelaySessionSnapshot(session *udpDirectRelaySession) fxpUDPSessionSnapshot {
	state := fxpUDPSessionSnapshot{}
	if session == nil {
		return state
	}
	state.lastActivity = session.lastActivity.Load()
	if session.downstreamSend != nil {
		state.pending += session.downstreamSend.pending()
	}
	if session.upstreamSend != nil {
		state.pending += session.upstreamSend.pending()
	}
	state.pending += session.dataFragments.pendingCount()
	state.pending += session.returnFragments.pendingCount()
	state.pending += int(session.inFlight.Load())
	return state
}

func serveEntryUDPDirect(conn *net.UDPConn, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter) error {
	// 会话表按 netip 的地址找：可以直接比较的值类型，读循环里每个包不再把地址
	// 格式化成字符串。
	sessionsByClient := map[netip.AddrPort]*udpDirectEntrySession{}
	sessionsByID := map[uint64]*udpDirectEntrySession{}
	sessionsPerIP := map[netip.Addr]int{}
	policy := defaultFXPUDPSessionPolicy()
	// 规则自己的连接上限，和 TCP 入口用同一套闸（newConnGate）：maxConnections
	// 管同时在跑的会话数，maxIPs 和 TCP 一样按来源 IP 限。以前 UDP 只受全局的
	// 会话上限约束，套餐里给规则设的限制对 UDP 不起作用。
	ruleGate := newConnGate(cfg.MaxConnections, cfg.MaxIPs)
	var sessionsMu sync.Mutex
	var workerWG sync.WaitGroup
	counter := &trafficCounter{}
	stopReporting := startTrafficReporter(cfg, counter)
	defer stopReporting()
	queueBudget := newDefaultFXPUDPQueueRuleBudget()
	detachSessionLocked := func(session *udpDirectEntrySession) bool {
		if session == nil || sessionsByClient[session.key] != session {
			return false
		}
		if session.releaseGate != nil {
			session.releaseGate()
			session.releaseGate = nil
		}
		delete(sessionsByClient, session.key)
		if sessionsByID[session.sessionID] == session {
			delete(sessionsByID, session.sessionID)
		}
		if session.sourceIP.IsValid() {
			if sessionsPerIP[session.sourceIP] <= 1 {
				delete(sessionsPerIP, session.sourceIP)
			} else {
				sessionsPerIP[session.sourceIP]--
			}
		}
		return true
	}
	removeSession := func(session *udpDirectEntrySession) {
		sessionsMu.Lock()
		detachSessionLocked(session)
		sessionsMu.Unlock()
	}
	stopSweeper, wakeSweeper := startFXPUDPSessionSweeper(func(now time.Time) {
		var expired []*udpDirectEntrySession
		var reclaimed []*udpDirectEntrySession
		sessionsMu.Lock()
		for key, session := range sessionsByClient {
			if session != nil {
				session.returnFragments.expire(now)
			}
			state := udpDirectEntrySessionSnapshot(session)
			if session != nil && fxpUDPSessionExpiredAt(now, state.lastActivity, state.pending) {
				if sessionsByClient[key] == session && detachSessionLocked(session) {
					expired = append(expired, session)
				}
			}
		}
		for _, victim := range planFXPUDPPressureReclamation(now, sessionsByClient, policy, udpDirectEntrySessionSnapshot) {
			if sessionsByClient[victim.key] == victim.session && detachSessionLocked(victim.session) {
				reclaimed = append(reclaimed, victim.session)
			}
		}
		sessionsMu.Unlock()
		for _, session := range expired {
			fxpVerbosef("entry udp direct session idle timeout tunnel=%d rule=%d client=%s", session.cfg.TunnelID, session.cfg.RuleID, session.clientAddr)
			session.close()
		}
		for _, session := range reclaimed {
			session.close()
			fxpUDPDropLog.Printf("entry udp direct reclaimed idle session tunnel=%d rule=%d client=%s reason=capacity-pressure", session.cfg.TunnelID, session.cfg.RuleID, session.clientAddr)
		}
	})
	defer stopSweeper()
	buf := make([]byte, 65535)
	ws := newFXPUDPWorkspace()
	for {
		// ReadFromUDPAddrPort 不像 ReadFromUDP 那样每包分配一个 *net.UDPAddr。
		n, clientAddrPort, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			var closing []*udpDirectEntrySession
			sessionsMu.Lock()
			for _, session := range sessionsByClient {
				closing = append(closing, session)
			}
			sessionsMu.Unlock()
			for _, session := range closing {
				session.close()
			}
			workerWG.Wait()
			return err
		}
		clientAddrPort = fxpUDPNormalizeAddrPort(clientAddrPort)
		if fxpUDPHasMagic(buf[:n]) {
			if sessionID, ok := fxpUDPSessionID(buf[:n]); ok {
				sessionsMu.Lock()
				session := sessionsByID[sessionID]
				claimedReturn := session != nil && clientAddrPort == session.remoteAddrPort
				if claimedReturn {
					session.inFlight.Add(1)
				}
				sessionsMu.Unlock()
				if claimedReturn {
					func() {
						defer session.inFlight.Add(-1)
						// 明文解在借来的缓冲上，交给会话之后由它（和它的队列）负责还。
						packet, err := session.returnOpener.openPacketPooled(buf[:n], ws)
						if err != nil {
							return
						}
						current := false
						if packet.packetType == fxpUDPTypeReturn && packetMatchesConfig(packet, cfg) {
							sessionsMu.Lock()
							current = sessionsByID[sessionID] == session && clientAddrPort == session.remoteAddrPort
							if current {
								session.touch()
							}
							sessionsMu.Unlock()
						}
						if current {
							session.handleResponse(packet, true)
						} else {
							putFXPByteBuffer(packet.payload)
						}
					}()
					continue
				}
			}
		}
		key := clientAddrPort
		sourceIP := fxpUDPSourceIP(clientAddrPort)
		sessionsMu.Lock()
		session := sessionsByClient[key]
		if session != nil {
			session.touch()
		}
		preflight := fxpUDPAdmission{allow: true}
		if session == nil {
			preflight = checkFXPUDPSessionCapacity(len(sessionsByClient), sessionsPerIP[sourceIP], sourceIP.String(), policy)
		}
		sessionsMu.Unlock()
		if !preflight.allow {
			wakeSweeper()
			fxpUDPDropLog.Printf("entry udp direct rejected new session tunnel=%d rule=%d client=%s reason=%s sessions=%d perIP=%d hardSessions=%d hardPerIP=%d", cfg.TunnelID, cfg.RuleID, clientAddrPort, preflight.reason, preflight.total, preflight.perIP, policy.hardSessions, policy.hardPerIP)
			continue
		}
		startSession := false
		if session == nil {
			// 新会话才需要 *net.UDPAddr（写 socket、连接闸、日志），每个会话分配一次。
			addr := net.UDPAddrFromAddrPort(clientAddrPort)
			sourceIPLabel := sourceIP.String()
			releaseGate, ok, reason := ruleGate.acquire(addr)
			if !ok {
				active, ips, forIP := ruleGate.statsFor(addr)
				fxpUDPDropLog.Printf("entry udp direct rejected by connection gate tunnel=%d rule=%d client=%s reason=%s active=%d maxConnections=%d distinctIPs=%d sessionsForIP=%d maxIPs=%d", cfg.TunnelID, cfg.RuleID, addr, reason, active, cfg.MaxConnections, ips, forIP, cfg.MaxIPs)
				continue
			}
			created, err := newUDPDirectEntrySession(conn, addr, cfg, selector, inLimiter, outLimiter, counter, queueBudget, removeSession)
			if err != nil {
				releaseGate()
				if errors.Is(err, errHopResolvePending) {
					fxpUDPDropLog.Printf("entry udp direct waiting for exit address tunnel=%d rule=%d client=%s: %v", cfg.TunnelID, cfg.RuleID, addr, err)
				} else if !isClosedErr(err) {
					log.Printf("entry udp direct session create failed tunnel=%d rule=%d client=%s: %v", cfg.TunnelID, cfg.RuleID, addr, err)
				}
				continue
			}
			var closeCreated *udpDirectEntrySession
			var admission fxpUDPAdmission
			rejected := false
			collision := false
			pressure := false
			adopted := false
			sessionsMu.Lock()
			if existing := sessionsByClient[key]; existing != nil {
				session = existing
				session.touch()
				closeCreated = created
			} else if sessionsByID[created.sessionID] != nil {
				closeCreated = created
				collision = true
			} else {
				admission = checkFXPUDPSessionCapacity(len(sessionsByClient), sessionsPerIP[sourceIP], sourceIPLabel, policy)
				if !admission.allow {
					closeCreated = created
					rejected = true
				} else {
					created.releaseGate = releaseGate
					adopted = true
					sessionsByClient[key] = created
					sessionsByID[created.sessionID] = created
					sessionsPerIP[sourceIP]++
					session = created
					startSession = true
					pressure = fxpUDPSessionPressure(len(sessionsByClient), sessionsPerIP[sourceIP], sourceIPLabel, policy)
				}
			}
			sessionsMu.Unlock()
			if !adopted {
				releaseGate()
			}
			if closeCreated != nil {
				closeCreated.close()
			}
			if collision {
				fxpUDPDropLog.Printf("entry udp direct rejected session id collision tunnel=%d rule=%d client=%s session=%d", cfg.TunnelID, cfg.RuleID, addr, created.sessionID)
				continue
			}
			if rejected {
				wakeSweeper()
				fxpUDPDropLog.Printf("entry udp direct rejected new session tunnel=%d rule=%d client=%s reason=%s sessions=%d perIP=%d hardSessions=%d hardPerIP=%d", cfg.TunnelID, cfg.RuleID, addr, admission.reason, admission.total, admission.perIP, policy.hardSessions, policy.hardPerIP)
				continue
			}
			if pressure {
				wakeSweeper()
			}
		}
		if startSession {
			session.counter.connections.Add(1)
			session.start(&workerWG)
		}
		// 收包缓冲马上要读下一个包，明文拷进一块借来的缓冲，连同所有权交给发送队列，
		// 写出去之后还回池里（见 fxpUDPQueuedPacket.pooled）。
		payload := getFXPByteBuffer(n)
		copy(payload, buf[:n])
		session.enqueue(payload, true)
	}
}

func newUDPDirectEntrySession(conn *net.UDPConn, clientAddr *net.UDPAddr, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter, counter *trafficCounter, queueBudget *fxpUDPQueueRuleBudget, remove func(*udpDirectEntrySession)) (*udpDirectEntrySession, error) {
	endpoint, index, remoteAddr, err := pickUDPDirectEndpoint(selector, cfg, clientAddr.IP.String())
	if err != nil {
		return nil, err
	}
	sessionID, err := randomUint64()
	if err != nil {
		return nil, err
	}
	codecKey := udpEndpointKey(endpoint, cfg.Key)
	dataSealer, err := newFXPUDPCodec(codecKey, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   cfg.TunnelID,
		ruleID:     cfg.RuleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	returnOpener, err := newFXPUDPCodec(codecKey, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   cfg.TunnelID,
		ruleID:     cfg.RuleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	sendSeed, err := allocateFXPUDPSequenceSeed()
	if err != nil {
		return nil, err
	}
	if counter == nil {
		counter = &trafficCounter{}
	}
	clientAddrPort := fxpUDPAddrPortOf(clientAddr)
	session := &udpDirectEntrySession{
		key:            clientAddrPort,
		sessionID:      sessionID,
		clientAddr:     clientAddr,
		sourceIP:       fxpUDPSourceIP(clientAddrPort),
		conn:           conn,
		remoteAddr:     remoteAddr,
		remoteAddrPort: fxpUDPAddrPortOf(remoteAddr),
		endpoint:       endpoint,
		endpointIndex:  index,
		cfg:            cfg,
		inLimiter:      inLimiter,
		outLimiter:     outLimiter,
		counter:        counter,
		send:           newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		recv:           newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		done:           make(chan struct{}),
		dataSealer:     dataSealer,
		returnOpener:   returnOpener,
		remove:         remove,
	}
	session.sendSequence.Store(sendSeed)
	session.returnFragments.bindBudget(queueBudget)
	session.touch()
	return session, nil
}

func (s *udpDirectEntrySession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectEntrySession) start(workerWG *sync.WaitGroup) {
	startFXPUDPSessionWorker(workerWG, s.writeLoop)
	startFXPUDPSessionWorker(workerWG, s.clientWriteLoop)
	fxpVerbosef("entry udp direct session started tunnel=%d rule=%d client=%s exit=%s:%d target=%s:%d session=%d", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.endpoint.Host, s.endpoint.Port, s.cfg.TargetIP, s.cfg.TargetPort, s.sessionID)
}

// enqueue 把客户端发来的一个包放进发送队列。pooled 时 payload 的所有权一并交出。
func (s *udpDirectEntrySession) enqueue(payload []byte, pooled bool) {
	s.touch()
	select {
	case <-s.done:
		recycleFXPUDPPayload(payload, pooled)
		return
	default:
		if s.send.enqueueOwned(payload, pooled) {
			fxpUDPDropLog.Printf("entry udp direct queue congested tunnel=%d rule=%d client=%s; packet dropped", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
		}
	}
}

func (s *udpDirectEntrySession) writeLoop() {
	defer observeFXPUDPSequence(&s.sendSequence)
	ws := newFXPUDPWorkspace()
	for {
		queued, ok := s.send.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if queued.superseded(time.Now(), s.send.pending()) {
			fxpUDPDropLog.Printf("entry udp direct queued packet expired tunnel=%d rule=%d client=%s; dropping stale packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
			queued.done()
			continue
		}
		payload := queued.payload
		s.touch()
		if !s.inLimiter.waitDone(s.done, len(payload)) {
			queued.done()
			return
		}
		if queued.superseded(time.Now(), s.send.pending()) {
			fxpUDPDropLog.Printf("entry udp direct queued packet expired after wait tunnel=%d rule=%d client=%s; dropping stale packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
			queued.done()
			continue
		}
		var writeErr error
		err := sealFXPUDPDatagramsEach(fxpUDPPacket{
			packetType: fxpUDPTypeData,
			tunnelID:   s.cfg.TunnelID,
			ruleID:     s.cfg.RuleID,
			sessionID:  s.sessionID,
			payload:    payload,
		}, s.dataSealer, &s.sendSequence, ws, func(wire []byte) error {
			_, writeErr = s.conn.WriteToUDP(wire, s.remoteAddr)
			return writeErr
		})
		if writeErr != nil {
			log.Printf("entry udp direct send failed tunnel=%d rule=%d client=%s exit=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.remoteAddr, writeErr)
			queued.done()
			s.close()
			return
		}
		if err != nil {
			log.Printf("entry udp direct seal failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
			queued.done()
			s.close()
			return
		}
		s.counter.in.Add(uint64(len(payload)))
		queued.done()
	}
}

// handleResponse 处理出口的一个回包。pooled 时 packet.payload 是借来的缓冲，
// 所有权一并交给这里。
func (s *udpDirectEntrySession) handleResponse(packet fxpUDPPacket, pooled bool) {
	payload, pooled, ok := s.returnFragments.acceptOwned(packet, &s.returnReplay, pooled)
	if !ok {
		return
	}
	s.touch()
	select {
	case <-s.done:
		recycleFXPUDPPayload(payload, pooled)
		return
	default:
		if s.recv.enqueueOwned(payload, pooled) {
			fxpUDPDropLog.Printf("entry udp direct response queue congested tunnel=%d rule=%d client=%s; packet dropped", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
		}
	}
}

func (s *udpDirectEntrySession) clientWriteLoop() {
	for {
		packet, ok := s.recv.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.recv.pending()) {
			fxpUDPDropLog.Printf("entry udp direct response expired tunnel=%d rule=%d client=%s; dropping stale packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
			packet.done()
			continue
		}
		s.writeResponse(packet.payload)
		packet.done()
	}
}

func (s *udpDirectEntrySession) writeResponse(payload []byte) {
	if !s.outLimiter.waitDone(s.done, len(payload)) {
		return
	}
	linkShaperEgress().wait(len(payload))
	if _, err := s.conn.WriteToUDP(payload, s.clientAddr); err != nil {
		if !isClosedErr(err) {
			log.Printf("entry udp direct client write failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
		}
		s.close()
		return
	}
	s.counter.out.Add(uint64(len(payload)))
	s.touch()
}

func (s *udpDirectEntrySession) close() {
	s.closeOnce.Do(func() {
		observeFXPUDPSequence(&s.sendSequence)
		close(s.done)
		s.send.close()
		s.recv.close()
		s.returnFragments.close()
		if s.remove != nil {
			s.remove(s)
		}
	})
}

func serveExitUDPDirect(conn *net.UDPConn, cfg config) error {
	sessions := map[udpRuleSessionKey]*udpDirectExitSession{}
	policy := defaultFXPUDPSessionPolicy()
	targetsByRule := make(map[int]udpTarget, len(cfg.UDPTargets))
	for _, target := range cfg.UDPTargets {
		if _, exists := targetsByRule[target.RuleID]; !exists {
			targetsByRule[target.RuleID] = target
			// 写的是域名的目标先在后台解析一次，第一个会话进来时缓存里已经有了。
			_, _ = resolveHopAddressNonBlocking(target.TargetIP, target.TargetPort)
		}
	}
	targetForRule := func(ruleID int) (udpTarget, bool) {
		target, ok := targetsByRule[ruleID]
		return target, ok
	}
	queueBudgets := map[int]*fxpUDPQueueRuleBudget{}
	queueBudgetForRule := func(ruleID int) *fxpUDPQueueRuleBudget {
		budget := queueBudgets[ruleID]
		if budget == nil {
			budget = newDefaultFXPUDPQueueRuleBudget()
			queueBudgets[ruleID] = budget
		}
		return budget
	}
	// 出口按规则记流量（见 exit_traffic.go）。只有 udpTargets 里的规则能建会话，
	// 所以只会替面板给的规则记。计数器按规则共用，只在下面的读循环里建。
	trafficCounters := map[int]*trafficCounter{}
	var stopTrafficReporters []func()
	defer func() {
		// 放在最后：读循环退出前已经关完会话、等完收发协程，这里交的是最终的数。
		for _, stop := range stopTrafficReporters {
			stop()
		}
	}()
	trafficCounterForRule := func(ruleID int) *trafficCounter {
		if counter, ok := trafficCounters[ruleID]; ok {
			return counter
		}
		counter, stop := startExitTrafficReporter(cfg, ruleID)
		trafficCounters[ruleID] = counter
		if counter != nil {
			stopTrafficReporters = append(stopTrafficReporters, stop)
		}
		return counter
	}
	var sessionsMu sync.Mutex
	var workerWG sync.WaitGroup
	detachSessionLocked := func(session *udpDirectExitSession) bool {
		if session == nil || sessions[session.key] != session {
			return false
		}
		delete(sessions, session.key)
		return true
	}
	removeSession := func(session *udpDirectExitSession) {
		sessionsMu.Lock()
		detachSessionLocked(session)
		sessionsMu.Unlock()
	}
	stopSweeper, wakeSweeper := startFXPUDPSessionSweeper(func(now time.Time) {
		var expired []*udpDirectExitSession
		var reclaimed []*udpDirectExitSession
		sessionsMu.Lock()
		for key, session := range sessions {
			if session != nil {
				session.dataFragments.expire(now)
			}
			state := udpDirectExitSessionSnapshot(session)
			if session != nil && fxpUDPSessionExpiredAt(now, state.lastActivity, state.pending) {
				if sessions[key] == session && detachSessionLocked(session) {
					expired = append(expired, session)
				}
			}
		}
		for _, victim := range planFXPUDPPressureReclamation(now, sessions, policy, udpDirectExitSessionSnapshot) {
			if sessions[victim.key] == victim.session && detachSessionLocked(victim.session) {
				reclaimed = append(reclaimed, victim.session)
			}
		}
		sessionsMu.Unlock()
		for _, session := range expired {
			fxpVerbosef("exit udp direct session idle timeout tunnel=%d rule=%d peer=%s", session.cfg.TunnelID, session.ruleID, session.peer())
			session.close()
		}
		for _, session := range reclaimed {
			session.close()
			fxpUDPDropLog.Printf("exit udp direct reclaimed idle session tunnel=%d rule=%d peer=%s reason=capacity-pressure", session.cfg.TunnelID, session.ruleID, session.peer())
		}
	})
	defer stopSweeper()
	buf := make([]byte, 65535)
	ws := newFXPUDPWorkspace()
	for {
		n, peerAddrPort, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			var closing []*udpDirectExitSession
			sessionsMu.Lock()
			for _, session := range sessions {
				closing = append(closing, session)
			}
			sessionsMu.Unlock()
			for _, session := range closing {
				session.close()
			}
			workerWG.Wait()
			return err
		}
		header, err := parseFXPUDPHeader(buf[:n])
		if err != nil || header.packetType != fxpUDPTypeData {
			continue
		}
		header.tunnelID = cfg.TunnelID
		if !packetMatchesConfig(header, cfg) {
			continue
		}
		peerAddrPort = fxpUDPNormalizeAddrPort(peerAddrPort)
		// 会话只按（规则, 会话号）找，和来源地址无关（见 udp_replay_guard.go）。
		key := udpRuleSessionKey{ruleID: header.ruleID, sessionID: header.sessionID}
		sessionsMu.Lock()
		session := sessions[key]
		if session != nil {
			session.inFlight.Add(1)
		}
		preflight := fxpUDPAdmission{allow: true}
		if session == nil {
			preflight = checkFXPUDPSessionCapacity(len(sessions), 0, "", policy)
		}
		sessionsMu.Unlock()
		if session != nil {
			func() {
				defer session.inFlight.Add(-1)
				// 明文解在借来的缓冲上：没交出去之前，每条退出的路都要还掉它。
				packet, err := session.dataOpener.openParsedPacketPooled(buf[:n], header, ws)
				if err != nil {
					return
				}
				pooled := true
				defer func() {
					if pooled {
						putFXPByteBuffer(packet.payload)
					}
				}()
				if packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) || !fxpUDPReplayGuard.fresh(packet.sentAt, time.Now()) {
					return
				}
				target, ok := targetForRule(packet.ruleID)
				if !ok {
					fxpUDPDropLog.Printf("exit udp direct target missing tunnel=%d rule=%d peer=%s", cfg.TunnelID, packet.ruleID, peerAddrPort)
					return
				}
				sessionsMu.Lock()
				current := sessions[key] == session
				conflict := current && (session.targetIP != target.TargetIP || session.targetPort != target.TargetPort)
				if current && !conflict {
					session.touch()
				}
				sessionsMu.Unlock()
				if !current {
					return
				}
				if conflict {
					fxpUDPDropLog.Printf("exit udp direct rejected session target conflict tunnel=%d rule=%d peer=%s session=%d", cfg.TunnelID, packet.ruleID, peerAddrPort, packet.sessionID)
					return
				}
				// 从这里起缓冲的所有权交给重组器和发送队列。
				pooled = false
				payload, payloadPooled, ok := session.dataFragments.acceptOwned(packet, &session.replay.window, true)
				if ok {
					session.acceptedFrom(peerAddrPort, packet)
					session.forwardToTarget(payload, payloadPooled)
				}
			}()
			continue
		}
		if !preflight.allow {
			wakeSweeper()
			fxpUDPDropLog.Printf("exit udp direct rejected new session tunnel=%d rule=%d peer=%s reason=%s sessions=%d hardSessions=%d", cfg.TunnelID, header.ruleID, peerAddrPort, preflight.reason, preflight.total, policy.hardSessions)
			continue
		}
		packet, err := openFXPUDPPacket(buf[:n], cfg.TunnelID, cfg.Key)
		if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) || !fxpUDPReplayGuard.fresh(packet.sentAt, time.Now()) {
			continue
		}
		target, ok := targetForRule(packet.ruleID)
		if !ok {
			fxpUDPDropLog.Printf("exit udp direct target missing tunnel=%d rule=%d peer=%s", cfg.TunnelID, packet.ruleID, peerAddrPort)
			continue
		}
		if session == nil {
			// 新会话：这一个包走旧的（每包新建解密上下文、新分配明文）的路，建好会话
			// 之后的包都走上面的热路径。
			peerAddr := net.UDPAddrFromAddrPort(peerAddrPort)
			created, err := newUDPDirectExitSession(conn, peerAddr, cfg, packet.ruleID, packet.sessionID, target.TargetIP, target.TargetPort, queueBudgetForRule(packet.ruleID), removeSession)
			if err == nil {
				created.counter = trafficCounterForRule(packet.ruleID)
			}
			if err != nil {
				if errors.Is(err, errHopResolvePending) {
					fxpUDPDropLog.Printf("exit udp direct waiting for target address tunnel=%d rule=%d peer=%s target=%s:%d", cfg.TunnelID, packet.ruleID, peerAddr, target.TargetIP, target.TargetPort)
				} else {
					log.Printf("exit udp direct session create failed tunnel=%d rule=%d peer=%s target=%s:%d: %v", cfg.TunnelID, packet.ruleID, peerAddr, target.TargetIP, target.TargetPort, err)
				}
				continue
			}
			var closeCreated *udpDirectExitSession
			var admission fxpUDPAdmission
			rejected := false
			startSession := false
			pressure := false
			sessionsMu.Lock()
			if existing := sessions[key]; existing != nil {
				session = existing
				session.touch()
				closeCreated = created
			} else {
				admission = checkFXPUDPSessionCapacity(len(sessions), 0, "", policy)
				if !admission.allow {
					closeCreated = created
					rejected = true
				} else {
					sessions[key] = created
					session = created
					startSession = true
					pressure = fxpUDPSessionPressure(len(sessions), 0, "", policy)
				}
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
			if rejected {
				wakeSweeper()
				fxpUDPDropLog.Printf("exit udp direct rejected new session tunnel=%d rule=%d peer=%s reason=%s sessions=%d hardSessions=%d", cfg.TunnelID, packet.ruleID, peerAddr, admission.reason, admission.total, policy.hardSessions)
				continue
			}
			if pressure {
				wakeSweeper()
			}
			if startSession {
				if session.counter != nil {
					session.counter.connections.Add(1)
				}
				session.start(&workerWG)
			}
		}
		payload, pooled, ok := session.dataFragments.acceptOwned(packet, &session.replay.window, false)
		if !ok {
			continue
		}
		session.acceptedFrom(peerAddrPort, packet)
		session.forwardToTarget(payload, pooled)
	}
}

func newUDPDirectExitSession(conn *net.UDPConn, peerAddr *net.UDPAddr, cfg config, ruleID int, sessionID uint64, targetIP string, targetPort int, queueBudget *fxpUDPQueueRuleBudget, remove func(*udpDirectExitSession)) (*udpDirectExitSession, error) {
	dataOpener, err := newFXPUDPCodec(cfg.Key, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	returnSealer, err := newFXPUDPCodec(cfg.Key, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	targetAddr, err := resolveExitUDPDirectTarget(ruleID, targetIP, targetPort)
	if err != nil {
		return nil, err
	}
	target, err := net.DialUDP("udp", nil, targetAddr)
	if err != nil {
		return nil, err
	}
	tuneUDPConn(target, "exit target", fxpUDPSessionBufferBytes)
	sendSeed, err := allocateFXPUDPSequenceSeed()
	if err != nil {
		_ = target.Close()
		return nil, err
	}
	replayKey := udpReplayKeyFor("exit", conn, cfg.TunnelID, ruleID, sessionID)
	session := &udpDirectExitSession{
		key:          udpRuleSessionKey{ruleID: ruleID, sessionID: sessionID},
		sessionID:    sessionID,
		conn:         conn,
		target:       target,
		send:         newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		cfg:          cfg,
		ruleID:       ruleID,
		targetIP:     targetIP,
		targetPort:   targetPort,
		done:         make(chan struct{}),
		dataOpener:   dataOpener,
		returnSealer: returnSealer,
		remove:       remove,
		replayKey:    replayKey,
		replay:       fxpUDPReplayGuard.acquire(replayKey, time.Now()),
	}
	session.peerRef.Store(newUDPPeer(peerAddr))
	session.sendSequence.Store(sendSeed)
	session.dataFragments.bindBudget(queueBudget)
	session.touch()
	return session, nil
}

// resolveExitUDPDirectTarget 解析 UDP 直连出口的目标，规则和走 TCP 流的一样
// （checkResolvedExitTarget）：写死的 IP 照拨，域名解析到环回、链路本地、未指定、
// 组播地址的不拨。解析走下一跳的缓存、不在读循环里等 DNS，见
// resolveHopAddressNonBlocking。
func resolveExitUDPDirectTarget(ruleID int, targetIP string, targetPort int) (*net.UDPAddr, error) {
	host := strings.Trim(strings.TrimSpace(targetIP), "[]")
	address, err := resolveHopAddressNonBlocking(host, targetPort)
	if err != nil {
		return nil, err
	}
	addr, err := net.ResolveUDPAddr("udp", address)
	if err != nil {
		return nil, err
	}
	hello := helloFrame{RuleID: ruleID, TargetIP: host, TargetPort: targetPort, targetLiteral: net.ParseIP(host) != nil}
	if err := checkResolvedExitTarget(hello, addr.IP); err != nil {
		return nil, err
	}
	return addr, nil
}

func (s *udpDirectExitSession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectExitSession) peer() *net.UDPAddr {
	if peer := s.peerRef.Load(); peer != nil {
		return peer.addr
	}
	return nil
}

func (s *udpDirectExitSession) peerAddrPort() netip.AddrPort {
	if peer := s.peerRef.Load(); peer != nil {
		return peer.addrPort
	}
	return netip.AddrPort{}
}

// acceptedFrom 记下一个过了认证、时间窗和重放窗口的包。它是这个会话目前最新
// 的包、又是从新地址来的，才把回程改到新地址（入口换地址 / NAT 重新映射）；
// 重放的旧包过不了窗口，走不到这里。addr 要先经过 fxpUDPNormalizeAddrPort。
func (s *udpDirectExitSession) acceptedFrom(addr netip.AddrPort, packet fxpUDPPacket) {
	s.replay.observe(packet.sentAt)
	highest := s.replay.window.highestSequence() == packet.sequence
	if !s.peerMigration.observeAddrPort(addr, s.peerAddrPort(), packet.sequence, highest, time.Now()) {
		return
	}
	next := newUDPPeerFromAddrPort(addr)
	previous := s.peerRef.Swap(next)
	var from *net.UDPAddr
	if previous != nil {
		from = previous.addr
	}
	fxpVerbosef("exit udp direct session peer moved tunnel=%d rule=%d session=%d from=%s to=%s", s.cfg.TunnelID, s.ruleID, s.sessionID, from, next.addr)
}

func (s *udpDirectExitSession) start(workerWG *sync.WaitGroup) {
	startFXPUDPSessionWorker(workerWG, s.writeTargetLoop)
	startFXPUDPSessionWorker(workerWG, s.readTargetLoop)
	fxpVerbosef("exit udp direct session routed tunnel=%d rule=%d peer=%s target=%s:%d session=%d", s.cfg.TunnelID, s.ruleID, s.peer(), s.targetIP, s.targetPort, s.sessionID)
}

// forwardToTarget 把一个包放进发往目标的队列。pooled 时 payload 的所有权一并交出。
func (s *udpDirectExitSession) forwardToTarget(payload []byte, pooled bool) {
	s.touch()
	select {
	case <-s.done:
		recycleFXPUDPPayload(payload, pooled)
		return
	default:
		if s.send.enqueueOwned(payload, pooled) {
			fxpUDPDropLog.Printf("exit udp direct target queue congested tunnel=%d rule=%d peer=%s target=%s:%d; packet dropped", s.cfg.TunnelID, s.ruleID, s.peer(), s.targetIP, s.targetPort)
		}
	}
}

func (s *udpDirectExitSession) writeTargetLoop() {
	for {
		packet, ok := s.send.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.send.pending()) {
			fxpUDPDropLog.Printf("exit udp direct target packet expired tunnel=%d rule=%d peer=%s target=%s:%d; dropping stale packet", s.cfg.TunnelID, s.ruleID, s.peer(), s.targetIP, s.targetPort)
			packet.done()
			continue
		}
		s.writeTarget(packet.payload)
		packet.done()
	}
}

func (s *udpDirectExitSession) writeTarget(payload []byte) {
	if _, err := s.target.Write(payload); err != nil {
		log.Printf("exit udp direct target write failed tunnel=%d rule=%d peer=%s target=%s:%d: %v", s.cfg.TunnelID, s.ruleID, s.peer(), s.targetIP, s.targetPort, err)
		s.close()
		return
	}
	if s.counter != nil {
		s.counter.in.Add(uint64(len(payload)))
	}
	s.touch()
}

func (s *udpDirectExitSession) readTargetLoop() {
	defer observeFXPUDPSequence(&s.sendSequence)
	buf := getFXPByteBuffer(fxpUDPMaxDatagramPayload)
	defer putFXPByteBuffer(buf)
	ws := newFXPUDPWorkspace()
	// 读超时只是用来定期醒一下、看会话关了没有（关会话本身也会关掉 target，
	// 读会立刻返回）。不再每个包都重设一次，见 fxpRearmingReadDeadline。
	deadline := fxpRearmingReadDeadline{period: fxpUDPTargetReadWake}
	for {
		deadline.arm(s.target, time.Now())
		n, err := s.target.Read(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				select {
				case <-s.done:
					return
				default:
					continue
				}
			}
			if !isClosedErr(err) {
				log.Printf("exit udp direct target read failed tunnel=%d rule=%d peer=%s target=%s:%d: %v", s.cfg.TunnelID, s.ruleID, s.peer(), s.targetIP, s.targetPort, err)
			}
			s.close()
			return
		}
		if n <= 0 {
			continue
		}
		s.touch()
		// 一个包的几片发往同一个回程地址，回程迁移不会把一个包拆到两个地址上。
		peer := s.peer()
		var writeErr error
		err = sealFXPUDPDatagramsEach(fxpUDPPacket{
			packetType: fxpUDPTypeReturn,
			tunnelID:   s.cfg.TunnelID,
			ruleID:     s.ruleID,
			sessionID:  s.sessionID,
			payload:    buf[:n],
		}, s.returnSealer, &s.sendSequence, ws, func(wire []byte) error {
			_, writeErr = s.conn.WriteToUDP(wire, peer)
			return writeErr
		})
		if writeErr != nil {
			log.Printf("exit udp direct peer write failed tunnel=%d rule=%d peer=%s: %v", s.cfg.TunnelID, s.ruleID, peer, writeErr)
			s.close()
			return
		}
		if err != nil {
			log.Printf("exit udp direct seal failed tunnel=%d rule=%d peer=%s: %v", s.cfg.TunnelID, s.ruleID, s.peer(), err)
			s.close()
			return
		}
		if s.counter != nil {
			s.counter.out.Add(uint64(n))
		}
		s.touch()
	}
}

func (s *udpDirectExitSession) close() {
	s.closeOnce.Do(func() {
		observeFXPUDPSequence(&s.sendSequence)
		close(s.done)
		s.send.close()
		s.dataFragments.close()
		if s.remove != nil {
			s.remove(s)
		}
		fxpUDPReplayGuard.release(s.replayKey, s.replay, time.Now())
		_ = s.target.Close()
	})
}

func serveRelayUDPDirect(conn *net.UDPConn, cfg config, selector *exitEndpointSelector) error {
	sessionsByUpstream := map[udpRuleSessionKey]*udpDirectRelaySession{}
	sessionsByID := map[uint64]*udpDirectRelaySession{}
	policy := defaultFXPUDPSessionPolicy()
	queueBudget := newDefaultFXPUDPQueueRuleBudget()
	var sessionsMu sync.Mutex
	var workerWG sync.WaitGroup
	detachSessionLocked := func(session *udpDirectRelaySession) bool {
		if session == nil || sessionsByUpstream[session.key] != session {
			return false
		}
		delete(sessionsByUpstream, session.key)
		if sessionsByID[session.sessionID] == session {
			delete(sessionsByID, session.sessionID)
		}
		return true
	}
	removeSession := func(session *udpDirectRelaySession) {
		sessionsMu.Lock()
		detachSessionLocked(session)
		sessionsMu.Unlock()
	}
	stopSweeper, wakeSweeper := startFXPUDPSessionSweeper(func(now time.Time) {
		var expired []*udpDirectRelaySession
		var reclaimed []*udpDirectRelaySession
		sessionsMu.Lock()
		for key, session := range sessionsByUpstream {
			if session != nil {
				session.dataFragments.expire(now)
				session.returnFragments.expire(now)
			}
			state := udpDirectRelaySessionSnapshot(session)
			if session != nil && fxpUDPSessionExpiredAt(now, state.lastActivity, state.pending) {
				if sessionsByUpstream[key] == session && detachSessionLocked(session) {
					expired = append(expired, session)
				}
			}
		}
		for _, victim := range planFXPUDPPressureReclamation(now, sessionsByUpstream, policy, udpDirectRelaySessionSnapshot) {
			if sessionsByUpstream[victim.key] == victim.session && detachSessionLocked(victim.session) {
				reclaimed = append(reclaimed, victim.session)
			}
		}
		sessionsMu.Unlock()
		for _, session := range expired {
			fxpVerbosef("relay udp direct session idle timeout tunnel=%d rule=%d upstream=%s", session.cfg.TunnelID, session.ruleID, session.upstream())
			session.close()
		}
		for _, session := range reclaimed {
			session.close()
			fxpUDPDropLog.Printf("relay udp direct reclaimed idle session tunnel=%d rule=%d upstream=%s reason=capacity-pressure", session.cfg.TunnelID, session.ruleID, session.upstream())
		}
	})
	defer stopSweeper()
	buf := make([]byte, 65535)
	ws := newFXPUDPWorkspace()
	for {
		n, addr, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			var closing []*udpDirectRelaySession
			sessionsMu.Lock()
			for _, session := range sessionsByUpstream {
				closing = append(closing, session)
			}
			sessionsMu.Unlock()
			for _, session := range closing {
				session.close()
			}
			workerWG.Wait()
			return err
		}
		if !fxpUDPHasMagic(buf[:n]) {
			continue
		}
		sessionID, ok := fxpUDPSessionID(buf[:n])
		if !ok {
			continue
		}
		addr = fxpUDPNormalizeAddrPort(addr)
		sessionsMu.Lock()
		session := sessionsByID[sessionID]
		claimedReturn := session != nil && addr == session.downstreamAddrPort
		if claimedReturn {
			session.inFlight.Add(1)
		}
		sessionsMu.Unlock()
		if claimedReturn {
			func() {
				defer session.inFlight.Add(-1)
				packet, err := session.downstreamReturnOpener.openPacketPooled(buf[:n], ws)
				if err != nil {
					return
				}
				current := false
				if packet.packetType == fxpUDPTypeReturn && packetMatchesConfig(packet, cfg) {
					sessionsMu.Lock()
					current = sessionsByID[sessionID] == session && addr == session.downstreamAddrPort
					if current {
						session.touch()
					}
					sessionsMu.Unlock()
				}
				if current {
					session.forwardToUpstream(packet, true)
				} else {
					putFXPByteBuffer(packet.payload)
				}
			}()
			continue
		}
		header, err := parseFXPUDPHeader(buf[:n])
		if err != nil || header.packetType != fxpUDPTypeData {
			continue
		}
		header.tunnelID = cfg.TunnelID
		if !packetMatchesConfig(header, cfg) {
			continue
		}
		// 和出口一样只按（规则, 会话号）找：中转会给下一跳重新封包、换新序号，
		// 这里放进去的重放，下一跳是认不出来的。
		key := udpRuleSessionKey{ruleID: header.ruleID, sessionID: header.sessionID}
		sessionsMu.Lock()
		session = sessionsByUpstream[key]
		if session != nil {
			session.inFlight.Add(1)
		}
		preflight := fxpUDPAdmission{allow: true}
		if session == nil {
			preflight = checkFXPUDPSessionCapacity(len(sessionsByUpstream), 0, "", policy)
		}
		sessionsMu.Unlock()
		if session != nil {
			func() {
				defer session.inFlight.Add(-1)
				packet, err := session.upstreamDataOpener.openParsedPacketPooled(buf[:n], header, ws)
				if err != nil {
					return
				}
				current := false
				if packet.packetType == fxpUDPTypeData && packetMatchesConfig(packet, cfg) && fxpUDPReplayGuard.fresh(packet.sentAt, time.Now()) {
					sessionsMu.Lock()
					current = sessionsByUpstream[key] == session
					if current {
						session.touch()
					}
					sessionsMu.Unlock()
				}
				if !current {
					putFXPByteBuffer(packet.payload)
					return
				}
				session.forwardToDownstream(addr, packet, true)
			}()
			continue
		}
		if !preflight.allow {
			wakeSweeper()
			fxpUDPDropLog.Printf("relay udp direct rejected new session tunnel=%d rule=%d upstream=%s reason=%s sessions=%d hardSessions=%d", cfg.TunnelID, header.ruleID, addr, preflight.reason, preflight.total, policy.hardSessions)
			continue
		}
		packet, err := openFXPUDPPacket(buf[:n], cfg.TunnelID, cfg.Key)
		if err != nil || packet.packetType != fxpUDPTypeData || !packetMatchesConfig(packet, cfg) || !fxpUDPReplayGuard.fresh(packet.sentAt, time.Now()) {
			continue
		}
		if session == nil {
			created, err := newUDPDirectRelaySession(conn, net.UDPAddrFromAddrPort(addr), cfg, selector, packet.ruleID, packet.sessionID, queueBudget, removeSession)
			if err != nil {
				if errors.Is(err, errHopResolvePending) {
					fxpUDPDropLog.Printf("relay udp direct waiting for downstream address tunnel=%d rule=%d upstream=%s: %v", cfg.TunnelID, packet.ruleID, addr, err)
				} else {
					log.Printf("relay udp direct session create failed tunnel=%d rule=%d upstream=%s: %v", cfg.TunnelID, packet.ruleID, addr, err)
				}
				continue
			}
			var closeCreated *udpDirectRelaySession
			var admission fxpUDPAdmission
			rejected := false
			collision := false
			startSession := false
			pressure := false
			sessionsMu.Lock()
			if existing := sessionsByUpstream[key]; existing != nil {
				closeCreated = created
				if existing.ruleID == packet.ruleID {
					session = existing
				} else {
					collision = true
				}
			} else if existing := sessionsByID[created.sessionID]; existing != nil {
				closeCreated = created
				collision = true
			} else {
				admission = checkFXPUDPSessionCapacity(len(sessionsByUpstream), 0, "", policy)
				if !admission.allow {
					closeCreated = created
					rejected = true
				} else {
					sessionsByUpstream[key] = created
					sessionsByID[created.sessionID] = created
					session = created
					startSession = true
					pressure = fxpUDPSessionPressure(len(sessionsByUpstream), 0, "", policy)
				}
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
			if collision {
				fxpUDPDropLog.Printf("relay udp direct rejected session id collision tunnel=%d rule=%d upstream=%s session=%d", cfg.TunnelID, packet.ruleID, addr, packet.sessionID)
				continue
			}
			if rejected {
				wakeSweeper()
				fxpUDPDropLog.Printf("relay udp direct rejected new session tunnel=%d rule=%d upstream=%s reason=%s sessions=%d hardSessions=%d", cfg.TunnelID, packet.ruleID, addr, admission.reason, admission.total, policy.hardSessions)
				continue
			}
			if pressure {
				wakeSweeper()
			}
			if startSession {
				session.start(&workerWG)
			}
		}
		session.forwardToDownstream(addr, packet, false)
	}
}

func newUDPDirectRelaySession(conn *net.UDPConn, upstreamAddr *net.UDPAddr, cfg config, selector *exitEndpointSelector, ruleID int, sessionID uint64, queueBudget *fxpUDPQueueRuleBudget, remove func(*udpDirectRelaySession)) (*udpDirectRelaySession, error) {
	endpoint, index, downstreamAddr, err := pickUDPDirectEndpoint(selector, cfg, strconv.FormatUint(sessionID, 10))
	if err != nil {
		return nil, err
	}
	downstreamKey := udpEndpointKey(endpoint, cfg.RelayKey)
	upstreamDataOpener, err := newFXPUDPCodec(cfg.Key, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	downstreamDataSealer, err := newFXPUDPCodec(downstreamKey, fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	downstreamReturnOpener, err := newFXPUDPCodec(downstreamKey, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	upstreamReturnSealer, err := newFXPUDPCodec(cfg.Key, fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   cfg.TunnelID,
		ruleID:     ruleID,
		sessionID:  sessionID,
	})
	if err != nil {
		return nil, err
	}
	downstreamSeed, err := allocateFXPUDPSequenceSeed()
	if err != nil {
		return nil, err
	}
	upstreamSeed, err := allocateFXPUDPSequenceSeed()
	if err != nil {
		return nil, err
	}
	replayKey := udpReplayKeyFor("relay", conn, cfg.TunnelID, ruleID, sessionID)
	session := &udpDirectRelaySession{
		key:                    udpRuleSessionKey{ruleID: ruleID, sessionID: sessionID},
		sessionID:              sessionID,
		downstreamAddr:         downstreamAddr,
		downstreamAddrPort:     fxpUDPAddrPortOf(downstreamAddr),
		conn:                   conn,
		cfg:                    cfg,
		ruleID:                 ruleID,
		endpoint:               endpoint,
		endpointIndex:          index,
		downstreamSend:         newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		upstreamSend:           newFXPUDPQueueWithBudget(fxpUDPDirectQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		done:                   make(chan struct{}),
		upstreamDataOpener:     upstreamDataOpener,
		downstreamDataSealer:   downstreamDataSealer,
		downstreamReturnOpener: downstreamReturnOpener,
		upstreamReturnSealer:   upstreamReturnSealer,
		remove:                 remove,
		replayKey:              replayKey,
		replay:                 fxpUDPReplayGuard.acquire(replayKey, time.Now()),
	}
	session.upstreamRef.Store(newUDPPeer(upstreamAddr))
	session.downstreamSeq.Store(downstreamSeed)
	session.upstreamSeq.Store(upstreamSeed)
	session.dataFragments.bindBudget(queueBudget)
	session.returnFragments.bindBudget(queueBudget)
	session.touch()
	return session, nil
}

func (s *udpDirectRelaySession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpDirectRelaySession) upstream() *net.UDPAddr {
	if peer := s.upstreamRef.Load(); peer != nil {
		return peer.addr
	}
	return nil
}

func (s *udpDirectRelaySession) upstreamAddrPort() netip.AddrPort {
	if peer := s.upstreamRef.Load(); peer != nil {
		return peer.addrPort
	}
	return netip.AddrPort{}
}

func (s *udpDirectRelaySession) start(workerWG *sync.WaitGroup) {
	startFXPUDPSessionWorker(workerWG, s.downstreamWriteLoop)
	startFXPUDPSessionWorker(workerWG, s.upstreamWriteLoop)
	fxpVerbosef("relay udp direct session routed tunnel=%d rule=%d upstream=%s downstream=%s:%d session=%d", s.cfg.TunnelID, s.ruleID, s.upstream(), s.endpoint.Host, s.endpoint.Port, s.sessionID)
}

// forwardToDownstream 处理上一跳的一个数据包。from 要先经过
// fxpUDPNormalizeAddrPort；pooled 时 packet.payload 的所有权一并交给这里。
func (s *udpDirectRelaySession) forwardToDownstream(from netip.AddrPort, packet fxpUDPPacket, pooled bool) {
	payload, pooled, ok := s.dataFragments.acceptOwned(packet, &s.replay.window, pooled)
	if !ok {
		return
	}
	// 回程地址跟着上一跳走，规则同出口（udpDirectExitSession.acceptedFrom）。
	s.replay.observe(packet.sentAt)
	highest := s.replay.window.highestSequence() == packet.sequence
	if s.upstreamMigration.observeAddrPort(from, s.upstreamAddrPort(), packet.sequence, highest, time.Now()) {
		next := newUDPPeerFromAddrPort(from)
		previous := s.upstreamRef.Swap(next)
		var previousAddr *net.UDPAddr
		if previous != nil {
			previousAddr = previous.addr
		}
		fxpVerbosef("relay udp direct session upstream moved tunnel=%d rule=%d session=%d from=%s to=%s", s.cfg.TunnelID, s.ruleID, s.sessionID, previousAddr, next.addr)
	}
	s.touch()
	select {
	case <-s.done:
		recycleFXPUDPPayload(payload, pooled)
		return
	default:
		if s.downstreamSend.enqueueOwned(payload, pooled) {
			fxpUDPDropLog.Printf("relay udp direct downstream queue congested tunnel=%d rule=%d upstream=%s downstream=%s; packet dropped", s.cfg.TunnelID, s.ruleID, s.upstream(), s.downstreamAddr)
		}
	}
}

func (s *udpDirectRelaySession) downstreamWriteLoop() {
	defer observeFXPUDPSequence(&s.downstreamSeq)
	ws := newFXPUDPWorkspace()
	for {
		packet, ok := s.downstreamSend.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.downstreamSend.pending()) {
			fxpUDPDropLog.Printf("relay udp direct downstream packet expired tunnel=%d rule=%d upstream=%s downstream=%s; dropping stale packet", s.cfg.TunnelID, s.ruleID, s.upstream(), s.downstreamAddr)
			packet.done()
			continue
		}
		s.writeDownstream(packet.payload, ws)
		packet.done()
	}
}

func (s *udpDirectRelaySession) writeDownstream(payload []byte, ws *fxpUDPWorkspace) {
	var writeErr error
	err := sealFXPUDPDatagramsEach(fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   s.cfg.TunnelID,
		ruleID:     s.ruleID,
		sessionID:  s.sessionID,
		payload:    payload,
	}, s.downstreamDataSealer, &s.downstreamSeq, ws, func(wire []byte) error {
		_, writeErr = s.conn.WriteToUDP(wire, s.downstreamAddr)
		return writeErr
	})
	if writeErr != nil {
		log.Printf("relay udp direct downstream write failed tunnel=%d rule=%d downstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.downstreamAddr, writeErr)
		s.close()
		return
	}
	if err != nil {
		log.Printf("relay udp direct downstream seal failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.upstream(), err)
		s.close()
		return
	}
	s.touch()
}

// forwardToUpstream 处理下一跳的一个回包。pooled 时 packet.payload 的所有权一并交给这里。
func (s *udpDirectRelaySession) forwardToUpstream(packet fxpUDPPacket, pooled bool) {
	payload, pooled, ok := s.returnFragments.acceptOwned(packet, &s.returnReplay, pooled)
	if !ok {
		return
	}
	s.touch()
	select {
	case <-s.done:
		recycleFXPUDPPayload(payload, pooled)
		return
	default:
		if s.upstreamSend.enqueueOwned(payload, pooled) {
			fxpUDPDropLog.Printf("relay udp direct upstream queue congested tunnel=%d rule=%d upstream=%s; packet dropped", s.cfg.TunnelID, s.ruleID, s.upstream())
		}
	}
}

func (s *udpDirectRelaySession) upstreamWriteLoop() {
	defer observeFXPUDPSequence(&s.upstreamSeq)
	ws := newFXPUDPWorkspace()
	for {
		packet, ok := s.upstreamSend.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.upstreamSend.pending()) {
			fxpUDPDropLog.Printf("relay udp direct upstream packet expired tunnel=%d rule=%d upstream=%s; dropping stale packet", s.cfg.TunnelID, s.ruleID, s.upstream())
			packet.done()
			continue
		}
		s.writeUpstream(packet.payload, ws)
		packet.done()
	}
}

func (s *udpDirectRelaySession) writeUpstream(payload []byte, ws *fxpUDPWorkspace) {
	// 一个包的几片发往同一个回程地址，回程迁移不会把一个包拆到两个地址上。
	upstream := s.upstream()
	var writeErr error
	err := sealFXPUDPDatagramsEach(fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   s.cfg.TunnelID,
		ruleID:     s.ruleID,
		sessionID:  s.sessionID,
		payload:    payload,
	}, s.upstreamReturnSealer, &s.upstreamSeq, ws, func(wire []byte) error {
		_, writeErr = s.conn.WriteToUDP(wire, upstream)
		return writeErr
	})
	if writeErr != nil {
		log.Printf("relay udp direct upstream write failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, upstream, writeErr)
		s.close()
		return
	}
	if err != nil {
		log.Printf("relay udp direct upstream seal failed tunnel=%d rule=%d upstream=%s: %v", s.cfg.TunnelID, s.ruleID, s.upstream(), err)
		s.close()
		return
	}
	s.touch()
}

func (s *udpDirectRelaySession) close() {
	s.closeOnce.Do(func() {
		observeFXPUDPSequence(&s.downstreamSeq)
		observeFXPUDPSequence(&s.upstreamSeq)
		close(s.done)
		s.downstreamSend.close()
		s.upstreamSend.close()
		s.dataFragments.close()
		s.returnFragments.close()
		if s.remove != nil {
			s.remove(s)
		}
		fxpUDPReplayGuard.release(s.replayKey, s.replay, time.Now())
	})
}

// recycleFXPUDPPayload 还掉一个借来的明文缓冲；不是借来的就什么都不做。
func recycleFXPUDPPayload(payload []byte, pooled bool) {
	if pooled {
		putFXPByteBuffer(payload)
	}
}

func pickUDPDirectEndpoint(selector *exitEndpointSelector, cfg config, selectionKey string) (exitEndpoint, int, *net.UDPAddr, error) {
	if selector == nil || selector.count() == 0 {
		return exitEndpoint{}, -1, nil, errors.New("no exit endpoints")
	}
	attempted := map[int]bool{}
	var lastErr error
	for len(attempted) < selector.count() {
		endpoint, index, ok := selector.pick(attempted, selectionKey)
		if !ok {
			break
		}
		attempted[index] = true
		udpPort := endpoint.UDPPort
		if udpPort <= 0 {
			udpPort = endpoint.Port
		}
		// 这里在 UDP 读循环里：不等 DNS。还没解析好的端点先跳过（不记失败），
		// 有别的端点就用别的，都没有就丢掉这个包，等后台解析完。
		address, err := resolveHopAddressNonBlocking(endpoint.Host, udpPort)
		var addr *net.UDPAddr
		if err == nil {
			addr, err = net.ResolveUDPAddr("udp", address)
		}
		if errors.Is(err, errHopResolvePending) {
			if lastErr == nil {
				lastErr = err
			}
			continue
		}
		if err != nil {
			lastErr = err
			selector.markFailure(index, err)
			continue
		}
		selector.markResolved(index)
		return endpoint, index, addr, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no exit endpoint available")
	}
	return exitEndpoint{}, -1, nil, lastErr
}

func newFXPUDPCodec(key string, packet fxpUDPPacket) (*fxpUDPCodec, error) {
	if err := validateFXPUDPContext(packet); err != nil {
		return nil, err
	}
	aead, err := fxpUDPAEAD(key, packet)
	if err != nil {
		return nil, err
	}
	return &fxpUDPCodec{
		packetType: packet.packetType,
		tunnelID:   packet.tunnelID,
		ruleID:     packet.ruleID,
		sessionID:  packet.sessionID,
		aead:       aead,
	}, nil
}

func (c *fxpUDPCodec) matches(packet fxpUDPPacket) bool {
	return c != nil && c.aead != nil &&
		packet.packetType == c.packetType &&
		packet.tunnelID == c.tunnelID &&
		packet.ruleID == c.ruleID &&
		packet.sessionID == c.sessionID
}

// fxpUDPWorkspace 是一个收发协程独占的临时区，热路径上反复用：
//   - nonce：AEAD 是接口，传给它的随机数切片逃不出编译器的眼睛，放在栈上的数组
//     每次调用都会被挪到堆上。放在这个早就在堆上的结构里，就只分配一次。
//   - wire：封好的一片在写进 socket 之前待的地方，写完下一片接着用。
//
// 一个 workspace 只能给一个协程用。
type fxpUDPWorkspace struct {
	nonce [12]byte
	wire  []byte
}

func newFXPUDPWorkspace() *fxpUDPWorkspace {
	return &fxpUDPWorkspace{wire: make([]byte, 0, fxpUDPMaxWirePacketSize)}
}

func (c *fxpUDPCodec) sealPacket(packet fxpUDPPacket) ([]byte, error) {
	var nonce [12]byte
	return c.sealPacketInto(nil, packet, &nonce)
}

// sealPacketInto 把一片封进 dst 的底层数组（容量不够才新分配），返回封好的线上字节。
func (c *fxpUDPCodec) sealPacketInto(dst []byte, packet fxpUDPPacket, nonce *[12]byte) ([]byte, error) {
	if !c.matches(packet) {
		return nil, errors.New("udp packet does not match cached encryption context")
	}
	if len(packet.payload) > fxpUDPMaxSinglePayload {
		return nil, fmt.Errorf("udp payload too large: %d", len(packet.payload))
	}
	if packet.sentAt == 0 {
		packet.sentAt = fxpUDPSentAtNow()
	}
	wireSize := fxpUDPHeaderSize + len(packet.payload) + c.aead.Overhead()
	if cap(dst) < wireSize {
		dst = make([]byte, 0, wireSize)
	}
	wire := dst[:fxpUDPHeaderSize]
	if err := writeFXPUDPHeader(wire, packet); err != nil {
		return nil, err
	}
	*nonce = [12]byte{}
	fillFXPUDPNonce(nonce[:], packet.sequence, packet.fragment)
	return c.aead.Seal(wire, nonce[:], packet.payload, wire[:fxpUDPHeaderSize]), nil
}

func sealFXPUDPPacket(packet fxpUDPPacket, key string) ([]byte, error) {
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		return nil, err
	}
	return codec.sealPacket(packet)
}

func parseFXPUDPHeader(raw []byte) (fxpUDPPacket, error) {
	if len(raw) < fxpUDPHeaderSize+fxpUDPAuthTagSize {
		return fxpUDPPacket{}, errors.New("udp packet too small")
	}
	if !fxpUDPHasMagic(raw) || raw[4] != fxpUDPVersion {
		return fxpUDPPacket{}, errors.New("invalid udp packet header")
	}
	// 隧道号不在包头里：调用方按自己的配置填（密钥派生里带着它，填错了解不开）。
	packet := fxpUDPPacket{
		packetType: raw[5],
		fragment:   raw[6],
		fragments:  raw[7],
		sentAt:     binary.BigEndian.Uint32(raw[8:12]),
		ruleID:     int(binary.BigEndian.Uint32(raw[12:16])),
		sessionID:  binary.BigEndian.Uint64(raw[16:24]),
		sequence:   binary.BigEndian.Uint64(raw[24:32]),
	}
	if err := validateFXPUDPPacket(packet); err != nil {
		return fxpUDPPacket{}, err
	}
	return packet, nil
}

func (c *fxpUDPCodec) openParsedPacket(raw []byte, packet fxpUDPPacket) (fxpUDPPacket, error) {
	var nonce [12]byte
	return c.openParsedPacketInto(nil, raw, packet, &nonce)
}

// openParsedPacketInto 把明文解到 dst 的底层数组上（容量不够才新分配）。dst 不能
// 和 raw 重叠：raw 是读循环反复用的收包缓冲，明文还要进队列。
func (c *fxpUDPCodec) openParsedPacketInto(dst []byte, raw []byte, packet fxpUDPPacket, nonce *[12]byte) (fxpUDPPacket, error) {
	if !c.matches(packet) {
		return fxpUDPPacket{}, errors.New("udp packet does not match cached decryption context")
	}
	*nonce = [12]byte{}
	fillFXPUDPNonce(nonce[:], packet.sequence, packet.fragment)
	payload, err := c.aead.Open(dst[:0], nonce[:], raw[fxpUDPHeaderSize:], raw[:fxpUDPHeaderSize])
	if err != nil {
		return fxpUDPPacket{}, errors.New("invalid udp packet authentication")
	}
	packet.payload = payload
	return packet, nil
}

// openParsedPacketPooled 把包解到一块从 fxpBytePools 借的缓冲上。成功时
// packet.payload 就是借来的缓冲，调用方负责还（或者连同所有权交给队列）；
// 失败时缓冲已经还了。以前每个包解密都新分配一块明文。
func (c *fxpUDPCodec) openParsedPacketPooled(raw []byte, packet fxpUDPPacket, ws *fxpUDPWorkspace) (fxpUDPPacket, error) {
	size := len(raw) - fxpUDPHeaderSize - fxpUDPAuthTagSize
	if size < 0 {
		return fxpUDPPacket{}, errors.New("udp packet too small")
	}
	plain := getFXPByteBuffer(size)
	opened, err := c.openParsedPacketInto(plain, raw, packet, &ws.nonce)
	if err != nil {
		putFXPByteBuffer(plain)
		return fxpUDPPacket{}, err
	}
	return opened, nil
}

// openPacketPooled 是 openPacket 的借缓冲版本，规则同 openParsedPacketPooled。
func (c *fxpUDPCodec) openPacketPooled(raw []byte, ws *fxpUDPWorkspace) (fxpUDPPacket, error) {
	packet, err := parseFXPUDPHeader(raw)
	if err != nil {
		return fxpUDPPacket{}, err
	}
	if c != nil {
		packet.tunnelID = c.tunnelID
	}
	return c.openParsedPacketPooled(raw, packet, ws)
}

func (c *fxpUDPCodec) openPacket(raw []byte) (fxpUDPPacket, error) {
	packet, err := parseFXPUDPHeader(raw)
	if err != nil {
		return fxpUDPPacket{}, err
	}
	if c != nil {
		packet.tunnelID = c.tunnelID
	}
	return c.openParsedPacket(raw, packet)
}

func openFXPUDPPacket(raw []byte, tunnelID int, key string) (fxpUDPPacket, error) {
	packet, err := parseFXPUDPHeader(raw)
	if err != nil {
		return fxpUDPPacket{}, err
	}
	packet.tunnelID = tunnelID
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		return fxpUDPPacket{}, err
	}
	return codec.openParsedPacket(raw, packet)
}

func validateFXPUDPContext(packet fxpUDPPacket) error {
	if packet.packetType != fxpUDPTypeData && packet.packetType != fxpUDPTypeReturn {
		return errors.New("invalid udp packet type")
	}
	if packet.tunnelID < 0 || packet.ruleID < 0 || packet.sessionID == 0 {
		return errors.New("invalid udp packet fields")
	}
	return nil
}

func validateFXPUDPPacket(packet fxpUDPPacket) error {
	if err := validateFXPUDPContext(packet); err != nil {
		return err
	}
	if packet.sequence == 0 {
		return errors.New("invalid udp packet fields")
	}
	if !validFXPUDPFragmentMetadata(packet.fragment, packet.fragments) {
		return errors.New("invalid udp fragment metadata")
	}
	return nil
}

func fxpUDPHeader(packet fxpUDPPacket) ([]byte, error) {
	if err := validateFXPUDPPacket(packet); err != nil {
		return nil, err
	}
	header := make([]byte, fxpUDPHeaderSize)
	if err := writeFXPUDPHeader(header, packet); err != nil {
		return nil, err
	}
	return header, nil
}

func writeFXPUDPHeader(header []byte, packet fxpUDPPacket) error {
	if len(header) < fxpUDPHeaderSize {
		return errors.New("udp header buffer too small")
	}
	if err := validateFXPUDPPacket(packet); err != nil {
		return err
	}
	copy(header[0:4], []byte(fxpUDPMagic))
	header[4] = fxpUDPVersion
	header[5] = packet.packetType
	header[6] = packet.fragment
	header[7] = packet.fragments
	binary.BigEndian.PutUint32(header[8:12], packet.sentAt)
	binary.BigEndian.PutUint32(header[12:16], uint32(packet.ruleID))
	binary.BigEndian.PutUint64(header[16:24], packet.sessionID)
	binary.BigEndian.PutUint64(header[24:32], packet.sequence)
	return nil
}

func fxpUDPAEAD(key string, packet fxpUDPPacket) (cipher.AEAD, error) {
	if key == "" {
		return nil, errors.New("empty udp key")
	}
	context := make([]byte, 1+4+4+8)
	context[0] = packet.packetType
	binary.BigEndian.PutUint32(context[1:5], uint32(packet.tunnelID))
	binary.BigEndian.PutUint32(context[5:9], uint32(packet.ruleID))
	binary.BigEndian.PutUint64(context[9:17], packet.sessionID)
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte("forwardx-fxp-udp-v4/aead/"))
	_, _ = mac.Write(context)
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func fxpUDPNonce(sequence uint64, fragment uint8) []byte {
	nonce := make([]byte, 12)
	fillFXPUDPNonce(nonce, sequence, fragment)
	return nonce
}

func fillFXPUDPNonce(nonce []byte, sequence uint64, fragment uint8) {
	if len(nonce) < 12 {
		return
	}
	nonce[3] = fragment
	binary.BigEndian.PutUint64(nonce[4:], sequence)
}

func fxpUDPHasMagic(raw []byte) bool {
	return len(raw) >= fxpUDPHeaderSize && string(raw[0:4]) == fxpUDPMagic
}

func fxpUDPSessionID(raw []byte) (uint64, bool) {
	if !fxpUDPHasMagic(raw) || raw[4] != fxpUDPVersion {
		return 0, false
	}
	return binary.BigEndian.Uint64(raw[16:24]), true
}

func packetMatchesConfig(packet fxpUDPPacket, cfg config) bool {
	if packet.tunnelID != cfg.TunnelID {
		return false
	}
	return cfg.RuleID <= 0 || packet.ruleID == cfg.RuleID
}

func udpTargetForRule(cfg config, ruleID int) (udpTarget, bool) {
	for _, target := range cfg.UDPTargets {
		if target.RuleID == ruleID {
			return target, true
		}
	}
	return udpTarget{}, false
}

func udpEndpointKey(endpoint exitEndpoint, fallback string) string {
	if endpoint.Key != "" {
		return endpoint.Key
	}
	return fallback
}

func randomUint64() (uint64, error) {
	var b [8]byte
	for i := 0; i < 4; i++ {
		if _, err := rand.Read(b[:]); err != nil {
			return 0, err
		}
		value := binary.BigEndian.Uint64(b[:])
		if value != 0 {
			return value, nil
		}
	}
	return 0, errors.New("random session id is zero")
}

// udpRuleSessionKey 是出口、中转找会话用的键。故意不带来源地址：带上的话，换个
// 来源地址重放一个旧包就能凭空造出一个窗口为空的新会话。
//
// 用可比较的结构体当 map 的键：以前拼成字符串，读循环里每个包都要格式化两个
// 数字再拼接（三次分配），现在一次都没有。
type udpRuleSessionKey struct {
	ruleID    int
	sessionID uint64
}

// compare 只给容量回收排序时打破平局用，保证结果稳定。
func (k udpRuleSessionKey) compare(other udpRuleSessionKey) int {
	switch {
	case k.ruleID < other.ruleID:
		return -1
	case k.ruleID > other.ruleID:
		return 1
	case k.sessionID < other.sessionID:
		return -1
	case k.sessionID > other.sessionID:
		return 1
	}
	return 0
}

func (k udpRuleSessionKey) String() string {
	return strconv.Itoa(k.ruleID) + "|" + strconv.FormatUint(k.sessionID, 10)
}

// fxpUDPNormalizeAddrPort 把 ReadFromUDPAddrPort 读到的地址规整成可以直接比较
// 的形式。双栈监听收到的 IPv4 来源是 ::ffff:a.b.c.d，而配置里解析出来的地址是
// 纯 IPv4；以前 net.IP.Equal 把两者当成一样，netip 不会，所以统一去掉映射前缀。
func fxpUDPNormalizeAddrPort(addr netip.AddrPort) netip.AddrPort {
	if !addr.IsValid() {
		return netip.AddrPort{}
	}
	return netip.AddrPortFrom(addr.Addr().Unmap(), addr.Port())
}

// fxpUDPAddrPortOf 把 *net.UDPAddr 转成规整过的 netip.AddrPort，nil 得到零值。
func fxpUDPAddrPortOf(addr *net.UDPAddr) netip.AddrPort {
	if addr == nil {
		return netip.AddrPort{}
	}
	return fxpUDPNormalizeAddrPort(addr.AddrPort())
}

// fxpUDPSourceIP 是按来源 IP 计数用的键：和以前的 IP.String() 一样不区分 zone。
func fxpUDPSourceIP(addr netip.AddrPort) netip.Addr {
	return addr.Addr().WithZone("")
}

// fxpUDPSentAtNow 是写进包头的发出时间。
func fxpUDPSentAtNow() uint32 {
	return uint32(time.Now().Unix())
}
