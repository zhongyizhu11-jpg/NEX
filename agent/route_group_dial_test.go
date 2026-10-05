package main

import (
	"context"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func setFailoverTCPDialHookForTest(t *testing.T, hook failoverDialFunc) {
	t.Helper()
	failoverTCPDialHook.Store(&hook)
	t.Cleanup(func() { failoverTCPDialHook.Store(nil) })
}

// 一轮健康探测并行：5 条各要 300 ms 的路径，一轮不该要 1.5 秒。
func TestFailoverHealthProbesRunInParallel(t *testing.T) {
	oldPing := failoverPingLatency
	var inflight, peak atomic.Int32
	failoverPingLatency = func(host string, timeout time.Duration, count int) (int, bool, string) {
		current := inflight.Add(1)
		for {
			old := peak.Load()
			if current <= old || peak.CompareAndSwap(old, current) {
				break
			}
		}
		time.Sleep(300 * time.Millisecond)
		inflight.Add(-1)
		return 5, true, ""
	}
	defer func() { failoverPingLatency = oldPing }()

	targets := make([]failoverTarget, 5)
	for i := range targets {
		targets[i] = failoverTarget{TargetIP: "192.0.2." + strconv.Itoa(i+1), TargetPort: 53}
	}
	start := time.Now()
	latencies, results := probeFailoverTargets("udp", targets)
	elapsed := time.Since(start)
	if elapsed > time.Second {
		t.Fatalf("probing %d targets took %v; probes are still serial", len(targets), elapsed)
	}
	if peak.Load() < 2 {
		t.Fatalf("peak concurrent probes = %d", peak.Load())
	}
	for i := range targets {
		if !results[i] || latencies[i] != 5 {
			t.Fatalf("target %d result=%v latency=%d", i, results[i], latencies[i])
		}
	}
}

func TestFailoverProbeParallelismIsBounded(t *testing.T) {
	oldPing := failoverPingLatency
	var inflight, peak atomic.Int32
	failoverPingLatency = func(host string, timeout time.Duration, count int) (int, bool, string) {
		current := inflight.Add(1)
		for {
			old := peak.Load()
			if current <= old || peak.CompareAndSwap(old, current) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		inflight.Add(-1)
		return 1, true, ""
	}
	defer func() { failoverPingLatency = oldPing }()
	targets := make([]failoverTarget, 3*failoverProbeParallelism)
	for i := range targets {
		targets[i] = failoverTarget{TargetIP: "192.0.2.1", TargetPort: i + 1}
	}
	probeFailoverTargets("udp", targets)
	if peak.Load() > failoverProbeParallelism {
		t.Fatalf("peak concurrent probes %d exceeds bound %d", peak.Load(), failoverProbeParallelism)
	}
}

// 域名目标命中解析缓存时直接拨缓存地址，不再每条连接查一次 DNS。
func TestFailoverTCPDialReusesResolveCache(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port

	oldLookup := failoverUDPLookup
	var lookups atomic.Int32
	failoverUDPLookup = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		lookups.Add(1)
		return []net.IPAddr{{IP: net.IPv4(127, 0, 0, 1)}}, nil
	}
	var mu sync.Mutex
	dialed := []string{}
	setFailoverTCPDialHookForTest(t, func(ctx context.Context, network, address string) (net.Conn, error) {
		mu.Lock()
		dialed = append(dialed, address)
		mu.Unlock()
		if host, _, _ := net.SplitHostPort(address); host != "127.0.0.1" {
			// 模拟按域名拨：真拨一个本机地址，但记下来走的是这条路。
			address = net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
		}
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, address)
	})
	defer func() {
		failoverUDPLookup = oldLookup
		failoverUDPResolveMu.Lock()
		failoverUDPResolveCache = map[string]failoverUDPResolveEntry{}
		failoverUDPResolveMu.Unlock()
	}()

	target := failoverTarget{TargetIP: "tcp-cache.test.invalid", TargetPort: port}
	// 第一次没命中：按域名拨（行为和以前一样），同时后台解析。
	conn, err := failoverDialTCP(context.Background(), target, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for failoverCachedTargetIP(target.TargetIP, port) == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	for i := 0; i < 5; i++ {
		conn, err := failoverDialTCP(context.Background(), target, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.Close()
	}
	mu.Lock()
	defer mu.Unlock()
	want := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	for _, address := range dialed[1:] {
		if address != want {
			t.Fatalf("cached dial used %q, want %q (all: %v)", address, want, dialed)
		}
	}
	if got := lookups.Load(); got != 1 {
		t.Fatalf("resolver queried %d times for 6 connections", got)
	}
	if failoverCachedTargetIP("127.0.0.1", port) != nil {
		t.Fatal("IP targets must keep dialing the literal address")
	}
}

// 起两条 TCP 路径，各自在连上时回一个标记，用来认出连接走的是哪条。
func failoverTaggedBackend(t *testing.T, tag string) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = conn.Write([]byte(tag))
				_, _ = io.Copy(io.Discard, conn)
			}()
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

func runRaceDialScenario(t *testing.T, ruleID int, strategy string) (string, time.Duration, *failoverProxy, *atomic.Int32) {
	t.Helper()
	oldDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldDir })
	slowPort := failoverTaggedBackend(t, "S")
	fastPort := failoverTaggedBackend(t, "F")
	slowAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(slowPort))
	var lateConns atomic.Int32
	setFailoverTCPDialHookForTest(t, func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == slowAddr {
			// 握手卡 1.2 秒才完成的路径（丢 SYN 重传之类）。
			select {
			case <-time.After(1200 * time.Millisecond):
				lateConns.Add(1)
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, address)
	})

	listenPort := failoverTestPort(t)
	spec := failoverTestSpec(listenPort)
	spec.Strategy = strategy
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: slowPort}, {TargetIP: "127.0.0.1", TargetPort: fastPort}}
	sourcePort := 60000 + ruleID%1000
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("proxy did not start")
	}
	proxy := currentFailoverProxy(ruleID, sourcePort)
	if strategy == "round_robin" {
		proxy.mu.Lock()
		proxy.roundRobinNext = 0 // 第一条连接挑慢的那条
		proxy.mu.Unlock()
	}
	start := time.Now()
	client, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(listenPort)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	tag := make([]byte, 1)
	if _, err := io.ReadFull(client, tag); err != nil {
		t.Fatal(err)
	}
	return string(tag), time.Since(start), proxy, &lateConns
}

// 轮流策略：选中的路径握手太慢时竞速拨另一条健康路径，先连上的赢，慢的那条被取消，
// 而且不算它拨号失败。
func TestFailoverRaceDialUsesFasterHealthyPath(t *testing.T) {
	tag, elapsed, proxy, late := runRaceDialScenario(t, 970001, "round_robin")
	if tag != "F" {
		t.Fatalf("connection went to %q, want the racing fast path", tag)
	}
	if elapsed > time.Second {
		t.Fatalf("racing dial took %v", elapsed)
	}
	time.Sleep(1300 * time.Millisecond)
	if late.Load() != 0 {
		t.Fatal("losing dial was not canceled")
	}
	proxy.mu.Lock()
	failures := proxy.statsLocked(0).consecutiveFailures
	proxy.mu.Unlock()
	if failures != 0 {
		t.Fatalf("canceled losing dial was recorded as %d failure(s)", failures)
	}
}

// 主备策略不竞速：慢也要等主路径。
func TestFailoverFallbackStrategyDoesNotRace(t *testing.T) {
	tag, elapsed, _, _ := runRaceDialScenario(t, 970002, "fallback")
	if tag != "S" {
		t.Fatalf("fallback strategy connection went to %q, want the active path", tag)
	}
	if elapsed < time.Second {
		t.Fatalf("fallback strategy raced (connected after %v)", elapsed)
	}
}

func TestFailoverIPHashStrategyDoesNotRace(t *testing.T) {
	p := &failoverProxy{spec: failoverSpec{Strategy: "ip_hash", Targets: []failoverTarget{{}, {}}}}
	if p.raceAllowedLocked() {
		t.Fatal("ip_hash must keep a visitor on its hashed path")
	}
	p.spec.Strategy = "fallback"
	if p.raceAllowedLocked() {
		t.Fatal("fallback must keep connections on the active path")
	}
	p.spec.Strategy = "weighted"
	if !p.raceAllowedLocked() {
		t.Fatal("weighted strategy should race")
	}
}

// 本身往返就慢的健康路径按探测耗时放宽竞速延迟，不会被系统性地抢走连接。
func TestFailoverRaceDelayAdaptsToProbeLatency(t *testing.T) {
	p := &failoverProxy{spec: failoverSpec{Targets: []failoverTarget{{}, {}}}, lastLatencyMs: []int{40, 400}}
	if got := p.raceDelayLocked(0); got != failoverRaceDelayMin {
		t.Fatalf("near path delay = %v", got)
	}
	if got := p.raceDelayLocked(1); got != 800*time.Millisecond {
		t.Fatalf("far path delay = %v, want 800ms", got)
	}
}

// 缓存里的地址被黑洞（只有另一个地址族能通）时，不能把整个超时耗在它上面：
// 留一半时间按域名拨，让解析器把所有地址都试一遍。
func TestFailoverTCPDialFallsBackWhenCachedAddressHangs(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port

	oldLookup := failoverUDPLookup
	failoverUDPLookup = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.IPv4(192, 0, 2, 1)}}, nil
	}
	setFailoverTCPDialHookForTest(t, func(ctx context.Context, network, address string) (net.Conn, error) {
		if host, _, _ := net.SplitHostPort(address); host == "192.0.2.1" {
			<-ctx.Done() // 黑洞：一直不回，直到超时
			return nil, ctx.Err()
		}
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	})
	defer func() {
		failoverUDPLookup = oldLookup
		failoverUDPResolveMu.Lock()
		failoverUDPResolveCache = map[string]failoverUDPResolveEntry{}
		failoverUDPResolveMu.Unlock()
	}()

	target := failoverTarget{TargetIP: "tcp-cache-hang.test.invalid", TargetPort: port}
	if conn, err := failoverDialTCP(context.Background(), target, 2*time.Second); err == nil {
		_ = conn.Close()
	}
	deadline := time.Now().Add(2 * time.Second)
	for failoverCachedTargetIP(target.TargetIP, port) == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if failoverCachedTargetIP(target.TargetIP, port) == nil {
		t.Fatal("resolve cache was not populated")
	}
	start := time.Now()
	conn, err := failoverDialTCP(context.Background(), target, 2*time.Second)
	if err != nil {
		t.Fatalf("hostname fallback did not run after the cached address hung: %v", err)
	}
	_ = conn.Close()
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Fatalf("cached attempt used more than half the budget: %v", elapsed)
	}
}
