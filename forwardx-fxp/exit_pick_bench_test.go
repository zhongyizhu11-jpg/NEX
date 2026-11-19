package main

import (
	"testing"
	"time"
)

// 挑出口的开销（X12）：三台会回报的出口，每台攒满 30 个样本，按各策略挑。
// 目标：「自动」每次 ≤ 2µs、≤ 4 次分配（目标感知刚上线时是 59 次分配，全在规则锁里）。
func benchmarkTargetAwarePick(b *testing.B, strategy string) {
	selector := targetAwareSelector(strategy, nil)
	selector.random = seededExitRandom(20261118)
	for i := 0; i < fxpTargetWindow; i++ {
		for index := 0; index < 3; index++ {
			selector.observeTarget(index, true, time.Duration(30+index*7+i%5)*time.Millisecond)
		}
	}
	for index := 0; index < 3; index++ {
		selector.loads[index].observeLatency(time.Duration(20+index*3)*time.Millisecond, time.Now())
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, ok := selector.pick(nil, "203.0.113.7"); !ok {
			b.Fatal("挑不出端点")
		}
	}
}

func BenchmarkPickAutoTargetAware(b *testing.B)       { benchmarkTargetAwarePick(b, "auto") }
func BenchmarkPickLatencyTargetAware(b *testing.B)    { benchmarkTargetAwarePick(b, "latency") }
func BenchmarkPickIPHashTargetAware(b *testing.B)     { benchmarkTargetAwarePick(b, "ip_hash") }
func BenchmarkPickRoundRobinTargetAware(b *testing.B) { benchmarkTargetAwarePick(b, "round_robin") }
func BenchmarkPickFallbackTargetAware(b *testing.B)   { benchmarkTargetAwarePick(b, "fallback") }
