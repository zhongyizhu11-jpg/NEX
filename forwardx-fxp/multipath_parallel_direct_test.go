package main

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"testing"
	"time"
)

// 单连接多路并发：没有中转的直连隧道，入口把一条客户端连接拆到 N 条并行的安全连接上，
// 全部直连同一个出口，由出口重组。面板下发的就是「同一个出口地址重复 N 次」的腿，
// FXP 不需要新代码；这里钉住两件事：数据不乱，以及链路按单条 TCP 限速时带宽确实叠起来了。

// startPerConnThrottle 在 exitPort 前面放一个「每条 TCP 连接限速」的转发，模拟按流限速的跨境线路。
func startPerConnThrottle(t *testing.T, exitPort int, bytesPerSecond int) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen throttle: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	throttled := func(dst io.Writer, src io.Reader) {
		buf := make([]byte, 16*1024)
		start := time.Now()
		sent := 0
		for {
			n, err := src.Read(buf)
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					return
				}
				sent += n
				due := time.Duration(float64(sent) / float64(bytesPerSecond) * float64(time.Second))
				if wait := due - time.Since(start); wait > 0 {
					time.Sleep(wait)
				}
			}
			if err != nil {
				return
			}
		}
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(client net.Conn) {
				defer client.Close()
				upstream, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", exitPort))
				if err != nil {
					return
				}
				defer upstream.Close()
				done := make(chan struct{}, 2)
				go func() { throttled(upstream, client); done <- struct{}{} }()
				go func() { throttled(client, upstream); done <- struct{}{} }()
				<-done
			}(conn)
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

// startParallelDirectEntry 起一个出口和一个入口；入口对同一个地址（经限速转发）开 legs 条腿。
// legs = 1 时就是普通单路（老版本 / 没开并发时的样子）。
func startParallelDirectEntry(t *testing.T, tunnelID int, legs int, bytesPerSecond int) int {
	t.Helper()
	targetPort, stopTarget := startEchoTarget(t)
	t.Cleanup(stopTarget)
	exitKey := fmt.Sprintf("parallel-direct-key-%d", tunnelID)
	exitPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	t.Cleanup(func() { close(exitDone) })
	go func() {
		_ = runExit(exitDone, config{Role: "exit", TunnelID: tunnelID, ListenPort: exitPort, Protocol: "tcp", Key: exitKey, TargetIP: "127.0.0.1", TargetPort: targetPort})
	}()
	waitForTCPPort(t, exitPort)
	via := exitPort
	if bytesPerSecond > 0 {
		via = startPerConnThrottle(t, exitPort, bytesPerSecond)
	}
	cfg := config{
		Role: "entry", TunnelID: tunnelID, RuleID: tunnelID + 1, ListenPort: freeTCPPort(t), Protocol: "tcp",
		ExitHost: "127.0.0.1", ExitPort: via, Key: exitKey, TargetIP: "127.0.0.1", TargetPort: targetPort,
	}
	if legs >= 2 {
		cfg.MultipathEnabled = true
		for i := 0; i < legs; i++ {
			cfg.MultipathLegs = append(cfg.MultipathLegs, multipathLeg{Host: "127.0.0.1", Port: via, Key: exitKey, Via: fmt.Sprintf("stream#%d", i+1)})
		}
	}
	entryDone := make(chan struct{})
	t.Cleanup(func() { close(entryDone) })
	go func() { _ = runEntry(entryDone, cfg) }()
	waitForTCPPort(t, cfg.ListenPort)
	return cfg.ListenPort
}

func TestParallelDirectLegsToTheSameExitPreservePayload(t *testing.T) {
	entryPort := startParallelDirectEntry(t, 9300, 4, 0)
	payload := make([]byte, 1024*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	for round := 0; round < 3; round++ {
		if got := echoThroughEntry(t, entryPort, payload); !bytes.Equal(got, payload) {
			t.Fatalf("round %d: payload corrupted across parallel legs", round)
		}
	}
}

func TestParallelDirectLegsAggregatePerConnectionThrottledBandwidth(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	const perConn = 1 << 20 // 每条 TCP 连接 1 MiB/s
	payload := make([]byte, 3<<20)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	measure := func(tunnelID, legs int) time.Duration {
		entryPort := startParallelDirectEntry(t, tunnelID, legs, perConn)
		start := time.Now()
		if got := echoThroughEntry(t, entryPort, payload); !bytes.Equal(got, payload) {
			t.Fatalf("legs=%d: payload corrupted", legs)
		}
		return time.Since(start)
	}
	single := measure(9310, 1)
	parallel := measure(9320, 4)
	t.Logf("3 MiB echo over a 1 MiB/s-per-connection link: single=%v, 4 parallel legs=%v", single, parallel)
	if parallel*2 > single {
		t.Fatalf("4 parallel legs should be well over twice as fast as one: single=%v parallel=%v", single, parallel)
	}
}
