package main

import (
	"bytes"
	"encoding/binary"
	"net"
	"net/netip"
	"time"
)

/*
UDP 会话的访客地址（2.2.264 起，出口组用）。

调度器只听 127.0.0.1，UDP 包的来源永远是前面那个转发工具（gost 给每个访客开一个本机套接字）。会话键用来源
地址没问题，可「按访客固定」拿它哈希就不对了：同一个访客每开一个新会话换一个来源端口，等于随机分；同一个访客
的 TCP 和 UDP 也落不到同一台出口上。

gost 的端口转发开了 handler 的 proxyProtocol 以后，UDP 和 TCP 一样在连上目标时先写一个 PROXY 头 —— UDP 上就是
每个新会话的**第一个包只有一个 PROXY v2 头**（28 字节，IPv6 是 52 字节），数据包随后才来（真实 gost 3.2.6 实测）。
面板给出口组的 UDP 端口固定写 v2（v1 是文本协议，没有 UDP），规格里带 ProxyProtocolStrip。

这里把那个包认出来：记下「这个来源地址的访客是谁」，包本身不转发。建会话时（udpSessionFor）拿访客地址当
哈希键 —— 和 TCP 那边从 PROXY 头读到的是同一个键，同一个访客的 TCP、UDP 落在同一台出口。没收到过头的来源
（代理重建以后还活着的老会话）照旧按来源地址。

只认「整包恰好是一个 PROXY v2 头」：真实的业务数据撞上这个格式的可能性可以不计，而且只在规格要求剥头
（这个头是我们自己让前面加的）时才认。
*/

var proxyV2Signature = []byte{0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A}

type failoverUDPVisitor struct {
	ip string
	at int64
}

// 访客表最多记这么多来源；超了先清掉过期的，还超就整个清空（下一批会话退回按来源地址，不影响转发）。
const failoverUDPVisitorLimit = 2 * failoverUDPMaxSessions

// parseUDPProxyV2Header 整包恰好是一个 PROXY v2 头时返回里面的来源地址。
func parseUDPProxyV2Header(packet []byte) (string, bool) {
	if len(packet) < 16 || !bytes.Equal(packet[:12], proxyV2Signature) {
		return "", false
	}
	// 版本 2；命令 PROXY（1）才带地址，LOCAL（0）没有访客可言。
	if packet[12]>>4 != 2 || packet[12]&0x0F != 1 {
		return "", false
	}
	length := int(binary.BigEndian.Uint16(packet[14:16]))
	if len(packet) != 16+length {
		return "", false
	}
	switch packet[13] >> 4 {
	case 1: // IPv4：源 4、目的 4、端口各 2
		if length < 12 {
			return "", false
		}
		return net.IP(packet[16:20]).String(), true
	case 2: // IPv6：源 16、目的 16、端口各 2
		if length < 36 {
			return "", false
		}
		return net.IP(packet[16:32]).String(), true
	}
	return "", false
}

// consumeUDPVisitorHeader 这个包是不是前面加给调度器的 PROXY 头；是就记下访客、返回 true（调用方不转发它）。
func (p *failoverProxy) consumeUDPVisitorHeader(key netip.AddrPort, packet []byte) bool {
	// 热路径：绝大多数包第一眼就不是，不拿锁。
	if len(packet) < 16 || !bytes.Equal(packet[:12], proxyV2Signature) {
		return false
	}
	// 出口组的 UDP 头永远是给调度器的（规则的 PROXY 设置只管 TCP）；别的规格只在面板要求剥头时认。
	p.mu.RLock()
	strip := p.spec.ProxyProtocolStrip || p.exitGroupLocked()
	p.mu.RUnlock()
	if !strip {
		return false
	}
	visitor, ok := parseUDPProxyV2Header(packet)
	if !ok {
		return false
	}
	now := time.Now()
	p.udpMu.Lock()
	if p.udpVisitors == nil {
		p.udpVisitors = map[netip.AddrPort]failoverUDPVisitor{}
	}
	if len(p.udpVisitors) >= failoverUDPVisitorLimit {
		p.pruneUDPVisitorsLocked(now)
		if len(p.udpVisitors) >= failoverUDPVisitorLimit {
			p.udpVisitors = map[netip.AddrPort]failoverUDPVisitor{}
		}
	}
	p.udpVisitors[key] = failoverUDPVisitor{ip: visitor, at: now.UnixNano()}
	p.udpMu.Unlock()
	return true
}

// udpHashKey 新会话挑路径用的哈希键：知道访客就是访客地址，否则是来源地址（老行为）。
func (p *failoverProxy) udpHashKey(key netip.AddrPort) string {
	p.udpMu.RLock()
	visitor, ok := p.udpVisitors[key]
	p.udpMu.RUnlock()
	if ok && visitor.ip != "" {
		return visitor.ip
	}
	return key.String()
}

// pruneUDPVisitorsLocked 清掉没有会话、又过了空闲时间的访客记录。调用方持有 p.udpMu。
func (p *failoverProxy) pruneUDPVisitorsLocked(now time.Time) {
	for key, visitor := range p.udpVisitors {
		if _, live := p.udpSessions[key]; live {
			continue
		}
		if now.UnixNano()-visitor.at >= int64(failoverUDPIdleTimeout) {
			delete(p.udpVisitors, key)
		}
	}
}
