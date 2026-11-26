package main

import (
	"sync/atomic"
	"testing"
	"time"
)

// 诊断不通时不再排队等每次超时（用户 2026-11-26：目标不通时一直「诊断中」）：错开并行，通了马上报。
func TestSelfTestHedgedProbeReturnsFirstSuccessAndFailsFast(t *testing.T) {
	var calls atomic.Int32
	// 第一次是黑洞（等满超时），第二次通：结果应当在第二次通的时候就回来，不等第一次超时
	started := time.Now()
	latency, ok, _ := selfTestHedgedProbe(4, 20*time.Millisecond, func() (int, bool, string) {
		if calls.Add(1) == 1 {
			time.Sleep(time.Second)
			return 0, false, ""
		}
		return 7, true, "203.0.113.5"
	})
	if !ok || latency != 7 {
		t.Fatalf("应当拿到第二次通的结果：ok=%v latency=%d", ok, latency)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("通了应当马上回，用了 %s", elapsed)
	}

	// 都不通：约 (次数-1)×错开 + 单次超时，而不是次数×超时
	started = time.Now()
	_, ok, resolved := selfTestHedgedProbe(4, 20*time.Millisecond, func() (int, bool, string) {
		time.Sleep(200 * time.Millisecond)
		return 0, false, "203.0.113.9"
	})
	elapsed := time.Since(started)
	if ok || resolved != "203.0.113.9" {
		t.Fatalf("都不通应当报不通并带上解析结果：ok=%v resolved=%q", ok, resolved)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("四次并行都不通应当约 260 毫秒，用了 %s（排队要 800 毫秒）", elapsed)
	}
}

// 出口直接探目标（forward-via-tunnel）不等本机运行时；经过本机隧道的和走 WireGuard 的还要等。
func TestSelfTestRuntimeDependence(t *testing.T) {
	if selfTestDependsOnRuntime(selfTest{Kind: "forward-via-tunnel"}) {
		t.Fatal("forward-via-tunnel 是出口直接连目标，不该等运行时")
	}
	if !selfTestDependsOnRuntime(selfTest{Kind: "forward-via-tunnel", WireGuardPeerID: "peer"}) {
		t.Fatal("走 WireGuard 的要等运行时")
	}
	for _, kind := range []string{"tunnel", "tunnel-hop", "forward-via-tunnel-entry", "forward-chain"} {
		if !selfTestDependsOnRuntime(selfTest{Kind: kind}) {
			t.Fatalf("%s 经过本机运行时，要等", kind)
		}
	}
	if selfTestTCPAttempts(selfTest{Kind: "forward-via-tunnel"}) < 2 {
		t.Fatal("出口探目标仍然要多试几次（并行），一次丢包不算不通")
	}
}
