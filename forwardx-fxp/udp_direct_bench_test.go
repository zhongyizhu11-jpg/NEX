package main

import (
	"net"
	"testing"
	"time"
)

// startUDPEchoTarget 是基准里的目标：原样回包。用 AddrPort 收发，自己不分配，
// 量出来的分配全是隧道两端的。
func startUDPEchoTarget(tb testing.TB) *net.UDPConn {
	tb.Helper()
	target, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		tb.Fatal(err)
	}
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := target.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			_, _ = target.WriteToUDPAddrPort(buf[:n], addr)
		}
	}()
	return target
}

// benchmarkUDPDirectRoundTrip 量入口 → 出口 → 目标 → 出口 → 入口一来一回的开销
// （含两端的加解密、排队和收发）。一问一答地发，不会因为队列溢出丢包。
func benchmarkUDPDirectRoundTrip(b *testing.B, payloadSize int) {
	target := startUDPEchoTarget(b)
	defer target.Close()
	exitConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		b.Fatal(err)
	}
	const (
		tunnelID = 901
		ruleID   = 902
		key      = "udp-direct-bench-key"
	)
	exitCfg := config{Role: "exit", TunnelID: tunnelID, Protocol: "udp", Key: key,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: target.LocalAddr().(*net.UDPAddr).Port}}}
	exitDone := make(chan error, 1)
	go func() { exitDone <- serveExitUDPDirect(exitConn, exitCfg) }()
	defer func() {
		_ = exitConn.Close()
		<-exitDone
	}()
	exitPort := exitConn.LocalAddr().(*net.UDPAddr).Port
	entryCfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: key,
		ExitHost: "127.0.0.1", ExitPort: exitPort, UDPExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: 9}
	listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		b.Fatal(err)
	}
	selector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: exitPort, UDPPort: exitPort, Key: key}, "")
	entryDone := make(chan error, 1)
	go func() { entryDone <- serveEntryUDPDirect(listener, entryCfg, selector, newLimiter(0), newLimiter(0)) }()
	defer func() {
		_ = listener.Close()
		<-entryDone
	}()
	client, err := net.DialUDP("udp", nil, listener.LocalAddr().(*net.UDPAddr))
	if err != nil {
		b.Fatal(err)
	}
	defer client.Close()
	payload := make([]byte, payloadSize)
	reply := make([]byte, 65535)
	roundTrip := func() bool {
		if _, err := client.Write(payload); err != nil {
			b.Fatal(err)
		}
		_ = client.SetReadDeadline(time.Now().Add(time.Second))
		n, err := client.Read(reply)
		return err == nil && n == payloadSize
	}
	// 先把会话建起来、池子热起来，不算进去。
	for i := 0; i < 64; i++ {
		roundTrip()
	}
	b.ReportAllocs()
	b.SetBytes(int64(2 * payloadSize))
	b.ResetTimer()
	lost := 0
	for i := 0; i < b.N; i++ {
		if !roundTrip() {
			lost++
		}
	}
	b.StopTimer()
	if lost > b.N/100+1 {
		b.Fatalf("lost %d of %d round trips", lost, b.N)
	}
}

// BenchmarkUDPDirectRoundTrip 是 UDP 直连热路径的分配基准：
//
//	go test -run '^$' -bench UDPDirectRoundTrip -benchtime 20000x .
func BenchmarkUDPDirectRoundTrip(b *testing.B) {
	b.Run("1000B", func(b *testing.B) { benchmarkUDPDirectRoundTrip(b, 1000) })
	b.Run("3000B-fragmented", func(b *testing.B) { benchmarkUDPDirectRoundTrip(b, 3000) })
}
