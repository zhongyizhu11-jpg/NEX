package main

import (
	"net"
	"time"
)

/*
一条路径刚被判成走不通时，已经在它上面的流量怎么办（A6）。

主备策略下这件事由切换管（setActiveLocked 按 SwitchMode 断旧连接）。按权重 / 按负载 / 自动 / 轮流 / 随机 /
按访客固定没有「切换」这个动作 —— 路径坏了只是不再分新连接给它，已经在上面的连接和 UDP 会话原地不动：
TCP 连接挂到客户端自己超时，UDP 会话只要客户端还在发就一直续着（两个方向任一有包就不算空闲），永远黑洞。

现在路径一判坏（本机探测、真实拨号、「回之前就关」、面板提示，任何一种）：
  - UDP 会话：一律关掉。UDP 没有连接可言，关掉只是让这个来源的下一个包重新挑一条路径（dropUDPSession →
    udpSessionFor），访客那边最多丢几个包。所有策略都这样做，主备也是 —— 死路上的会话留着没有任何好处。
  - TCP 连接：按 SwitchMode，和主备切换同一条规矩（shouldCloseOldConnsLocked）：force 断；fast 断（旧路径
    挂了才断 —— 这里它就是挂了）；smooth 不动。主备策略下正在走的那条不在这里断，照旧交给接下来的切换。

mainSide / udpSide：哪一侧坏了。主健康（targetHealth）在只转 UDP 的规格里就是 UDP 的健康，在 TCP+UDP 规格里
只是 TCP 那一侧（UDP 另有一本，route_group_udp_health.go）。面板提示两侧都算。调用方持有 p.mu。
*/
func (p *failoverProxy) onTargetDownLocked(index int, mainSide bool, udpSide bool) {
	if index < 0 || index >= len(p.conns) {
		return
	}
	protocol := failoverProtocol(p.spec)
	tcpDown := mainSide && protocol != "udp"
	udpDown := udpSide || (mainSide && protocol != "both")
	closedTCP, closedUDP := 0, 0
	if udpDown {
		closedUDP = p.closeConnsWhereLocked(index, true)
	}
	if tcpDown && !(p.spec.Strategy == "fallback" && index == p.activeIndex) {
		switch p.spec.SwitchMode {
		case "force", "fast":
			closedTCP = p.closeConnsWhereLocked(index, false)
		}
	}
	if closedTCP > 0 || closedUDP > 0 {
		logf("failover closed %d connection(s) and %d udp session(s) on a path that went down rule=%d source=%d index=%d mode=%s", closedTCP, closedUDP, p.ruleID, p.sourcePort, index, p.spec.SwitchMode)
	}
}

// 记在路径名下的是不是 UDP 会话的上游套接字（udpSessionFor 用 net.DialUDP 拨的）；其余是 TCP 客户端连接。
func failoverIsUDPConn(conn net.Conn) bool {
	_, ok := conn.(*net.UDPConn)
	return ok
}

// closeConnsWhereLocked 只关这条路径上的 UDP 会话（udp=true）或只关 TCP 连接（udp=false）。
func (p *failoverProxy) closeConnsWhereLocked(index int, udp bool) int {
	if index < 0 || index >= len(p.conns) {
		return 0
	}
	count := 0
	for conn := range p.conns[index] {
		if failoverIsUDPConn(conn) != udp {
			continue
		}
		_ = conn.Close()
		delete(p.conns[index], conn)
		count++
	}
	return count
}

/*
UDP 黑洞流（A6）。

上面那一刀只在「判坏的那一刻」落下。之后还会有会话落在坏路径上：全挂兜底时挑上去的、判坏之后才建的。
它们同样是客户端一直发、对面一个包不回、会话永远不空闲。所以每个会话记着「上一次收到回包以来发了多少个
包、从什么时候开始」：发了至少 failoverUDPBlackholeDatagrams 个、持续了至少 failoverUDPBlackholeAfter、
一个回包都没有，**而且这条路径 UDP 那一侧此刻是坏的、别的路径里有能用的** —— 丢掉会话重挑。

只凭「没回包」不重挑：单向的 UDP 协议（日志、遥测、有的打洞）本来就不回，路径好好的时候把它挪走只会
打断它。必须探测也说这条路坏了才动。
*/
const (
	failoverUDPBlackholeDatagrams = 8
	failoverUDPBlackholeAfter     = 10 * time.Second
	// 够条件以后隔多久再看一眼路径的健康（要拿 p.mu 的读锁，不能每个包都看）。
	failoverUDPBlackholeRecheck = time.Second
)

// noteSent 客户端方向又发了 count 个包。返回 true 表示「发了够多、够久、一个没回」，该去看路径还通不通。
func (s *failoverUDPSession) noteSent(count int, now time.Time) bool {
	sent := s.unanswered.Add(int32(count))
	since := s.unansweredSince.Load()
	if since == 0 {
		s.unansweredSince.CompareAndSwap(0, now.UnixNano())
		return false
	}
	if sent < failoverUDPBlackholeDatagrams || now.UnixNano()-since < int64(failoverUDPBlackholeAfter) {
		return false
	}
	last := s.blackholeChecked.Load()
	if now.UnixNano()-last < int64(failoverUDPBlackholeRecheck) {
		return false
	}
	return s.blackholeChecked.CompareAndSwap(last, now.UnixNano())
}

// noteReply 路径那头回包了：不是黑洞。
func (s *failoverUDPSession) noteReply() {
	if s.unanswered.Load() != 0 {
		s.unanswered.Store(0)
		s.unansweredSince.Store(0)
	}
}

// udpSessionStranded 这个会话所在的路径 UDP 那一侧是不是坏了、而且有别的能用的路径可换。
func (p *failoverProxy) udpSessionStranded(session *failoverUDPSession) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.usableLocked(session.index, true) {
		return false
	}
	for i := range p.spec.Targets {
		if i != session.index && p.usableLocked(i, true) {
			return true
		}
	}
	return false
}

// repickBlackholedUDP 在把包写给会话之前调：黑洞了就丢掉会话，返回 true（调用方重新取会话）。
func (p *failoverProxy) repickBlackholedUDP(session *failoverUDPSession, count int, now time.Time) bool {
	if !session.noteSent(count, now) || !p.udpSessionStranded(session) {
		return false
	}
	if shouldLogAgentReport("failover-udp-blackhole:"+failoverID(p.ruleID, p.sourcePort), agentReportLogInterval) {
		logf("failover udp session re-picked: %d datagram(s) unanswered and the path is down rule=%d source=%d index=%d", session.unanswered.Load(), p.ruleID, p.sourcePort, session.index)
	}
	p.dropUDPSession(session)
	return true
}
