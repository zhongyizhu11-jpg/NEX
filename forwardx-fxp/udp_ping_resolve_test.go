package main

import (
	"context"
	"net"
	"net/netip"
	"testing"
	"time"
)

/*
F4：UDP 探活和数据走同一套地址解析（resolveHopAddress：IP 原样用、方括号里的 IPv6 去掉括号、域名走带缓存的解析）。
以前探活自己 JoinHostPort + 系统解析器：配成 [2001:db8::1] 的出口永远收不到应答（被判「没验证过」）；
DNS 抖一下，数据照常在走，探活却判 UDP 不通。
*/

// startUDPPongResponder 在 network/address 上起一个只回探活包的 UDP 端口（出口 / 中转的读循环里那一段）。
func startUDPPongResponder(t *testing.T, network, address string, cfg config) int {
	t.Helper()
	conn, err := net.ListenUDP(network, mustResolveUDP(t, network, address))
	if err != nil {
		t.Skipf("起不了 %s %s：%v", network, address, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	go func() {
		buf := make([]byte, 2048)
		for {
			n, from, err := conn.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			answerFXPUDPPing(conn, buf[:n], netip.AddrPortFrom(from.Addr().Unmap(), from.Port()), cfg)
		}
	}()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

func mustResolveUDP(t *testing.T, network, address string) *net.UDPAddr {
	t.Helper()
	addr, err := net.ResolveUDPAddr(network, address)
	if err != nil {
		t.Fatal(err)
	}
	return addr
}

// 这台机器可能没有 IPv6：方括号的处理用写成 IPv6 形式的 IPv4 地址（[::ffff:127.0.0.1]）也看得出来
// （数据那条路 resolveHopAddress 去掉括号；以前 JoinHostPort 又包一层，成了 [[::ffff:127.0.0.1]]:端口）。
func TestUDPPingStripsBracketsLikeTheDataPath(t *testing.T) {
	cfg := config{TunnelID: 243, Key: "f4-key"}
	port := startUDPPongResponder(t, "udp4", "127.0.0.1:0", cfg)
	if err := fxpUDPPing("[::ffff:127.0.0.1]", port, cfg); err != nil {
		t.Fatalf("地址带方括号：探活应该和数据一样去掉括号，得到 %v", err)
	}
}

func TestUDPPingAcceptsABracketedIPv6Host(t *testing.T) {
	cfg := config{TunnelID: 241, Key: "f4-key"}
	port := startUDPPongResponder(t, "udp6", "[::1]:0", cfg)
	if err := fxpUDPPing("[::1]", port, cfg); err != nil {
		t.Fatalf("出口地址配成 [::1]：探活应该收得到应答，得到 %v", err)
	}
	if err := fxpUDPPing("::1", port, cfg); err != nil {
		t.Fatalf("出口地址配成 ::1：探活应该收得到应答，得到 %v", err)
	}
}

func TestUDPPingResolvesLikeTheDataPath(t *testing.T) {
	flushHopResolverCache()
	defer flushHopResolverCache()
	setHopLookupHook(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.IPv4(127, 0, 0, 1)}}, nil
	})
	defer setHopLookupHook(nil)
	cfg := config{TunnelID: 242, Key: "f4-key"}
	port := startUDPPongResponder(t, "udp4", "127.0.0.1:0", cfg)
	started := time.Now()
	if err := fxpUDPPing("exit-f4.invalid", port, cfg); err != nil {
		t.Fatalf("出口地址是域名：探活应该和数据一样走 resolveHopAddress（带缓存的解析），得到 %v", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("对端第一个包就回了，一轮探活花了 %v", elapsed.Round(time.Millisecond))
	}
}
