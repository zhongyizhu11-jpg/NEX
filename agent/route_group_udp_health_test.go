package main

import (
	"net"
	"strconv"
	"testing"
	"time"
)

// 一个 TCP 端口上接了就关的监听（健康探测拨得通），返回端口。
func failoverTCPAcceptor(t *testing.T, addr string) int {
	t.Helper()
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

/*
TCP+UDP 规格两侧分开判：路径 A 的 TCP 通、UDP 端口关着，路径 B 两样都通。

TCP 那一侧和以前一模一样（A 健康、在走 A）；UDP 那一侧 A 不通，UDP 会话挑路径时避开 A 走 B；
面板收到 A 的 healthy=true、udpHealthy=false。A 的 UDP 端口开回来、稳定够久以后 UDP 会话回到 A。
*/
func TestFailoverBothJudgesUDPSeparately(t *testing.T) {
	portA := failoverTCPAcceptor(t, "127.0.0.1:0") // 同号的 UDP 端口没人听：探测收到 ICMP 端口不可达
	portB := failoverTestDualPort(t)
	failoverTCPAcceptor(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(portB)))
	udpB, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: portB})
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	defer udpB.Close()
	go udpEchoLoop(udpB)

	proxy := &failoverProxy{
		ruleID: 45, sourcePort: 20004,
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 65004, BindAddress: "127.0.0.1", Protocol: "both", Strategy: "fallback",
			FailoverSeconds: 1, RecoverSeconds: 1, AutoFailback: true,
			Targets: []failoverTarget{
				{TargetIP: "127.0.0.1", TargetPort: portA},
				{TargetIP: "127.0.0.1", TargetPort: portB},
			},
		}),
	}
	proxy.ensureHealthStateLocked()

	proxy.checkHealth()
	time.Sleep(1100 * time.Millisecond)
	proxy.checkHealth()

	proxy.mu.RLock()
	tcpA, udpA, udpB2 := proxy.targetHealth[0], proxy.udpSide.health[0], proxy.udpSide.health[1]
	active := proxy.activeIndex
	report := proxy.statsReportLocked()
	proxy.mu.RUnlock()
	if !tcpA || active != 0 {
		t.Fatalf("TCP 那一侧没变：A 该健康且在走（healthy=%v active=%d）", tcpA, active)
	}
	if udpA {
		t.Fatal("A 的 UDP 端口关着，UDP 那一侧应当判成不通")
	}
	if !udpB2 {
		t.Fatal("B 的 UDP 回话，应当是通的")
	}
	if _, index := proxy.pickTargetForKeyProto("", nil, false); index != 0 {
		t.Fatalf("TCP 连接照旧走 A，挑到了 %d", index)
	}
	if _, index := proxy.pickTargetForKeyProto("", nil, true); index != 1 {
		t.Fatalf("UDP 会话应当避开 UDP 不通的 A 走 B，挑到了 %d", index)
	}
	if report.Targets[0].UDPHealthy == nil || *report.Targets[0].UDPHealthy || !report.Targets[0].Healthy {
		t.Fatalf("上报应当是 A healthy=true udpHealthy=false：%+v", report.Targets[0])
	}
	if report.Targets[1].UDPHealthy == nil || !*report.Targets[1].UDPHealthy || report.Targets[1].UDPLatencyMs < 1 {
		t.Fatalf("上报应当是 B udpHealthy=true 且带 UDP 耗时：%+v", report.Targets[1])
	}

	// A 的 UDP 端口开回来：恢复满 RecoverSeconds 以后 UDP 会话回到 TCP 在走的那条。
	udpA2, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: portA})
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	defer udpA2.Close()
	go udpEchoLoop(udpA2)
	proxy.checkHealth()
	if _, index := proxy.pickTargetForKeyProto("", nil, true); index != 1 {
		t.Fatalf("刚恢复一次还没满恢复时间，UDP 会话该还在 B，挑到了 %d", index)
	}
	time.Sleep(1100 * time.Millisecond)
	proxy.checkHealth()
	if _, index := proxy.pickTargetForKeyProto("", nil, true); index != 0 {
		t.Fatalf("A 的 UDP 恢复以后 UDP 会话该回到 A，挑到了 %d", index)
	}
}

// UDP 会话按「人工指定 > 时段表 > 数组顺序」找第一条 UDP 通的；TCP 在走的那条 UDP 也通就跟它走。
func TestFailoverUDPFallbackOrder(t *testing.T) {
	proxy := &failoverProxy{
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 65005, BindAddress: "127.0.0.1", Protocol: "both", Strategy: "fallback",
			Targets: []failoverTarget{
				{TargetIP: "10.0.0.1", TargetPort: 53},
				{TargetIP: "10.0.0.2", TargetPort: 53},
				{TargetIP: "10.0.0.3", TargetPort: 53},
			},
		}),
	}
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.ensureHealthStateLocked()
	proxy.activeIndex = 1
	if index := proxy.udpFallbackIndexLocked(proxy.candidateIndicesForLocked(nil, true, true), nil); index != 1 {
		t.Fatalf("TCP 在走的 B UDP 也通，UDP 该跟着走 B，挑到了 %d", index)
	}
	proxy.udpSide.health[1] = false
	if index := proxy.udpFallbackIndexLocked(proxy.candidateIndicesForLocked(nil, true, true), nil); index != 0 {
		t.Fatalf("B 的 UDP 不通，按数组顺序该是 A，挑到了 %d", index)
	}
	pinned := 2
	proxy.spec.PinnedIndex = &pinned
	if index := proxy.udpFallbackIndexLocked(proxy.candidateIndicesForLocked(nil, true, true), nil); index != 2 {
		t.Fatalf("人工指定了 C，UDP 该先试 C，挑到了 %d", index)
	}
	proxy.udpSide.health[2] = false
	if index := proxy.udpFallbackIndexLocked(proxy.candidateIndicesForLocked(nil, true, true), nil); index != 0 {
		t.Fatalf("指定的 C UDP 不通就往下找，该是 A，挑到了 %d", index)
	}
	// 全都不通：和 TCP 一样兜底，不分健康。
	proxy.udpSide.health[0] = false
	candidates := proxy.candidateIndicesForLocked(nil, true, true)
	if len(candidates) != 0 {
		t.Fatalf("全不通时不该有健康候选：%v", candidates)
	}
	// 只转 TCP / 只转 UDP 的规格不分侧：UDP 那一侧的健康就是主健康。
	proxy.spec.Protocol = "udp"
	if !proxy.udpUsableLocked(0) {
		t.Fatal("只转 UDP 的规格不走单独那一侧，主健康是好的就该能用")
	}
}

// 上报：只转 TCP 不带 udpHealthy（老样子），只转 UDP 等于主健康，TCP+UDP 是单独那一侧。
func TestFailoverUDPReportFollowsProtocol(t *testing.T) {
	for _, protocol := range []string{"tcp", "udp", "both"} {
		proxy := &failoverProxy{
			spec: normalizeFailoverSpec(failoverSpec{
				Enabled: true, ListenPort: 65006, BindAddress: "127.0.0.1", Protocol: protocol, Strategy: "fallback",
				Targets: []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 53}, {TargetIP: "10.0.0.2", TargetPort: 53}},
			}),
		}
		proxy.mu.Lock()
		proxy.ensureHealthStateLocked()
		proxy.targetHealth[0] = false
		proxy.udpSide.health[1] = false
		report := proxy.statsReportLocked()
		proxy.mu.Unlock()
		switch protocol {
		case "tcp":
			if report.Targets[0].UDPHealthy != nil || report.Targets[1].UDPHealthy != nil {
				t.Fatalf("只转 TCP 的规格不该报 udpHealthy：%+v", report.Targets)
			}
		case "udp":
			if report.Targets[0].UDPHealthy == nil || *report.Targets[0].UDPHealthy || report.Targets[1].UDPHealthy == nil || !*report.Targets[1].UDPHealthy {
				t.Fatalf("只转 UDP 的规格 udpHealthy 就是 healthy：%+v", report.Targets)
			}
		case "both":
			if report.Targets[0].UDPHealthy == nil || !*report.Targets[0].UDPHealthy || !report.Targets[1].Healthy || *report.Targets[1].UDPHealthy {
				t.Fatalf("TCP+UDP 两侧分开报：%+v", report.Targets)
			}
		}
	}
}

// 换规格时 UDP 那一侧的健康也按「还是同一条出站」搬过去。
func TestFailoverRebuildCarriesUDPSide(t *testing.T) {
	proxy := &failoverProxy{
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 65007, BindAddress: "127.0.0.1", Protocol: "both", Strategy: "fallback",
			Targets: []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 53}, {TargetIP: "10.0.0.2", TargetPort: 53}},
		}),
	}
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.ensureHealthStateLocked()
	proxy.udpSide.health[1] = false
	next := proxy.spec
	next.Targets = []failoverTarget{{TargetIP: "10.0.0.3", TargetPort: 53}, {TargetIP: "10.0.0.2", TargetPort: 53}, {TargetIP: "10.0.0.1", TargetPort: 53}}
	proxy.rebuildForSpecLocked(normalizeFailoverSpec(next), time.Now())
	if len(proxy.udpSide.health) != 3 || !proxy.udpSide.health[0] || proxy.udpSide.health[1] || !proxy.udpSide.health[2] {
		t.Fatalf("UDP 那一侧没跟着出站搬：%v", proxy.udpSide.health)
	}
}

func udpEchoLoop(conn *net.UDPConn) {
	buf := make([]byte, 2048)
	for {
		n, addr, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			return
		}
		_, _ = conn.WriteToUDPAddrPort(buf[:n], addr)
	}
}
