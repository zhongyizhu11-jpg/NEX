package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

/*
线路组的 UDP 调度（规格 protocol 为 udp 或 both 时由 startFailoverProxyLocked 开起来）。

TCP 那边一条连接挑一次路径（handleConn）。UDP 没有连接，这里用「会话」代替：以来源地址为键
（前面的转发工具连过来的 127.0.0.1:端口；gost / realm / socat / nginx 都是一个访客一个套接字），
会话第一次出现时挑一条路径、拨一个 UDP 套接字过去，之后这个来源的包都走它，回包原路写回去。
两个方向都安静够久就回收；回收以后再来包算新会话，重新挑。

和 TCP 一样的地方：
  - 挑路径的规则是同一份（pickTargetForKey）：主备走当前那条，权重 / 轮流 / 随机按会话分，
    按访客固定按来源地址哈希；
  - 会话的上游套接字记在 conns 上：面板上「这条路径几个连接」对 UDP 就是几个会话；快速故障
    转移 / 强制切换断旧连接时它们一起被关，关掉以后这个来源的下一个包重新挑路径 —— UDP 版的
    「断开让客户端重连」。

不一样的地方：拨 UDP 不会因为对端不通而失败（没有握手），真实流量给不出「这条不通」的信号，
健康只看探测：没填探测地址的路径 ping 拨号地址的主机（failoverProbeTarget）。
*/

const (
	// 两个方向都没包多久算会话结束。前面的 gost 自己的 UDP 会话 30 秒回收，这里放宽：
	// 回收早了只是多挑一次路径，回收晚了只是多占一个套接字。
	failoverUDPIdleTimeout = 2 * time.Minute
	// 会话上限。到了上限不丢新会话，而是回收最久没动静的那个：DNS 这类一问一答的流量每个
	// 请求都是新的来源端口，丢新会话等于整条规则停摆。
	failoverUDPMaxSessions  = 4096
	failoverUDPReapInterval = 30 * time.Second
	failoverUDPBufferSize   = 65535
	failoverUDPDialTimeout  = 5 * time.Second
	// 调度器的 UDP 监听只有一个读协程，突发时内核默认接收缓冲（常见 208 KiB）很快溢出丢包。
	// 超过 net.core.rmem_max 时内核会截断或拒绝，失败就保持默认，不影响转发。
	failoverUDPReadBuffer = 4 << 20
	// 前面的转发工具连上调度器以后马上就发 PROXY 头；等这么久还没有，就当没有。
	failoverProxyHeaderTimeout = 5 * time.Second
)

type failoverUDPSession struct {
	key netip.AddrPort
	// client 只给监听不是 *net.UDPConn 的情况（测试替身）回包用；正常路径用 key 直接回。
	client   net.Addr
	upstream net.Conn
	index    int
	// 最近一次有包（两个方向都算）的时刻，UnixNano。
	last atomic.Int64
}

func (s *failoverUDPSession) touch(now time.Time) {
	s.last.Store(now.UnixNano())
}

func (s *failoverUDPSession) idleSince(now time.Time) time.Duration {
	return now.Sub(time.Unix(0, s.last.Load()))
}

// 规格里的协议，归一成 tcp / udp / both；没写的老规格是 tcp。
func failoverProtocol(spec failoverSpec) string {
	return normalizeRuntimeProtocol(spec.Protocol)
}

/*
收掉这个代理：停探测、关监听、关 UDP 会话。

TCP 上已经建立的连接不动，让它们自己走完 —— 和上一版一样。UDP 会话跟着监听一起死（回包
要从监听的那个套接字写回去），所以一并关掉。可以重复调用。
*/
func (p *failoverProxy) retire() {
	p.retireOnce.Do(func() {
		close(p.done)
		if p.ln != nil {
			_ = p.ln.Close()
		}
		if p.udp != nil {
			_ = p.udp.Close()
		}
		p.closeUDPSessions()
	})
}

func (p *failoverProxy) retired() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (p *failoverProxy) closeUDPSessions() {
	p.udpMu.Lock()
	sessions := make([]*failoverUDPSession, 0, len(p.udpSessions))
	for _, session := range p.udpSessions {
		sessions = append(sessions, session)
	}
	p.udpSessions = map[netip.AddrPort]*failoverUDPSession{}
	p.udpMu.Unlock()
	for _, session := range sessions {
		p.untrackConn(session.index, session.upstream)
		_ = session.upstream.Close()
	}
}

func (p *failoverProxy) udpSessionCount() int {
	p.udpMu.RLock()
	defer p.udpMu.RUnlock()
	return len(p.udpSessions)
}

func (p *failoverProxy) serveUDP() {
	stopReaper := make(chan struct{})
	defer close(stopReaper)
	go p.reapUDPSessions(stopReaper)
	// 正常情况下监听是 *net.UDPConn：用 ReadFromUDPAddrPort 拿值类型的来源地址当会话键，
	// 每个包不再分配 *net.UDPAddr 和 client.String()。
	udpConn, _ := p.udp.(*net.UDPConn)
	if udpConn != nil {
		_ = udpConn.SetReadBuffer(failoverUDPReadBuffer)
	}
	buf := make([]byte, failoverUDPBufferSize)
	var backoff serveLoopBackoff
	for {
		var n int
		var client netip.AddrPort
		var err error
		if udpConn != nil {
			n, client, err = udpConn.ReadFromUDPAddrPort(buf)
		} else {
			var addr net.Addr
			n, addr, err = p.udp.ReadFrom(buf)
			if udpAddr, ok := addr.(*net.UDPAddr); ok {
				client = udpAddr.AddrPort()
			}
		}
		if err != nil {
			if p.retired() {
				return
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			// 临时错误退避重试；监听意外关闭则摘掉整个代理等对账重建（以前直接退出，UDP 从此没人收）。
			exit, fatal := serveLoopHandleError(p.done, &backoff, err, func(err error, suppressed int) {
				logf("failover udp read failed rule=%d source=%d suppressed=%d: %v", p.ruleID, p.sourcePort, suppressed, err)
			})
			if fatal {
				p.abandonAfterServeFailure("udp read", err)
			}
			if exit {
				return
			}
			continue
		}
		backoff.success()
		if n <= 0 || !client.IsValid() {
			continue
		}
		// 这个包在下一次 ReadFrom 之前就写出去了，buf 可以复用。
		p.forwardUDPPacket(failoverUDPSessionKey(client), buf[:n])
	}
}

// failoverUDPSessionKey 把双栈监听收到的 IPv4 映射地址（::ffff:a.b.c.d）还原成 IPv4，
// 让会话键的字符串形式和以前 (*net.UDPAddr).String() 完全一样 ——「按访客固定」拿它哈希，
// 换了写法不能让同一个来源换路径。
func failoverUDPSessionKey(client netip.AddrPort) netip.AddrPort {
	if client.Addr().Is4In6() {
		return netip.AddrPortFrom(client.Addr().Unmap(), client.Port())
	}
	return client
}

func (p *failoverProxy) forwardUDPPacket(key netip.AddrPort, packet []byte) {
	for attempt := 0; attempt < 2; attempt++ {
		session := p.udpSessionFor(key)
		if session == nil {
			return
		}
		session.touch(time.Now())
		_, err := session.upstream.Write(packet)
		if err == nil || !errors.Is(err, net.ErrClosed) {
			// 别的写错误（对端回过 ICMP 不可达之类）只丢这一个包：UDP 本来就不保证送达。
			return
		}
		// 上游套接字刚被关掉（强制切换断旧连接、或者刚好被回收）：丢掉这个会话，
		// 按现在的状态重新挑一条路径再发。
		p.dropUDPSession(session)
	}
}

func (p *failoverProxy) udpSessionFor(key netip.AddrPort) *failoverUDPSession {
	p.udpMu.RLock()
	session := p.udpSessions[key]
	p.udpMu.RUnlock()
	if session != nil {
		return session
	}
	// 只有新会话才需要字符串形式（「按访客固定」的哈希键），热路径上不再每个包都格式化一次。
	upstream, index := p.dialUDPPath(key.String())
	if upstream == nil {
		return nil
	}
	session = &failoverUDPSession{key: key, client: net.UDPAddrFromAddrPort(key), upstream: upstream, index: index}
	session.touch(time.Now())
	// 先记到路径名下再放进会话表：中间要是正好切换、断旧连接，这个会话也在被断的名单里。
	p.trackConn(index, upstream)
	var evicted *failoverUDPSession
	p.udpMu.Lock()
	if p.retired() {
		p.udpMu.Unlock()
		p.untrackConn(index, upstream)
		_ = upstream.Close()
		return nil
	}
	if p.udpSessions == nil {
		p.udpSessions = map[netip.AddrPort]*failoverUDPSession{}
	}
	if len(p.udpSessions) >= failoverUDPMaxSessions {
		if evicted = p.oldestUDPSessionLocked(); evicted != nil {
			delete(p.udpSessions, evicted.key)
		}
	}
	p.udpSessions[key] = session
	p.udpMu.Unlock()
	if evicted != nil {
		p.untrackConn(evicted.index, evicted.upstream)
		_ = evicted.upstream.Close()
		if shouldLogAgentReport(fmt.Sprintf("failover-udp-session-limit:%d:%d", p.ruleID, p.sourcePort), agentReportLogInterval) {
			logf("failover udp session limit reached rule=%d source=%d sessions=%d; recycling the idlest", p.ruleID, p.sourcePort, failoverUDPMaxSessions)
		}
	}
	go p.copyUDPToClient(session)
	return session
}

// oldestUDPSessionLocked 线性扫描找最久没动静的会话。只在会话数顶到上限（4096）、又来了新来源时
// 才走到这里，一次最多扫 4096 个原子量（微秒级）；换成 LRU 链表要在每个包的热路径上加锁挪节点，
// 代价反而更大，所以保持现状。
func (p *failoverProxy) oldestUDPSessionLocked() *failoverUDPSession {
	var oldest *failoverUDPSession
	var oldestAt int64
	for _, session := range p.udpSessions {
		at := session.last.Load()
		if oldest == nil || at < oldestAt {
			oldest, oldestAt = session, at
		}
	}
	return oldest
}

// 给新会话挑路径并拨过去；拨不了（多半是地址解析失败）就记一次失败换下一条，和 TCP 一样。
func (p *failoverProxy) dialUDPPath(key string) (net.Conn, int) {
	attempted := map[int]bool{}
	for {
		target, index := p.pickTargetForKey(key, attempted)
		if index < 0 {
			if shouldLogAgentReport(fmt.Sprintf("failover-udp-no-target:%d:%d", p.ruleID, p.sourcePort), agentReportLogInterval) {
				logf("failover udp no target available rule=%d source=%d", p.ruleID, p.sourcePort)
			}
			return nil, -1
		}
		addr, pending, resolveErr := failoverUDPResolve(target.TargetIP, target.TargetPort)
		if pending {
			// 域名还在后台解析：这条先跳过但不记失败，解析完成后下一个包就能走它。
			attempted[index] = true
			continue
		}
		var upstream net.Conn
		err := resolveErr
		if err == nil {
			upstream, err = net.DialUDP("udp", nil, addr)
		}
		if err == nil {
			return upstream, index
		}
		attempted[index] = true
		p.markTargetFailure(index, "dial failed")
		if shouldLogAgentReport(fmt.Sprintf("failover-udp-dial:%d:%d:%d", p.ruleID, p.sourcePort, index), agentReportLogInterval) {
			logf("failover udp dial failed rule=%d source=%d target=%s:%d: %v", p.ruleID, p.sourcePort, target.TargetIP, target.TargetPort, err)
		}
	}
}

func (p *failoverProxy) copyUDPToClient(session *failoverUDPSession) {
	defer p.dropUDPSession(session)
	buf := getAgentByteBuffer(failoverUDPBufferSize)
	defer putAgentByteBuffer(buf)
	udpConn, _ := p.udp.(*net.UDPConn)
	failures := 0
	var deadline time.Time
	for {
		// 读超时不再每个回包都重设（每次都是一次系统调用加定时器调整）：剩下不到一半空闲
		// 窗口时才续到「两个方向最后一个包 + 空闲窗口」。到点以后照旧按最后一个包的时刻判断
		// 会话是否真的空闲，所以空闲回收的语义不变（回收器每 30 秒也按同一标准收）。
		if deadline.Sub(time.Now()) < failoverUDPIdleTimeout/2 {
			if next := time.Unix(0, session.last.Load()).Add(failoverUDPIdleTimeout); next.After(deadline) {
				deadline = next
				_ = session.upstream.SetReadDeadline(deadline)
			}
		}
		n, err := session.upstream.Read(buf)
		if n > 0 {
			failures = 0
			session.touch(time.Now())
			var werr error
			if udpConn != nil {
				_, werr = udpConn.WriteToUDPAddrPort(buf[:n], session.key)
			} else {
				_, werr = p.udp.WriteTo(buf[:n], session.client)
			}
			if werr != nil && (p.retired() || errors.Is(werr, net.ErrClosed)) {
				return
			}
		}
		if err == nil {
			continue
		}
		if p.retired() || errors.Is(err, net.ErrClosed) {
			return
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			// 路径那头一直没回包，但访客还在发（只进不出的 UDP 很常见）：会话还活着。
			if session.idleSince(time.Now()) < failoverUDPIdleTimeout {
				continue
			}
			return
		}
		// 其余的读错误（对端回 ICMP 端口不可达之类）只报这一次，下一个包照样能走；连着出错就算了。
		failures++
		if failures >= 8 {
			return
		}
	}
}

func (p *failoverProxy) dropUDPSession(session *failoverUDPSession) {
	p.udpMu.Lock()
	if current := p.udpSessions[session.key]; current == session {
		delete(p.udpSessions, session.key)
	}
	p.udpMu.Unlock()
	p.untrackConn(session.index, session.upstream)
	_ = session.upstream.Close()
}

func (p *failoverProxy) reapUDPSessions(stop <-chan struct{}) {
	ticker := time.NewTicker(failoverUDPReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-stop:
			return
		case <-ticker.C:
			p.reapIdleUDPSessions(time.Now())
		}
	}
}

func (p *failoverProxy) reapIdleUDPSessions(now time.Time) int {
	p.udpMu.Lock()
	idle := make([]*failoverUDPSession, 0)
	for key, session := range p.udpSessions {
		if session.idleSince(now) >= failoverUDPIdleTimeout {
			idle = append(idle, session)
			delete(p.udpSessions, key)
		}
	}
	p.udpMu.Unlock()
	for _, session := range idle {
		p.untrackConn(session.index, session.upstream)
		_ = session.upstream.Close()
	}
	return len(idle)
}

// ---- 健康探测 ----

// 测试里换掉它，免得真去 ping。
var failoverPingLatency = pingLatencyWithCount

func (t failoverTarget) hasExplicitProbe() bool {
	host := strings.TrimSpace(t.ProbeIP)
	return host != "" && t.ProbePort >= 1 && t.ProbePort <= 65535
}

/*
这条路径的健康探测怎么做。

TCP（含 TCP+UDP）照旧拨探测地址。只转 UDP 的路径没有握手可拨：拨号地址上多半只有 UDP
服务，拨 TCP 只会一直失败，所有路径都会被判成挂了。没单独填探测地址的话就 ping 拨号地址的
主机 —— 中转机上探 UDP 中继规则用的也是这个办法（buildRuleLatencyProbeTask）。填了探测地址
就照填的拨 TCP：用户填它，就是要探落地上某个确定开着的 TCP 端口。
*/
func failoverProbeTarget(protocol string, target failoverTarget) (int, bool) {
	if protocol == "udp" && !target.hasExplicitProbe() {
		latency, ok, _ := failoverPingLatency(target.TargetIP, 2*time.Second, 1)
		return latency, ok
	}
	host, port := target.probeEndpoint()
	return tcpLatency(host, port, 2*time.Second)
}

// ---- 按访客固定：从 PROXY 头里读访客地址 ----

/*
「按访客固定」要知道访客是谁。调度器只监听 127.0.0.1，连进来的永远是前面那个转发工具，
RemoteAddr 全是本机 —— 拿它哈希，所有访客都会被分到同一条路径（2.2.198 就是这样）。访客
地址只能从前面的转发工具加的 PROXY 头里读：

  - ProxyProtocolReceive：规则本来就往目标发 PROXY 头，头是给落地的，读完原样转过去；
  - ProxyProtocolStrip：规则不发 PROXY 头，头是面板专门让前面加给调度器的，读完扔掉。

两样都没有就按连接的来源地址（老行为）。返回访客地址（哈希用）和要先补发给路径的字节。
*/
func (p *failoverProxy) readVisitor(client net.Conn) (string, []byte) {
	p.mu.RLock()
	strategy := p.spec.Strategy
	receive := p.spec.ProxyProtocolReceive
	strip := p.spec.ProxyProtocolStrip
	p.mu.RUnlock()
	visitor := failoverRemoteIP(client)
	if !strip && !(receive && strategy == "ip_hash") {
		return visitor, nil
	}
	raw, headerLen, source := readFailoverProxyHeader(client, failoverProxyHeaderTimeout)
	if source != "" {
		visitor = source
	}
	if strip {
		return visitor, raw[headerLen:]
	}
	return visitor, raw
}

// 把读过的字节都记下来：解析 PROXY 头时多读到的数据还要原样补给路径。
type failoverRecordingConn struct {
	net.Conn
	read []byte
}

func (c *failoverRecordingConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.read = append(c.read, b[:n]...)
	}
	return n, err
}

// 从连接开头读一个 PROXY 头（v1 / v2）。返回读到的全部字节、其中头占多少、头里的访客地址。
// 开头不是 PROXY 头（或者读不全、读超时）时头长度为 0，读到的字节全部当数据转出去。
func readFailoverProxyHeader(conn net.Conn, timeout time.Duration) ([]byte, int, string) {
	rec := &failoverRecordingConn{Conn: conn}
	first := make([]byte, 256)
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	n, _ := rec.Read(first)
	_ = conn.SetReadDeadline(time.Time{})
	if n <= 0 {
		return nil, 0, ""
	}
	info, remaining, found, err := consumeProxyProtocolFromConn(rec, first[:n], timeout)
	raw := rec.read
	if err != nil || !found {
		return raw, 0, ""
	}
	headerLen := len(raw) - len(remaining)
	if headerLen < 0 || headerLen > len(raw) {
		return raw, 0, ""
	}
	return raw, headerLen, strings.TrimSpace(info.SourceIP)
}

/*
UDP 路径的目标地址解析。

新会话是在 serveUDP 的读循环里拨出去的；目标写的是域名时，net.DialTimeout 会在读循环里同步做 DNS 查询，
DNS 慢的时候整条规则的所有 UDP 包都跟着卡住。这里改成：IP 直接用；域名查一个小缓存，没命中就在后台解析，
这一次先跳过这条路径（UDP 丢一个包可以接受），解析好之后后面的包直接用缓存。
*/
const (
	failoverUDPResolveTTL        = 30 * time.Second
	failoverUDPResolveFailureTTL = 5 * time.Second
	failoverUDPResolveTimeout    = 5 * time.Second
	failoverUDPResolveCacheLimit = 256
)

type failoverUDPResolveEntry struct {
	addr    *net.UDPAddr
	err     error
	expires time.Time
}

var (
	failoverUDPResolveMu       sync.Mutex
	failoverUDPResolveCache    = map[string]failoverUDPResolveEntry{}
	failoverUDPResolveInflight = map[string]bool{}
	// 测试里替换。
	failoverUDPLookup = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		return net.DefaultResolver.LookupIPAddr(ctx, host)
	}
)

// failoverUDPResolve 返回可直接拨号的地址；pending 为 true 表示正在后台解析。
func failoverUDPResolve(host string, port int) (*net.UDPAddr, bool, error) {
	clean := strings.Trim(strings.TrimSpace(host), "[]")
	if ip := net.ParseIP(clean); ip != nil {
		return &net.UDPAddr{IP: ip, Port: port}, false, nil
	}
	key := net.JoinHostPort(clean, strconv.Itoa(port))
	now := time.Now()
	failoverUDPResolveMu.Lock()
	defer failoverUDPResolveMu.Unlock()
	if entry, ok := failoverUDPResolveCache[key]; ok && now.Before(entry.expires) {
		return entry.addr, false, entry.err
	}
	if !failoverUDPResolveInflight[key] {
		failoverUDPResolveInflight[key] = true
		go failoverUDPResolveInBackground(key, clean, port)
	}
	return nil, true, nil
}

func failoverUDPResolveInBackground(key string, host string, port int) {
	ctx, cancel := context.WithTimeout(context.Background(), failoverUDPResolveTimeout)
	addrs, err := failoverUDPLookup(ctx, host)
	cancel()
	entry := failoverUDPResolveEntry{err: err, expires: time.Now().Add(failoverUDPResolveFailureTTL)}
	if err == nil {
		// 和 net.Dial("udp", ...) 一样优先 IPv4。
		var chosen net.IP
		for _, addr := range addrs {
			if addr.IP.To4() != nil {
				chosen = addr.IP
				break
			}
		}
		if chosen == nil && len(addrs) > 0 {
			chosen = addrs[0].IP
		}
		if chosen == nil {
			entry.err = fmt.Errorf("no address for %s", host)
		} else {
			entry.addr = &net.UDPAddr{IP: chosen, Port: port}
			entry.err = nil
			entry.expires = time.Now().Add(failoverUDPResolveTTL)
		}
	}
	failoverUDPResolveMu.Lock()
	defer failoverUDPResolveMu.Unlock()
	delete(failoverUDPResolveInflight, key)
	if len(failoverUDPResolveCache) >= failoverUDPResolveCacheLimit {
		now := time.Now()
		for cachedKey, cached := range failoverUDPResolveCache {
			if !now.Before(cached.expires) {
				delete(failoverUDPResolveCache, cachedKey)
			}
		}
		if len(failoverUDPResolveCache) >= failoverUDPResolveCacheLimit {
			failoverUDPResolveCache = map[string]failoverUDPResolveEntry{}
		}
	}
	failoverUDPResolveCache[key] = entry
}
