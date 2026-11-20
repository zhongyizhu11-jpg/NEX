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
