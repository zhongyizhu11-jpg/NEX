package main

import (
	"net"
	"testing"
)

// startGuardUDPRelayForTest 在本机起一个只转 UDP 的协议守护，目标是 target；返回它的监听地址。
func startGuardUDPRelayForTest(t testing.TB, ruleID int, target *net.UDPAddr, rule func(*guardRule)) string {
	return startGuardUDPRelayOnForTest(t, "127.0.0.1:0", ruleID, target, rule)
}

func startGuardUDPRelayOnForTest(t testing.TB, listen string, ruleID int, target *net.UDPAddr, rule func(*guardRule)) string {
	t.Helper()
	listener, err := net.ListenPacket("udp", listen)
	if err != nil {
		t.Fatal(err)
	}
	// 和 startProtocolGuard 一样放大接收缓冲：50 个客户端同时开窗的那一下会冲爆内核默认的 208 KiB。
	_ = listener.(*net.UDPConn).SetReadBuffer(protocolGuardUDPReadBuffer)
	spec := guardRule{
		RuleID: ruleID, ListenPort: listener.LocalAddr().(*net.UDPAddr).Port,
		TargetIP: "127.0.0.1", TargetPort: target.Port, Protocol: "udp", RateLimitScope: t.Name(),
	}
	if rule != nil {
		rule(&spec)
	}
	server := newProtocolGuardServer(spec)
	server.udpConn = listener
	go server.serveUDP()
	t.Cleanup(server.close)
	return listener.LocalAddr().String()
}

// 50 个客户端、每个 200 个 1～1400 字节的包经过守护 UDP 中继：每个回包都要回到发它的客户端、
// 逐字节一样。没限速的规则走批量路径，限了速的走逐包路径，两种都核一遍。
func TestProtocolGuardUDPRelayDeliversExactBytesToRightClient(t *testing.T) {
	echo := udpPlainEcho(t)
	t.Run("unlimited", func(t *testing.T) {
		addr := startGuardUDPRelayForTest(t, 58, echo, nil)
		udpRelayExactness(t, addr, 50, 200, 16)
	})
	t.Run("limited", func(t *testing.T) {
		addr := startGuardUDPRelayForTest(t, 59, echo, func(rule *guardRule) {
			rule.LimitIn = 200 * 1024 * 1024
			rule.LimitOut = 200 * 1024 * 1024
		})
		udpRelayExactness(t, addr, 50, 200, 16)
	})
}

// 监听在 IPv6 / 双栈套接字上时回包要写成 IPv6 形式（IPv4 访客是 ::ffff:a.b.c.d）。
func TestProtocolGuardUDPRelayOnIPv6AndDualStackListeners(t *testing.T) {
	echo := udpPlainEcho(t)
	if probe, err := net.ListenPacket("udp", "[::1]:0"); err != nil {
		t.Skipf("no IPv6 loopback: %v", err)
	} else {
		_ = probe.Close()
	}
	t.Run("ipv6", func(t *testing.T) {
		udpRelayExactness(t, startGuardUDPRelayOnForTest(t, "[::1]:0", 62, echo, nil), 8, 50, 8)
	})
	t.Run("dualstack-v4-client", func(t *testing.T) {
		addr := startGuardUDPRelayOnForTest(t, "[::]:0", 63, echo, nil)
		_, port, err := net.SplitHostPort(addr)
		if err != nil {
			t.Fatal(err)
		}
		udpRelayExactness(t, net.JoinHostPort("127.0.0.1", port), 8, 50, 8)
	})
}

// 守护 UDP 中继在本机回环上的吞吐，子项含义同 BenchmarkFailoverUDPRelayLoopback。
func BenchmarkProtocolGuardUDPRelayLoopback(b *testing.B) {
	for _, mode := range []struct {
		name  string
		batch bool
		run   func(*testing.B, string)
	}{{"batch", true, benchmarkUDPRelay}, {"perPacket", false, benchmarkUDPRelay}, {"batch-rtt", true, benchmarkUDPRelayRTT}, {"perPacket-rtt", false, benchmarkUDPRelayRTT}} {
		b.Run(mode.name, func(b *testing.B) {
			old := udpBatchEnabled
			udpBatchEnabled = mode.batch
			defer func() { udpBatchEnabled = old }()
			echo := udpPlainEcho(b)
			addr := startGuardUDPRelayForTest(b, 60, echo, nil)
			mode.run(b, addr)
		})
	}
}
