package main

import (
	"context"
	"errors"
	"net"
	"os"
	"syscall"
	"testing"
	"time"
)

// 真机上 ss -tinH state established 的输出（两条到 160.79.104.10:443，一条闲了很久）
const ssSample = `0      0      192.0.2.2:36534 160.79.104.10:443
	 bbr wscale:6,10 rto:204 rtt:12.5/1.5 ato:40 mss:1348 segs_out:133 segs_in:107 lastsnd:79996 lastrcv:79952 lastack:79000 minrtt:10.2
0      0      192.0.2.2:36582 160.79.104.10:443
	 bbr wscale:6,10 rto:208 rtt:11.0/1.0 ato:40 mss:1348 segs_out:102 segs_in:102 retrans:0/4 lastsnd:20 lastrcv:440 lastack:440 minrtt:9.8
0      0      192.0.2.2:36626 [::ffff:160.79.104.10]:443
	 bbr wscale:6,10 rto:204 rtt:13.0/1.0 ato:40 mss:1348 segs_out:334 segs_in:225 lastsnd:1032 lastrcv:936 lastack:936 minrtt:9.9
0      0      192.0.2.2:40000 198.51.100.7:80
	 cubic rtt:200/10 segs_out:10 lastack:1 lastrcv:1 minrtt:190
`

func TestParseSSConnectionsReadsKernelRTT(t *testing.T) {
	conns := parseSSConnections([]byte(ssSample))
	if len(conns) != 4 {
		t.Fatalf("four connections: %#v", conns)
	}
	second := conns[1]
	if second.srttMs != 11.0 || second.varMs != 1.0 || second.minRttMs != 9.8 || second.retrans != 4 || second.segsOut != 102 || second.idleMs != 440 {
		t.Fatalf("rtt / rttvar / minrtt / retrans total / segs_out / idle parsed: %#v", second)
	}
	if normalizePassiveTarget(conns[2].peer) != "160.79.104.10:443" {
		t.Fatalf("IPv4-mapped IPv6 peer folds onto the IPv4 target: %q", conns[2].peer)
	}
}

func TestPassiveScannerOnlyCountsRecentConnections(t *testing.T) {
	scanner := newPassiveRTTScanner()
	var gotArgs []string
	scanner.run = func(ctx context.Context, args []string) ([]byte, error) {
		gotArgs = args
		return []byte(ssSample), nil
	}
	now := time.Unix(1_800_000_000, 0)
	stats := scanner.scan([]string{"160.79.104.10:443", "example.com:443"}, now)
	target := stats["160.79.104.10:443"]
	// 闲了 79 秒的那条不算：只剩两条，延迟 = 平滑 RTT 减一个波动（10、12），中位数 11
	if target.conns != 2 || target.srttMs != 11.0 || target.varMs != 1.0 || target.minMs != 9.8 {
		t.Fatalf("median of the recently active connections: %#v", target)
	}
	if _, ok := stats["198.51.100.7:80"]; ok {
		t.Fatalf("connections to targets nobody asked about are ignored")
	}
	if len(gotArgs) < 6 || gotArgs[0] != "-tinH" || gotArgs[4] != "dst" || gotArgs[5] != "160.79.104.10:443" {
		t.Fatalf("one ss call filtered to the wanted IP targets (domains skipped): %#v", gotArgs)
	}
	// 第二次扫描：同一条连接前后相减得到这段时间的重传比例
	scanner.run = func(ctx context.Context, args []string) ([]byte, error) {
		return []byte(`0 0 192.0.2.2:36582 160.79.104.10:443
	 rtt:11.0/2.5 segs_out:202 retrans:0/14 lastack:10 lastrcv:10 minrtt:9.8
`), nil
	}
	again := scanner.scan([]string{"160.79.104.10:443"}, now.Add(2*time.Second))["160.79.104.10:443"]
	if again.segsDelta != 100 || again.retransDelta != 10 {
		t.Fatalf("retransmits per sent segment between scans: %#v", again)
	}
}

func TestRouteHopPrefersRealTrafficOverNewConnections(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := true
	runner := routeHopTestRunner(&clock, &reachable)
	dials := 0
	runner.dial = func(network, address string, timeout time.Duration) (net.Conn, error) {
		dials++
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	}
	runner.scanner.run = func(ctx context.Context, args []string) ([]byte, error) {
		return []byte(ssSample), nil
	}
	spec := &routeHopProbeSpec{IntervalMs: 2000, Passive: true}
	runner.sync([]ruleLatencyProbe{{RuleID: 9, TargetIP: "160.79.104.10", TargetPort: 443, RouteHop: spec}})
	for round := 0; round < 3; round++ {
		runner.scanPassive()
		for _, state := range runner.due() {
			if !runner.usePassive(state) {
				runner.probe(state)
			}
		}
		clock = clock.Add(2 * time.Second)
	}
	if dials != 0 {
		t.Fatalf("with live connections to the target no extra connections are opened: %d dials", dials)
	}
	results := runner.report()
	if len(results) != 1 || results[0]["source"] != "traffic" || results[0]["medianMs"] != 11.0 || results[0]["jitterMs"] != 1.0 || results[0]["conns"] != 2 {
		t.Fatalf("report says the numbers come from real traffic: %#v", results)
	}
}

func TestRouteHopRetransmittedHandshakeCountsAsLossNotLatency(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := true
	runner := routeHopTestRunner(&clock, &reachable)
	attempt := 0
	delays := []time.Duration{}
	runner.dial = func(network, address string, timeout time.Duration) (net.Conn, error) {
		delay := 10 * time.Millisecond
		if attempt < len(delays) {
			delay = delays[attempt]
		}
		attempt++
		if delay >= timeout {
			clock = clock.Add(timeout)
			return nil, errors.New("timeout")
		}
		clock = clock.Add(delay)
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	}
	spec := &routeHopProbeSpec{IntervalMs: 2000, TimeoutMs: 2000}
	runner.sync([]ruleLatencyProbe{{RuleID: 5, TargetIP: "203.0.113.5", TargetPort: 443, RouteHop: spec}})
	var state *routeHopProbeState
	for _, s := range runner.states {
		state = s
	}
	for round := 0; round < 10; round++ {
		attempt, delays = 0, nil
		runner.probe(state)
	}
	// 一轮里第一次握手包丢了（系统 1 秒后重发才连上），后面两次正常：这一轮算 10ms，不算 1000ms
	attempt, delays = 0, []time.Duration{1010 * time.Millisecond, 10 * time.Millisecond, 11 * time.Millisecond}
	runner.probe(state)
	stats := state.stats()
	if stats.median != 10 || stats.jitter != 0 || stats.loss != 0 {
		t.Fatalf("a retransmitted SYN no longer turns into a 1s latency spike: %#v", stats)
	}
	// 整轮三次都拖到重发：这一轮算不通
	attempt, delays = 0, []time.Duration{1010 * time.Millisecond, 1010 * time.Millisecond, 1010 * time.Millisecond}
	runner.probe(state)
	if stats := state.stats(); stats.loss == 0 || stats.median != 10 {
		t.Fatalf("a round with every handshake retransmitted counts as lost: %#v", stats)
	}
}

func TestRouteHopJitterIsQueueingDelayNotNeighbourDiffs(t *testing.T) {
	state := &routeHopProbeState{}
	push := func(ms float64) {
		state.samples[state.pos] = routeHopSample{ms: ms, ok: true}
		state.pos = (state.pos + 1) % routeHopProbeWindow
		if state.count < routeHopProbeWindow {
			state.count++
		}
	}
	for i := 0; i < 29; i++ {
		push(10 + float64(i%3))
	}
	push(300) // 一次尖峰
	stats := state.stats()
	if stats.jitter > 3 {
		t.Fatalf("one spike in 30 does not move the 90th percentile of queueing delay: %#v", stats)
	}
	if stats.minMs != 10 {
		t.Fatalf("path floor reported: %#v", stats)
	}
}

func TestRouteHopDownExitProbesBackOffAndUseOneConnection(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := false
	runner := routeHopTestRunner(&clock, &reachable)
	dials := 0
	runner.dial = func(network, address string, timeout time.Duration) (net.Conn, error) {
		dials++
		if reachable {
			client, server := net.Pipe()
			_ = server.Close()
			return client, nil
		}
		// 目标主动拒绝（高防拦了这台出口）：这种才放慢到 60 秒
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	}
	runner.scanner = nil
	spec := &routeHopProbeSpec{IntervalMs: 2000, FailThreshold: 2, RecoverOks: 3, Passive: true}
	runner.sync([]ruleLatencyProbe{{RuleID: 8, TargetIP: "203.0.113.8", TargetPort: 443, RouteHop: spec}})
	var state *routeHopProbeState
	for _, s := range runner.states {
		state = s
	}
	gaps := []time.Duration{}
	for round := 0; round < 7; round++ {
		before := dials
		for _, due := range runner.due() {
			runner.probe(due)
		}
		if round >= 2 && dials-before > 1 {
			t.Fatalf("a down exit gets one connection per round, got %d", dials-before)
		}
		gaps = append(gaps, state.nextDue.Sub(clock))
		clock = state.nextDue
	}
	if !state.down {
		t.Fatalf("exit should be down")
	}
	// 2s 2s 之后判坏：4s 8s 16s 32s 60s
	want := []time.Duration{2 * time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 32 * time.Second, 60 * time.Second}
	for i := range want {
		if gaps[i] != want[i] {
			t.Fatalf("backoff after going down: got %v want %v", gaps, want)
		}
	}
	// 线路组的下一跳（不是 Passive）不放慢
	runner.sync([]ruleLatencyProbe{{RuleID: 9, TargetIP: "203.0.113.9", TargetPort: 443, RouteHop: &routeHopProbeSpec{IntervalMs: 1500, FailThreshold: 2}}})
	for _, s := range runner.states {
		s.down, s.fails = true, 10
		if routeHopProbeInterval(s) != 1500*time.Millisecond {
			t.Fatalf("route group hops keep their pace")
		}
	}
}
