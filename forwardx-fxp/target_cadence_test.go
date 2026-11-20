package main

import (
	"testing"
	"time"
)

// 2.3.541：探规则目标的节拍（targetProbeSeconds）和探出口机的（intervalSeconds）分开；老面板不带新字段时照旧。
func TestResolveBalanceDetectTargetInterval(t *testing.T) {
	if d := resolveBalanceDetect(nil); d.targetInterval != 2*time.Second || d.interval != 2*time.Second {
		t.Fatalf("nil detect: interval=%v target=%v", d.interval, d.targetInterval)
	}
	old := resolveBalanceDetect(&balanceDetectConfig{IntervalSeconds: 1})
	if old.targetInterval != time.Second || old.interval != time.Second {
		t.Fatalf("old panel (no targetProbeSeconds) keeps probing the target at intervalSeconds: %+v", old)
	}
	d := resolveBalanceDetect(&balanceDetectConfig{IntervalSeconds: 1, TargetProbeSeconds: 10})
	if d.interval != time.Second || d.targetInterval != 10*time.Second {
		t.Fatalf("split cadence: interval=%v target=%v", d.interval, d.targetInterval)
	}
	if d := resolveBalanceDetect(&balanceDetectConfig{TargetProbeSeconds: 1}); d.targetInterval != 2*time.Second {
		t.Fatalf("target clamps to >= 2s: %v", d.targetInterval)
	}
	if d := resolveBalanceDetect(&balanceDetectConfig{TargetProbeSeconds: 900}); d.targetInterval != 300*time.Second {
		t.Fatalf("target clamps to <= 300s: %v", d.targetInterval)
	}
	// 端点（出口机）探测仍按 interval
	if tuning := fxpProbeTuningFor(config{BalanceDetect: &balanceDetectConfig{IntervalSeconds: 1, TargetProbeSeconds: 10}}); tuning.recoverGap != time.Second {
		t.Fatalf("endpoint recoverGap should follow intervalSeconds: %v", tuning.recoverGap)
	}
}

func TestTargetProbeIntervalUsesTargetCadence(t *testing.T) {
	d := resolveBalanceDetect(&balanceDetectConfig{IntervalSeconds: 1, TargetProbeSeconds: 10, FailThreshold: 2})
	h := &targetHealth{}
	if got := targetProbeInterval(h, d); got != 10*time.Second {
		t.Fatalf("healthy exit probes the target every targetProbeSeconds: %v", got)
	}
	long := resolveBalanceDetect(&balanceDetectConfig{TargetProbeSeconds: 120, FailThreshold: 2})
	h = &targetHealth{}
	start := time.Now()
	for i := 0; i < 6; i++ {
		h.observe(false, 0, start.Add(time.Duration(i)*time.Second), long)
		if got := targetProbeInterval(h, long); got != 120*time.Second {
			t.Fatalf("a down exit must not be probed faster than the 120s cadence: %v", got)
		}
	}
	if got := targetDownFreshFor(long); got != 270*time.Second {
		t.Fatalf("down freshness with 120s cadence: %v", got)
	}
	if got := targetDownFreshFor(d); got != fxpTargetDownFresh {
		t.Fatalf("down freshness with 10s cadence: %v", got)
	}
}
