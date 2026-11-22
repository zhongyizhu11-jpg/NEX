package main

import (
	"testing"
	"time"
)

// 「多久探一次目标」最多 300 秒（Passive）；线路组下一跳仍最多 30 秒。判坏以后的退避不能比节拍更勤（2.3.541）。
func TestRouteHopPassiveIntervalCeilingAndBackoffNotFaster(t *testing.T) {
	if got := normalizeRouteHopProbeSpec(routeHopProbeSpec{IntervalMs: 120000, Passive: true}).IntervalMs; got != 120000 {
		t.Fatalf("passive 120s clamped to %d", got)
	}
	if got := normalizeRouteHopProbeSpec(routeHopProbeSpec{IntervalMs: 900000, Passive: true}).IntervalMs; got != 300000 {
		t.Fatalf("passive 900s clamped to %d want 300000", got)
	}
	if got := normalizeRouteHopProbeSpec(routeHopProbeSpec{IntervalMs: 120000}).IntervalMs; got != 30000 {
		t.Fatalf("hop 120s clamped to %d want 30000", got)
	}
	for _, streak := range []int{0, 1, 5} {
		state := &routeHopProbeState{spec: routeHopProbeSpec{IntervalMs: 120000, FailThreshold: 2, Passive: true}, down: true, rejectStreak: streak}
		if got := routeHopProbeInterval(state); got != 120*time.Second {
			t.Fatalf("rejectStreak=%d: down interval %v want 120s", streak, got)
		}
	}
	state := &routeHopProbeState{spec: routeHopProbeSpec{IntervalMs: 10000, FailThreshold: 2, Passive: true}, down: true, rejectStreak: 6}
	if got := routeHopProbeInterval(state); got != 60*time.Second {
		t.Fatalf("10s cadence rejected backoff %v want 60s", got)
	}
}

func TestRouteHopProbeIntervalStretchesWhenExitIsIdle(t *testing.T) {
	originalNow := routeHopIntervalNow
	t.Cleanup(func() { routeHopIntervalNow = originalNow })
	now := time.Date(2026, 11, 22, 13, 0, 0, 0, time.UTC)
	routeHopIntervalNow = func() time.Time { return now }

	// 出口到目标（Passive）：目标通着、60 秒没真实流量 → 至少 30 秒一次，高防目标不会被闲着的出口每 10 秒连一下
	state := &routeHopProbeState{spec: routeHopProbeSpec{IntervalMs: 10000, FailThreshold: 2, RecoverOks: 3, Passive: true}, known: true}
	if got := routeHopProbeInterval(state); got != 30*time.Second {
		t.Fatalf("idle healthy exit target: got %v want 30s", got)
	}
	// 刚看到真实连接：照面板的节拍
	state.passiveSeenAt = now.Add(-20 * time.Second)
	if got := routeHopProbeInterval(state); got != 10*time.Second {
		t.Fatalf("exit with live traffic keeps its pace: got %v", got)
	}
	// 连不上（还没判坏）：照节拍探，判坏不变慢
	state.passiveSeenAt = time.Time{}
	state.fails = 1
	if got := routeHopProbeInterval(state); got != 10*time.Second {
		t.Fatalf("failing target keeps its pace: got %v", got)
	}
	// 还不知道通不通（刚下发）：照节拍探
	state.fails = 0
	state.known = false
	if got := routeHopProbeInterval(state); got != 10*time.Second {
		t.Fatalf("unknown target keeps its pace: got %v", got)
	}
	// 线路组的下一跳（不是 Passive）不放慢
	hop := &routeHopProbeState{spec: routeHopProbeSpec{IntervalMs: 1500, FailThreshold: 2}, known: true}
	if got := routeHopProbeInterval(hop); got != 1500*time.Millisecond {
		t.Fatalf("route group hops keep their pace: got %v", got)
	}
}
