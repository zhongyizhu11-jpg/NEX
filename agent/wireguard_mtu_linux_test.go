//go:build linux

package main

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestChooseWireGuardMTU(t *testing.T) {
	cases := []struct {
		name       string
		configured int
		cachedPMTU int
		ipv6       bool
		want       int
	}{
		// 1500 以太网路径：IPv4 外层 1480、IPv6 外层 1500 都放得下满载包，用 1420。
		{"ipv4 clean 1500 path", 1380, 1500, false, 1420},
		{"ipv6 clean 1500 path", 1380, 1500, true, 1420},
		{"ipv4 exactly outer size", 1380, 1480, false, 1420},
		{"loopback huge mtu", 1380, 65536, false, 1420},
		// PPPoE 1492：IPv4 1492-60=1432 封顶 1420；IPv6 1492-80=1412 刚好是 4 的倍数。
		{"ipv4 pppoe 1492 capped", 1380, 1492, false, 1420},
		{"ipv6 pppoe 1492", 1380, 1492, true, 1412},
		// 向下取整到 4 的倍数：1470-60=1410 -> 1408。
		{"ipv4 rounds down to multiple of 4", 1380, 1470, false, 1408},
		{"ipv6 rounds down to multiple of 4", 1380, 1498, true, 1416},
		// 算出来比面板下发的还小就维持面板的值，绝不往下调。
		{"ipv4 never below configured", 1380, 1400, false, 1380},
		{"ipv6 never below configured", 1380, 1450, true, 1380},
		{"zero pmtu keeps configured", 1380, 0, false, 1380},
		// 面板已经给到上限就不动。
		{"configured at cap", 1420, 65536, false, 1420},
		{"configured above cap untouched", 1500, 65536, false, 1500},
		// 面板给的更保守值（Mimic 1280）同样只会被抬，不会被压。
		{"mimic configured raised when path allows", 1280, 1500, false, 1420},
		{"mimic configured partial raise", 1280, 1400, false, 1340},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := chooseWireGuardMTU(tc.configured, tc.cachedPMTU, tc.ipv6); got != tc.want {
				t.Fatalf("chooseWireGuardMTU(%d, %d, ipv6=%v) = %d, want %d", tc.configured, tc.cachedPMTU, tc.ipv6, got, tc.want)
			}
		})
	}
}

func TestWireGuardOuterOverhead(t *testing.T) {
	// 1420 内层 + 32 WireGuard + 8 UDP + 20/40 IP = 1480 / 1500。
	if got := wireGuardMTUProbeMax + wireGuardOuterOverhead(false); got != 1480 {
		t.Fatalf("ipv4 outer size = %d, want 1480", got)
	}
	if got := wireGuardMTUProbeMax + wireGuardOuterOverhead(true); got != 1500 {
		t.Fatalf("ipv6 outer size = %d, want 1500", got)
	}
}

func TestProbeWireGuardMTUKillSwitch(t *testing.T) {
	listener, port := listenWireGuardMTUProbeTarget(t, "udp4", "127.0.0.1:0")
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for _, value := range []string{"0", "off", "false", "disabled"} {
		t.Setenv(wireGuardMTUProbeEnv, value)
		if got := probeWireGuardMTU(ctx, "127.0.0.1", port, 1380); got != 1380 {
			t.Fatalf("NEX_WG_MTU_PROBE=%s: got %d, want configured 1380", value, got)
		}
	}
	t.Setenv(wireGuardMTUProbeEnv, "")
	// 面板已经给到上限、端点为空、端口非法：都不探测，原样返回。
	if got := probeWireGuardMTU(ctx, "127.0.0.1", port, 1420); got != 1420 {
		t.Fatalf("configured 1420: got %d", got)
	}
	if got := probeWireGuardMTU(ctx, "", port, 1380); got != 1380 {
		t.Fatalf("empty endpoint: got %d, want 1380", got)
	}
	if got := probeWireGuardMTU(ctx, "127.0.0.1", 0, 1380); got != 1380 {
		t.Fatalf("zero port: got %d, want 1380", got)
	}
	// 上下文已经取消：探测不等结果，原样返回。
	cancelled, cancelNow := context.WithCancel(context.Background())
	cancelNow()
	if got := probeWireGuardMTU(cancelled, "127.0.0.1", port, 1380); got != 1380 {
		t.Fatalf("cancelled context: got %d, want 1380", got)
	}
}

func TestProbeWireGuardMTULoopback(t *testing.T) {
	t.Setenv(wireGuardMTUProbeEnv, "")
	listener, port := listenWireGuardMTUProbeTarget(t, "udp4", "127.0.0.1:0")
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 回环 MTU 65536，满载探测包肯定放得下，期望抬到 1420。
	if got := probeWireGuardMTU(ctx, "127.0.0.1", port, 1380); got != 1420 {
		t.Fatalf("loopback probe = %d, want 1420", got)
	}
	// 探测包本身：1452 字节、全零（首字节 0 不是合法 WireGuard 消息类型，对端会静默丢弃）。
	buf := make([]byte, 4096)
	_ = listener.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := listener.ReadFrom(buf)
	if err != nil {
		t.Fatalf("read probe datagram: %v", err)
	}
	if n != wireGuardMTUProbeMax+wireGuardPacketOverhead {
		t.Fatalf("probe datagram size = %d, want %d", n, wireGuardMTUProbeMax+wireGuardPacketOverhead)
	}
	for i := 0; i < n; i++ {
		if buf[i] != 0 {
			t.Fatalf("probe datagram byte %d = %#x, want 0", i, buf[i])
		}
	}
}

func TestProbeWireGuardMTULoopbackIPv6(t *testing.T) {
	t.Setenv(wireGuardMTUProbeEnv, "")
	listener, err := net.ListenPacket("udp6", "[::1]:0")
	if err != nil {
		t.Skipf("ipv6 loopback unavailable: %v", err)
	}
	defer listener.Close()
	port := listener.LocalAddr().(*net.UDPAddr).Port
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if got := probeWireGuardMTU(ctx, "::1", port, 1380); got != 1420 {
		t.Fatalf("ipv6 loopback probe = %d, want 1420", got)
	}
}

func listenWireGuardMTUProbeTarget(t *testing.T, network, address string) (net.PacketConn, int) {
	t.Helper()
	listener, err := net.ListenPacket(network, address)
	if err != nil {
		t.Fatalf("listen %s %s: %v", network, address, err)
	}
	return listener, listener.LocalAddr().(*net.UDPAddr).Port
}
