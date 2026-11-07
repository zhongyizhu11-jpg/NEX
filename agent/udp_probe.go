package main

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"syscall"
	"time"
)

/*
UDP 的健康探测（Agent 2.2.251 起）。

UDP 没有握手，以前只转 UDP 的路径只能 ping 拨号地址的主机：主机活着、UDP 服务死了，看起来照样
健康。现在分两步：

 1. 对端也是 NEX 的 Agent（面板按 Agent 版本给目标带上 probeUdpEcho）：发一个 24 字节的探测报
    （8 字节魔数 NEXUDPP1 + 8 字节随机数 + 8 字节发送时刻），Agent 的每个 UDP 中继监听（协议守护、
    线路组调度器）收到正好这个形状的包就原样回给发送方、不转发。收到回包就是通，顺带量出往返耗时。
 2. 对端不是 Agent：用连接态 UDP 套接字发一个零长度的包，读 1 秒。对端回了 ICMP 端口不可达
    （ECONNREFUSED）就是确定不通；超时说不准（服务可能只是不回陌生包），退回原来的 ping。

回包按来源地址限速（每秒 20 个），免得被拿去当反射器 —— 放大倍数本来就是 1。
*/
const (
	udpProbeMagic   = "NEXUDPP1"
	udpProbeLen     = 24
	udpProbeTimeout = time.Second
	// 同一个来源地址每秒最多回这么多个探测报；探测本来一轮一个。
	udpProbeEchoRatePerSecond = 20
	udpProbeEchoBurst         = 20
	udpProbeEchoPruneAfter    = time.Minute
	udpProbeEchoMaxSources    = 4096
)

// isUDPProbe 这个包是不是探测报：长度正好 24、开头是魔数。
func isUDPProbe(packet []byte) bool {
	return len(packet) == udpProbeLen && string(packet[:len(udpProbeMagic)]) == udpProbeMagic
}

// newUDPProbePacket 造一个探测报：魔数 + 随机数 + 发送时刻（UnixNano，大端）。
func newUDPProbePacket(now time.Time) []byte {
	packet := make([]byte, udpProbeLen)
	copy(packet, udpProbeMagic)
	if _, err := rand.Read(packet[8:16]); err != nil {
		binary.BigEndian.PutUint64(packet[8:16], uint64(now.UnixNano()))
	}
	binary.BigEndian.PutUint64(packet[16:24], uint64(now.UnixNano()))
	return packet
}

type udpEchoBucket struct {
	tokens float64
	last   time.Time
}

// udpEchoLimiter 回探测报的限速：按来源地址（不带端口）各一个令牌桶。零值可用。
type udpEchoLimiter struct {
	mu        sync.Mutex
	buckets   map[netip.Addr]*udpEchoBucket
	lastPrune time.Time
}

func (l *udpEchoLimiter) allow(addr netip.Addr, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = map[netip.Addr]*udpEchoBucket{}
		l.lastPrune = now
	}
	if now.Sub(l.lastPrune) >= udpProbeEchoPruneAfter || len(l.buckets) >= udpProbeEchoMaxSources {
		for key, bucket := range l.buckets {
			if now.Sub(bucket.last) >= udpProbeEchoPruneAfter {
				delete(l.buckets, key)
			}
		}
		l.lastPrune = now
	}
	bucket := l.buckets[addr]
	if bucket == nil {
		if len(l.buckets) >= udpProbeEchoMaxSources {
			// 来源太多（扫描）：新来源不回，正在探的老来源不受影响。
			return false
		}
		bucket = &udpEchoBucket{tokens: udpProbeEchoBurst, last: now}
		l.buckets[addr] = bucket
	} else {
		bucket.tokens += now.Sub(bucket.last).Seconds() * udpProbeEchoRatePerSecond
		if bucket.tokens > udpProbeEchoBurst {
			bucket.tokens = udpProbeEchoBurst
		}
		bucket.last = now
	}
	if bucket.tokens < 1 {
		return false
	}
	bucket.tokens--
	return true
}

// answerUDPProbe 收到的包是探测报就原样回给来源（限速内），返回 true 表示这个包已经处理掉、不要转发。
func answerUDPProbe(conn net.PacketConn, limiter *udpEchoLimiter, packet []byte, client netip.AddrPort) bool {
	if !isUDPProbe(packet) {
		return false
	}
	if conn == nil || limiter == nil || !client.IsValid() || !limiter.allow(client.Addr().Unmap(), time.Now()) {
		return true
	}
	if udpConn, ok := conn.(*net.UDPConn); ok {
		_, _ = udpConn.WriteToUDPAddrPort(packet, client)
	} else {
		_, _ = conn.WriteTo(packet, net.UDPAddrFromAddrPort(client))
	}
	return true
}

type udpProbeVerdict int

const (
	// 说不准：没回包也没 ICMP（服务可能只是不回陌生包），调用方退回 ping。
	udpProbeUnknown udpProbeVerdict = iota
	// 通：收到了回包（回声探测是我们自己的包；别的服务回了什么也算活着）。
	udpProbeUp
	// 确定不通：对端回了 ICMP 端口不可达。
	udpProbeDown
)

// 测试里换掉它，免得真发包。
var udpProbeFn = udpProbe

/*
udpProbe 探一个 UDP 端口。echo 为 true 发探测报（对端是 Agent），否则发零长度的包。

连接态套接字才收得到 ICMP 错误：内核把端口不可达记在套接字上，下一次读返回 ECONNREFUSED。
返回往返毫秒数（通的时候）和结论。
*/
func udpProbe(host string, port int, echo bool, timeout time.Duration) (int, udpProbeVerdict) {
	target := normalizeNetworkTargetHost(host)
	if target == "" || port <= 0 || port > 65535 {
		return 0, udpProbeUnknown
	}
	if timeout <= 0 {
		timeout = udpProbeTimeout
	}
	conn, err := net.DialTimeout("udp", net.JoinHostPort(target, strconv.Itoa(port)), timeout)
	if err != nil {
		return 0, udpProbeUnknown
	}
	defer conn.Close()
	started := time.Now()
	var payload []byte
	if echo {
		payload = newUDPProbePacket(started)
	}
	if _, err := conn.Write(payload); err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) {
			return 0, udpProbeDown
		}
		return 0, udpProbeUnknown
	}
	_ = conn.SetReadDeadline(started.Add(timeout))
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) {
			return 0, udpProbeDown
		}
		return 0, udpProbeUnknown
	}
	// 回声探测要求原样回来；回了别的东西说明端口上有别的服务在回话，同样算活着。
	if echo && n == udpProbeLen && string(buf[:n]) != string(payload) {
		return 0, udpProbeUnknown
	}
	latency := int(time.Since(started) / time.Millisecond)
	if latency < 1 {
		latency = 1
	}
	return latency, udpProbeUp
}
