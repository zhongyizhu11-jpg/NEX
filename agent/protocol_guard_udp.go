package main

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// protocolGuardUDPEvictMinIdle：会话数到上限时，只有空闲至少这么久的最久未用会话
// 才会被挤掉给新来源。正在收发的会话不会被一波新来源（扫描、伪造源地址）冲掉；
// DNS/QUIC 这种一问一答后就闲着的会话能尽快让位，而不是像以前那样新来源一律被丢。
const protocolGuardUDPEvictMinIdle = 10 * time.Second

// protocolGuardUDPReadBuffer：守护 UDP 监听只有一个读协程，突发时内核默认的
// 接收缓冲（常见 208 KiB）很快溢出丢包；调大失败（超过 rmem_max）就保持默认。
const protocolGuardUDPReadBuffer = 4 << 20

type protocolGuardUDPSession struct {
	target net.Conn
	// batch 是目标套接字的批量收发句柄（Linux），nil 就逐包收发。
	batch *udpBatchConn
	// last 是最近一次收发的 UnixNano。回包方向每个包都要更新，用原子量避免
	// 每个包都去抢整张会话表的锁。
	last atomic.Int64
}

func (session *protocolGuardUDPSession) touch(now time.Time) {
	session.last.Store(now.UnixNano())
}

func (session *protocolGuardUDPSession) idleFor(now time.Time) time.Duration {
	return now.Sub(time.Unix(0, session.last.Load()))
}

// evictProtocolGuardUDPSessionLocked 在会话数到上限时挤掉空闲最久、且空闲超过
// protocolGuardUDPEvictMinIdle 的会话。调用方持有 sessionMu。返回被挤掉的会话
// （调用方在锁外关闭它的连接），没有可挤的返回 nil。键的类型不限：会话表以来源地址
// （netip.AddrPort）为键，测试用字符串键。
func evictProtocolGuardUDPSessionLocked[K comparable](sessions map[K]*protocolGuardUDPSession, now time.Time) *protocolGuardUDPSession {
	var oldestKey K
	var oldest *protocolGuardUDPSession
	var oldestLast int64
	for key, session := range sessions {
		last := session.last.Load()
		if oldest == nil || last < oldestLast {
			oldestKey, oldest, oldestLast = key, session, last
		}
	}
	if oldest == nil || oldest.idleFor(now) < protocolGuardUDPEvictMinIdle {
		return nil
	}
	delete(sessions, oldestKey)
	return oldest
}

func (s *protocolGuardServer) serveUDP() {
	// 会话表以来源地址（值类型）为键：每个包不再 clientAddr.String()，也不再分配 net.Addr。
	sessions := map[netip.AddrPort]*protocolGuardUDPSession{}
	var sessionMu sync.Mutex
	closeSessions := func() {
		sessionMu.Lock()
		defer sessionMu.Unlock()
		for key, session := range sessions {
			_ = session.target.Close()
			delete(sessions, key)
		}
	}
	cleanupTicker := time.NewTicker(30 * time.Second)
	stopCleanup := make(chan struct{})
	defer func() {
		close(stopCleanup)
		cleanupTicker.Stop()
		closeSessions()
	}()
	go func() {
		for {
			select {
			case <-s.done:
				closeSessions()
				return
			case <-stopCleanup:
				return
			case <-cleanupTicker.C:
				now := time.Now()
				sessionMu.Lock()
				for key, session := range sessions {
					if session.idleFor(now) <= protocolGuardUDPIdleTimeout {
						continue
					}
					_ = session.target.Close()
					delete(sessions, key)
				}
				sessionMu.Unlock()
			}
		}
	}()

	var backoff serveLoopBackoff
	// Linux 上一次系统调用收一批（recvmmsg），见 udp_batch_linux.go。
	if listener := newUDPBatchConn(s.udpConn); listener != nil {
		s.serveUDPBatch(listener, sessions, &sessionMu, &backoff)
		return
	}
	udpConn, _ := s.udpConn.(*net.UDPConn)
	buf := make([]byte, 65535)
	for {
		var n int
		var client netip.AddrPort
		var err error
		if udpConn != nil {
			n, client, err = udpConn.ReadFromUDPAddrPort(buf)
		} else {
			var addr net.Addr
			n, addr, err = s.udpConn.ReadFrom(buf)
			if udpAddr, ok := addr.(*net.UDPAddr); ok {
				client = udpAddr.AddrPort()
			}
		}
		if err != nil {
			if s.handleUDPReadError(err, &backoff) {
				return
			}
			continue
		}
		backoff.success()
		if n <= 0 || !client.IsValid() {
			continue
		}
		// The loop consumes the packet synchronously before the next ReadFrom,
		// so the read buffer remains valid for the target Write. Avoid a heap
		// allocation for every datagram on high-PPS UDP rules.
		packet := buf[:n]
		// 限速等待留在读协程里：它就是这条规则入方向的背压，挪到每个会话各自的
		// 队列里要额外的缓冲和排队丢包策略，收益不大。
		if err := s.waitRate(s.ctx, protocolGuardRateIn, len(packet)); err != nil {
			select {
			case <-s.done:
				return
			default:
			}
			continue
		}
		now := time.Now()
		session := s.udpSessionFor(client, now, sessions, &sessionMu, nil)
		if session == nil {
			continue
		}
		session.touch(now)
		if _, err := session.target.Write(packet); err != nil {
			s.failUDPSession(client, session, sessions, &sessionMu, err)
		}
	}
}

// handleUDPReadError 处理监听读出错，返回 true 表示读循环该退出。
func (s *protocolGuardServer) handleUDPReadError(err error, backoff *serveLoopBackoff) bool {
	exit, fatal := serveLoopHandleError(s.done, backoff, err, func(err error, suppressed int) {
		logf("protocol guard udp read rule=%d suppressed=%d: %v", s.rule.RuleID, suppressed, err)
	})
	if fatal {
		s.abandonAfterServeFailure("udp read", err)
	}
	return exit
}

// serveUDPBatch 是 serveUDP 的批量版：一次收一批，同一来源连着的几个包一次写到它的目标。
func (s *protocolGuardServer) serveUDPBatch(listener *udpBatchConn, sessions map[netip.AddrPort]*protocolGuardUDPSession, sessionMu *sync.Mutex, backoff *serveLoopBackoff) {
	for {
		batch, n, err := listener.recv()
		if err != nil {
			if s.handleUDPReadError(err, backoff) {
				return
			}
			continue
		}
		backoff.success()
		now := time.Now()
		start := 0
		for i := 1; i <= n; i++ {
			if i < n && batch.addr(i) == batch.addr(start) {
				continue
			}
			if !s.forwardUDPRun(batch, start, i, now, sessions, sessionMu, listener) {
				putUDPBatch(batch)
				return
			}
			start = i
		}
		putUDPBatch(batch)
	}
}

// forwardUDPRun 把同一来源连着的 [from, to) 几个包写到它的会话目标；几个包就一次 sendmmsg。
// 返回 false 表示守护正在收尾，读循环该退出。
func (s *protocolGuardServer) forwardUDPRun(batch *udpBatch, from int, to int, now time.Time, sessions map[netip.AddrPort]*protocolGuardUDPSession, sessionMu *sync.Mutex, listener *udpBatchConn) bool {
	// 限速等待照旧逐包做（限速器全规则共享、可热换，没限速时立刻返回）。等不成只在收尾
	// 时发生：这一串包丢掉。
	for i := from; i < to; i++ {
		if err := s.waitRate(s.ctx, protocolGuardRateIn, len(batch.packet(i))); err != nil {
			select {
			case <-s.done:
				return false
			default:
			}
			return true
		}
	}
	if s.rateLimiter(protocolGuardRateIn) != nil {
		// 等过限速器，时间戳按等完的时刻记。
		now = time.Now()
	}
	client := batch.addr(from)
	session := s.udpSessionFor(client, now, sessions, sessionMu, listener)
	if session == nil {
		return true
	}
	session.touch(now)
	var err error
	if to-from > 1 && session.batch != nil {
		err = session.batch.send(batch, from, to)
	} else {
		for i := from; i < to; i++ {
			if _, err = session.target.Write(batch.packet(i)); err != nil {
				break
			}
		}
	}
	if err != nil {
		s.failUDPSession(client, session, sessions, sessionMu, err)
	}
	return true
}

// udpSessionFor 查来源对应的会话，没有就建一个。
func (s *protocolGuardServer) udpSessionFor(client netip.AddrPort, now time.Time, sessions map[netip.AddrPort]*protocolGuardUDPSession, sessionMu *sync.Mutex, listener *udpBatchConn) *protocolGuardUDPSession {
	sessionMu.Lock()
	session := sessions[client]
	sessionMu.Unlock()
	if session != nil {
		return session
	}
	return s.openUDPSession(client, now, sessions, sessionMu, listener)
}

// failUDPSession 在往目标写失败后关掉这个会话：下一个包重新拨。
func (s *protocolGuardServer) failUDPSession(client netip.AddrPort, session *protocolGuardUDPSession, sessions map[netip.AddrPort]*protocolGuardUDPSession, sessionMu *sync.Mutex, err error) {
	sessionMu.Lock()
	if sessions[client] == session {
		delete(sessions, client)
	}
	sessionMu.Unlock()
	_ = session.target.Close()
	if shouldLogAgentReport(fmt.Sprintf("protocol-guard-udp-write:%d", s.rule.RuleID), agentReportLogInterval) {
		logf("protocol guard udp write target rule=%d client=%s: %v", s.rule.RuleID, client, err)
	}
}

// openUDPSession 为新来源建会话。拨号在锁外做：以前拨号时一直拿着 sessionMu，
// 期间所有会话的回包协程更新时间戳、清理协程都得等它。
func (s *protocolGuardServer) openUDPSession(key netip.AddrPort, now time.Time, sessions map[netip.AddrPort]*protocolGuardUDPSession, sessionMu *sync.Mutex, listener *udpBatchConn) *protocolGuardUDPSession {
	sessionMu.Lock()
	full := len(sessions) >= protocolGuardUDPMaxSessions
	sessionMu.Unlock()
	// 这条规则到上限，或者全进程的 UDP 中继会话到顶（udp_session_budget.go）：都先在这条规则
	// 里按 LRU 腾位置，腾不出来就不拨。
	if (full || udpRelayGlobalFull()) && !s.makeUDPSessionRoom(sessions, sessionMu, now) {
		return nil
	}
	target, err := net.DialTimeout("udp", net.JoinHostPort(s.rule.TargetIP, strconv.Itoa(s.rule.TargetPort)), 10*time.Second)
	if err != nil {
		if shouldLogAgentReport(fmt.Sprintf("protocol-guard-udp-dial:%d", s.rule.RuleID), agentReportLogInterval) {
			logf("protocol guard udp dial target rule=%d: %v", s.rule.RuleID, err)
		}
		return nil
	}
	session := &protocolGuardUDPSession{target: target}
	if listener != nil {
		session.batch = newUDPBatchConn(target)
	}
	session.touch(now)
	sessionMu.Lock()
	if existing := sessions[key]; existing != nil {
		// 拨号期间已经有人建好了同一来源的会话：用现成的，关掉多拨的这条。
		sessionMu.Unlock()
		_ = target.Close()
		return existing
	}
	var evicted *protocolGuardUDPSession
	if len(sessions) >= protocolGuardUDPMaxSessions {
		evicted = evictProtocolGuardUDPSessionLocked(sessions, now)
		if evicted == nil {
			sessionMu.Unlock()
			_ = target.Close()
			s.noteUDPSessionLimit(false)
			return nil
		}
	}
	sessions[key] = session
	sessionMu.Unlock()
	if evicted != nil {
		_ = evicted.target.Close()
		s.noteUDPSessionLimit(true)
	}
	runUDPRelaySession(func() { s.copyUDPToClient(key, session, sessions, sessionMu, listener) })
	return session
}

// makeUDPSessionRoom 在拨号前先腾位置，腾不出来就不必白拨一次。
func (s *protocolGuardServer) makeUDPSessionRoom(sessions map[netip.AddrPort]*protocolGuardUDPSession, sessionMu *sync.Mutex, now time.Time) bool {
	sessionMu.Lock()
	if len(sessions) < protocolGuardUDPMaxSessions && !udpRelayGlobalFull() {
		sessionMu.Unlock()
		return true
	}
	evicted := evictProtocolGuardUDPSessionLocked(sessions, now)
	sessionMu.Unlock()
	if evicted == nil {
		s.noteUDPSessionLimit(false)
		return false
	}
	_ = evicted.target.Close()
	s.noteUDPSessionLimit(true)
	return true
}

// noteUDPSessionLimit 记一次「到上限」：回收了一个会话（evicted）还是拒掉了新会话，计数随心跳上报。
func (s *protocolGuardServer) noteUDPSessionLimit(evicted bool) {
	if evicted {
		noteUDPRelaySessionEvicted()
	} else {
		noteUDPRelaySessionRejected()
	}
	if !shouldLogAgentReport(fmt.Sprintf("protocol-guard-udp-session-limit:%d", s.rule.RuleID), agentReportLogInterval) {
		return
	}
	if evicted {
		logf("protocol guard udp session limit reached rule=%d sessions=%d processSessions=%d processCap=%d; evicted least recently used idle session", s.rule.RuleID, protocolGuardUDPMaxSessions, udpRelaySessionsActive.Load(), udpRelayGlobalSessionCap())
		return
	}
	logf("protocol guard udp session limit reached rule=%d sessions=%d processSessions=%d processCap=%d", s.rule.RuleID, protocolGuardUDPMaxSessions, udpRelaySessionsActive.Load(), udpRelayGlobalSessionCap())
}

func (s *protocolGuardServer) copyUDPToClient(key netip.AddrPort, session *protocolGuardUDPSession, sessions map[netip.AddrPort]*protocolGuardUDPSession, sessionMu *sync.Mutex, listener *udpBatchConn) {
	target := session.target
	// 目标和监听都有批量句柄（Linux）就一次收一批、一次 sendmmsg 原路写回；等回包期间不占缓冲。
	// 否则逐包：一个会话常驻一个 64 KiB 缓冲。
	batched := session.batch != nil && listener != nil
	var buf []byte
	if !batched {
		buf = getAgentByteBuffer(65535)
		defer putAgentByteBuffer(buf)
	}
	udpConn, _ := s.udpConn.(*net.UDPConn)
	// client 只给监听不是 *net.UDPConn 的情况（测试替身）回包用；正常路径用 key 直接回。
	var client net.Addr
	if udpConn == nil {
		client = net.UDPAddrFromAddrPort(key)
	}
	for {
		_ = target.SetReadDeadline(time.Now().Add(protocolGuardUDPIdleTimeout))
		if batched {
			batch, n, err := session.batch.recv()
			if err != nil {
				break
			}
			// 出方向的限速照旧逐包等。
			waited := true
			for i := 0; i < n; i++ {
				if err := s.waitRate(s.ctx, protocolGuardRateOut, len(batch.packet(i))); err != nil {
					waited = false
					break
				}
			}
			if waited {
				_ = listener.sendTo(batch, n, key)
			}
			putUDPBatch(batch)
			if !waited {
				break
			}
		} else {
			n, err := target.Read(buf)
			if err != nil {
				break
			}
			if n > 0 {
				if err := s.waitRate(s.ctx, protocolGuardRateOut, n); err != nil {
					break
				}
				if udpConn != nil {
					_, _ = udpConn.WriteToUDPAddrPort(buf[:n], key)
				} else {
					_, _ = s.udpConn.WriteTo(buf[:n], client)
				}
			}
		}
		// 会话被挤掉或清理后连接已关闭，下一次 Read 会出错退出；这里更新一个
		// 已经不在表里的会话时间戳没有副作用，所以不用再拿锁核对。
		session.touch(time.Now())
	}
	sessionMu.Lock()
	if sessions[key] == session {
		delete(sessions, key)
	}
	sessionMu.Unlock()
	_ = target.Close()
}
