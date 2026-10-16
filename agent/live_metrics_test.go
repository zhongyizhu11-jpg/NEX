package main

import (
	"errors"
	"testing"
	"time"
)

func TestNormalizeLiveMetricsInterval(t *testing.T) {
	cases := map[int]time.Duration{0: 0, -5: 0, 200: time.Second, 1000: time.Second, 2500: 2500 * time.Millisecond, 60000: 10 * time.Second}
	for in, want := range cases {
		if got := normalizeLiveMetricsInterval(in); got != want {
			t.Fatalf("normalizeLiveMetricsInterval(%d)=%v want %v", in, got, want)
		}
	}
}

func TestLiveMetricsRunStopsWhenPanelSaysZero(t *testing.T) {
	r := &liveMetricsRunner{}
	calls := 0
	var slept []time.Duration
	sent := r.run(Config{}, time.Second, func(payload map[string]any, out *liveMetricsResponse) error {
		calls++
		m, ok := payload["m"].([]any)
		if !ok || len(m) != 15 {
			t.Fatalf("payload m must carry 15 compact metrics, got %#v", payload["m"])
		}
		if calls < 3 {
			out.IntervalMs = 1000
		} else {
			out.IntervalMs = 0
		}
		return nil
	}, func(d time.Duration) { slept = append(slept, d) })
	if sent != 3 || calls != 3 {
		t.Fatalf("sent=%d calls=%d, want 3/3", sent, calls)
	}
	if len(slept) != 2 || slept[0] != time.Second {
		t.Fatalf("unexpected sleeps %v", slept)
	}
}

func TestLiveMetricsRunStopsAfterRepeatedErrors(t *testing.T) {
	r := &liveMetricsRunner{}
	calls := 0
	sent := r.run(Config{}, time.Second, func(map[string]any, *liveMetricsResponse) error {
		calls++
		return errors.New("panel unreachable")
	}, func(time.Duration) {})
	if sent != 0 || calls != liveMetricsMaxErrors {
		t.Fatalf("sent=%d calls=%d, want 0/%d", sent, calls, liveMetricsMaxErrors)
	}
}

func TestLiveMetricsCPUWindowIsItsOwn(t *testing.T) {
	if got := cpuUsagePercentBetween(cpuTimes{Idle: 100, Total: 200}, cpuTimes{Idle: 150, Total: 300}); got != 50 {
		t.Fatalf("cpu=%d want 50", got)
	}
	if got := cpuUsagePercentBetween(cpuTimes{Idle: 100, Total: 200}, cpuTimes{Idle: 100, Total: 200}); got != 0 {
		t.Fatalf("cpu=%d want 0", got)
	}
}
