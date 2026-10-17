package main

import (
	"context"
	"testing"
	"time"
)

func TestProtocolGuardRateTiersNormalize(t *testing.T) {
	legacy := protocolGuardRateTiers(guardRule{RuleID: 1, ListenPort: 10, RateLimitScope: "User-1", LimitIn: 5, LimitOut: 6})
	if len(legacy) != 1 || legacy[0].Scope != "user-1" || legacy[0].In != 5 || legacy[0].Out != 6 {
		t.Fatalf("legacy tiers = %+v", legacy)
	}
	tiers := protocolGuardRateTiers(guardRule{RuleID: 1, ListenPort: 10, RateLimits: []guardRateTier{
		{Scope: " a ", In: 1},
		{Scope: "A", In: 2}, // 重复 scope 丢掉
		{Scope: "", In: 3},  // 空 scope 丢掉
		{Scope: "b"},        // 两个方向都不限，丢掉
		{Scope: "c", Out: 4, BurstOut: 1 << 20},
	}})
	if len(tiers) != 2 || tiers[0].Scope != "a" || tiers[1].Scope != "c" || tiers[1].BurstOut != 1<<20 {
		t.Fatalf("tiers = %+v", tiers)
	}
}

func TestProtocolGuardStackedTiersWaitOnEveryBucket(t *testing.T) {
	rule := guardRule{RuleID: 51, ListenPort: 25000, RateLimits: []guardRateTier{
		{Scope: t.Name() + "-user", In: 1024 * 1024},
		{Scope: t.Name() + "-host", In: 1},
	}}
	server := newProtocolGuardServer(rule)
	defer server.close()
	chain, _ := server.rateWaitChain(protocolGuardRateIn)
	if len(chain) != 2 {
		t.Fatalf("chain length = %d, want 2", len(chain))
	}
	// 第二级（整台主机）用完了：即使第一级很宽，也得等第二级。
	exhaustProtocolGuardLimiter(t, chain[1])
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if err := server.waitRate(ctx, protocolGuardRateIn, 1024); err == nil {
		t.Fatal("stacked tier did not throttle: the strictest bucket must apply")
	}
}

func TestProtocolGuardDirectionOnlyOnLaterTierStillLimits(t *testing.T) {
	// 第一级只限上行、第二级只限下行：下行方向不能被当成「不限速」走 splice。
	rule := guardRule{RuleID: 52, ListenPort: 25001, RateLimits: []guardRateTier{
		{Scope: t.Name() + "-a", In: 1024},
		{Scope: t.Name() + "-b", Out: 2048},
	}}
	server := newProtocolGuardServer(rule)
	defer server.close()
	out := server.rateLimiter(protocolGuardRateOut)
	if out == nil {
		t.Fatal("download limit on the second tier was ignored")
	}
	out.mu.Lock()
	rate := out.bytesPerSecond
	out.mu.Unlock()
	if rate != 2048 {
		t.Fatalf("download rate = %d, want 2048", rate)
	}
}

func TestProtocolGuardBurstTierUsesConfiguredDepth(t *testing.T) {
	depth := int64(8 * 1024 * 1024)
	rule := guardRule{RuleID: 53, ListenPort: 25002, RateLimits: []guardRateTier{
		{Scope: t.Name() + "-peak", In: 4 * 1024 * 1024},
		{Scope: t.Name() + "-sustain", In: 1024 * 1024, BurstIn: depth},
	}}
	server := newProtocolGuardServer(rule)
	defer server.close()
	chain, _ := server.rateWaitChain(protocolGuardRateIn)
	if len(chain) != 2 {
		t.Fatalf("chain length = %d", len(chain))
	}
	chain[1].mu.Lock()
	burst := chain[1].burst
	chain[1].mu.Unlock()
	if int64(burst) != depth {
		t.Fatalf("sustain bucket depth = %d, want %d", burst, depth)
	}
	// 一开始桶是满的：突发额度内不用等。
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	start := time.Now()
	if err := server.waitRate(ctx, protocolGuardRateIn, 256*1024); err != nil {
		t.Fatalf("burst allowance wait failed: %v", err)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatalf("burst allowance should pass immediately, took %s", time.Since(start))
	}
}

func TestProtocolGuardTierRemovalReleasesSharedBuckets(t *testing.T) {
	scope := t.Name() + "-host"
	rule := guardRule{RuleID: 54, ListenPort: 25003, RateLimits: []guardRateTier{
		{Scope: t.Name() + "-user", In: 1024},
		{Scope: scope, In: 2048},
	}}
	server := newProtocolGuardServer(rule)
	updated := rule
	updated.RateLimits = updated.RateLimits[:1]
	server.updateRateLimits(updated)
	protocolGuardRateMu.Lock()
	_, stillThere := protocolGuardRates[protocolGuardRateKey{scope: scope, direction: protocolGuardRateIn}]
	protocolGuardRateMu.Unlock()
	if stillThere {
		t.Fatal("removed tier kept its shared bucket alive")
	}
	server.close()
	protocolGuardRateMu.Lock()
	_, userThere := protocolGuardRates[protocolGuardRateKey{scope: t.Name() + "-user", direction: protocolGuardRateIn}]
	protocolGuardRateMu.Unlock()
	if userThere {
		t.Fatal("close did not release the remaining tier")
	}
}
