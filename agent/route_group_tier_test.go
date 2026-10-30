package main

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

/*
分层线路组（Tier）、整条链路评分（ExtraLatencyMs）、投递方式（Delivery）、换出站立刻探测。

这些字段都不带的规格（老面板）必须和以前逐字一样：签名不变、候选不变、评分不变。
*/

func tierPtr(tier int) *int { return &tier }

// 4 条出站：0、1 是主线路组，2、3 是备用组。
func tieredTargets(tiers ...int) []failoverTarget {
	targets := routeTargets(len(tiers))
	for i, tier := range tiers {
		targets[i].Tier = tierPtr(tier)
	}
	return targets
}

func TestTierAndDeliveryFieldsNormalizeAndSign(t *testing.T) {
	legacy := failoverTestSpec(65020)
	legacySig := failoverSignature(normalizeFailoverSpec(legacy))

	// 不带新字段（或 Delivery 是不认识的值）时签名和以前一样。
	unknown := legacy
	unknown.Delivery = "bogus"
	if got := normalizeFailoverSpec(unknown); got.Delivery != "" || failoverSignature(got) != legacySig {
		t.Fatalf("不认识的投递方式应当归成空且不改签名：%q", got.Delivery)
	}
	for _, delivery := range []string{"cold", "hot", "aggregate", "replicate"} {
		spec := legacy
		spec.Delivery = " " + delivery + " "
		got := normalizeFailoverSpec(spec)
		if got.Delivery != delivery {
			t.Fatalf("投递方式 %q 没被接受：%q", delivery, got.Delivery)
		}
		if failoverSignature(got) == legacySig {
			t.Fatalf("投递方式 %q 应当进签名", delivery)
		}
	}

	tiered := legacy
	tiered.Targets = append([]failoverTarget(nil), legacy.Targets...)
	tiered.Targets[0].Tier = tierPtr(0)
	tiered.Targets[1].Tier = tierPtr(1)
	tieredSig := failoverSignature(normalizeFailoverSpec(tiered))
	if tieredSig == legacySig {
		t.Fatal("Tier 是行为参数，应当进签名")
	}
	moved := tiered
	moved.Targets = append([]failoverTarget(nil), tiered.Targets...)
	moved.Targets[1].Tier = tierPtr(0)
	if failoverSignature(normalizeFailoverSpec(moved)) == tieredSig {
		t.Fatal("改了 Tier 签名应当变")
	}

	hinted := tiered
	hinted.Targets = append([]failoverTarget(nil), tiered.Targets...)
	hinted.Targets[0].ExtraLatencyMs = 180
	normalized := normalizeFailoverSpec(hinted)
	if failoverSignature(normalized) != tieredSig {
		t.Fatal("ExtraLatencyMs 是运行时提示，不该进签名")
	}
	if normalized.Targets[0].ExtraLatencyMs != 180 {
		t.Fatalf("ExtraLatencyMs 被吃掉了：%+v", normalized.Targets[0])
	}
	if stripped := stripFailoverRelayHints(normalized); stripped.Targets[0].ExtraLatencyMs != 0 || stripped.Targets[0].Tier == nil {
		t.Fatalf("落盘应当去掉 ExtraLatencyMs、保留 Tier：%+v", stripped.Targets[0])
	}
	if normalized.Targets[0].ExtraLatencyMs != 180 {
		t.Fatal("去提示不该改到原来的规格")
	}

	bad := legacy
	bad.Targets = append([]failoverTarget(nil), legacy.Targets...)
	callerTier := -3
	bad.Targets[0].Tier = &callerTier
	bad.Targets[1].Tier = tierPtr(1)
	bad.Targets[0].ExtraLatencyMs = -5
	bad.Targets[1].ExtraLatencyMs = 10 * failoverMaxExtraLatencyMs
	got := normalizeFailoverSpec(bad)
	if *got.Targets[0].Tier != 0 || callerTier != -3 {
		t.Fatalf("负的 Tier 应当归 0，且不改调用方的值：tier=%d caller=%d", *got.Targets[0].Tier, callerTier)
	}
	if got.Targets[0].ExtraLatencyMs != 0 || got.Targets[1].ExtraLatencyMs != failoverMaxExtraLatencyMs {
		t.Fatalf("ExtraLatencyMs 应当夹在 0..%d：%+v", failoverMaxExtraLatencyMs, got.Targets)
	}
}

func TestTieredCandidatesStayInLowestHealthyTier(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "weighted", Targets: tieredTargets(0, 0, 1, 1)})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.candidateIndicesLocked(nil, true); !reflect.DeepEqual(got, []int{0, 1}) {
		t.Fatalf("主组都好时只该在主组里分：%v", got)
	}
	proxy.targetHealth[0] = false
	if got := proxy.candidateIndicesLocked(nil, true); !reflect.DeepEqual(got, []int{1}) {
		t.Fatalf("主组还剩一条健康的，不该动用备用组：%v", got)
	}
	if got := proxy.candidateIndicesLocked(map[int]bool{1: true}, true); !reflect.DeepEqual(got, []int{2, 3}) {
		t.Fatalf("主组没有可用的了才轮到备用组：%v", got)
	}
	proxy.relayDown[1] = true
	if got := proxy.candidateIndicesLocked(nil, true); !reflect.DeepEqual(got, []int{2, 3}) {
		t.Fatalf("主组全挂应当在备用组里分：%v", got)
	}
	if got := proxy.candidateIndicesLocked(nil, false); !reflect.DeepEqual(got, []int{0, 1, 2, 3}) {
		t.Fatalf("healthyOnly=false 不分层：%v", got)
	}

	// 有一条没标 Tier：整组按不分层处理（老行为）。
	mixed := tieredTargets(0, 0, 1, 1)
	mixed[3].Tier = nil
	legacy := routeTestProxy(failoverSpec{Strategy: "weighted", Targets: mixed})
	legacy.mu.Lock()
	defer legacy.mu.Unlock()
	if got := legacy.candidateIndicesLocked(nil, true); !reflect.DeepEqual(got, []int{0, 1, 2, 3}) {
		t.Fatalf("不分层的规格候选应当和以前一样：%v", got)
	}
}

func TestTieredWeightedAndLeastLoadSpreadOnlyAcrossMainGroup(t *testing.T) {
	for _, strategy := range []string{"weighted", "least_load", "round_robin", "random"} {
		targets := tieredTargets(0, 0, 1)
		for i := range targets {
			targets[i].Weight = 50
		}
		proxy := routeTestProxy(failoverSpec{Strategy: strategy, Targets: targets})
		seen := map[int]int{}
		for i := 0; i < 60; i++ {
			_, index := proxy.pickTargetForKey("198.51.100.1", nil)
			seen[index]++
		}
		if seen[2] != 0 || seen[0] == 0 || seen[1] == 0 {
			t.Fatalf("%s：主组都好时应当只在 0、1 之间分：%v", strategy, seen)
		}
		proxy.mu.Lock()
		proxy.targetHealth[0] = false
		proxy.targetHealth[1] = false
		proxy.mu.Unlock()
		if _, index := proxy.pickTargetForKey("198.51.100.1", nil); index != 2 {
			t.Fatalf("%s：主组全挂应当走备用组，拿到 %d", strategy, index)
		}
	}
}

func recordProbes(proxy *failoverProxy, index int, latencyMs int) {
	at := time.Now().Add(-10 * time.Minute)
	for i := 0; i < 20; i++ {
		proxy.statsLocked(index).recordProbe(true, latencyMs, at.Add(time.Duration(i)*5*time.Second))
	}
}

// 自动择优只在还有健康出站的最优一层里挑：备用组再快也不会被提到主组前面。
func TestTieredFastestIgnoresBackupGroup(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, PreferFastest: true, Targets: tieredTargets(0, 0, 1)})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	recordProbes(proxy, 0, 300)
	recordProbes(proxy, 1, 150)
	recordProbes(proxy, 2, 20)
	start := time.Now()
	if got := fastestAfterHold(proxy, start); got != 1 {
		t.Fatalf("应当在主组里择优选 1，拿到 %d", got)
	}

	// 走着备用组而主组是好的：不择优，按数组顺序切回主组第一条健康的。
	proxy.activeIndex = 2
	proxy.resetFastestLocked()
	if got := fastestAfterHold(proxy, start); got != -1 {
		t.Fatalf("当前不在最优一层时不该择优，拿到 %d", got)
	}
	drainFailoverEvents()
	proxy.updateFallbackActiveAtLocked(start, "health check")
	if proxy.activeIndex != 0 {
		t.Fatalf("主组好了应当切回主组第一条：active=%d", proxy.activeIndex)
	}

	// 主组全挂：备用组成了最优一层，在里面照常择优（这里只有一条，所以不择优）。
	proxy.targetHealth[0] = false
	proxy.targetHealth[1] = false
	proxy.updateFallbackActiveAtLocked(start, "health check")
	if proxy.activeIndex != 2 {
		t.Fatalf("主组全挂应当逃到备用组：active=%d", proxy.activeIndex)
	}
	if got := fastestAfterHold(proxy, start); got != -1 {
		t.Fatalf("备用组只有一条，不该择优：%d", got)
	}
}

// 评分按整条链路：本机第一段一样快，下游多 200ms 的那条分低；上报的 latencyMs 仍是第一段。
func TestChainLatencyDrivesScoreButNotReportedLatency(t *testing.T) {
	targets := routeTargets(2)
	targets[0].ExtraLatencyMs = 200
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, PreferFastest: true, Targets: targets})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	recordProbes(proxy, 0, 40)
	recordProbes(proxy, 1, 60)
	first, _ := proxy.scoreLocked(0)
	second, _ := proxy.scoreLocked(1)
	if first >= second-10 {
		t.Fatalf("下游慢 200ms 的那条应当明显低分：%d vs %d", first, second)
	}
	report := proxy.statsReportLocked()
	if report.Targets[0].LatencyMs != 40 || report.Targets[0].ExtraLatencyMs != 200 || report.Targets[0].Score != first {
		t.Fatalf("快照应当报第一段延迟 + 下游延迟 + 链路评分：%+v", report.Targets[0])
	}
	if report.Targets[1].ExtraLatencyMs != 0 || report.Targets[1].LatencyMs != 60 {
		t.Fatalf("没有下游延迟的出站：%+v", report.Targets[1])
	}
	if got := fastestAfterHold(proxy, time.Now()); got != 1 {
		t.Fatalf("按整条链路应当择优选 1，拿到 %d", got)
	}

	// 不带 ExtraLatencyMs（老面板）：0 是 100 分，1 不够门槛，不切。
	proxy.spec.Targets[0].ExtraLatencyMs = 0
	proxy.resetFastestLocked()
	if score, _ := proxy.scoreLocked(0); score != 100 {
		t.Fatalf("老规格评分不该变：%d", score)
	}
	if got := fastestAfterHold(proxy, time.Now()); got != -1 {
		t.Fatalf("老规格不该择优切换：%d", got)
	}

	// 没探出延迟的出站不能靠下游延迟凑出分来。
	unprobed := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: targets})
	unprobed.mu.Lock()
	defer unprobed.mu.Unlock()
	if _, ok := unprobed.scoreLocked(0); ok {
		t.Fatal("没探过的出站不该有分")
	}
}

// 面板改了下游延迟：不重建代理、不清样本，只把新值换上。
func TestExtraLatencyHintDoesNotRebuild(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })
	const ruleID, sourcePort = 950030, 65030
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
	spec := failoverTestSpec(failoverTestPort(t))
	spec.Targets[0].Tier = tierPtr(0)
	spec.Targets[1].Tier = tierPtr(1)
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("代理没起来")
	}
	before := currentFailoverProxy(ruleID, sourcePort)
	before.mu.Lock()
	marker := before.statsLocked(0)
	before.mu.Unlock()

	hinted := spec
	hinted.Targets = append([]failoverTarget(nil), spec.Targets...)
	hinted.Targets[1].ExtraLatencyMs = 120
	if !startFailoverProxy(ruleID, sourcePort, hinted, nil) {
		t.Fatal("带下游延迟重新下发失败")
	}
	after := currentFailoverProxy(ruleID, sourcePort)
	if after != before {
		t.Fatal("下游延迟变化重建了代理")
	}
	after.mu.Lock()
	extra := after.spec.Targets[1].ExtraLatencyMs
	same := after.statsLocked(0) == marker
	after.mu.Unlock()
	if extra != 120 || !same {
		t.Fatalf("下游延迟应当原地换上、样本保留：extra=%d sameStats=%v", extra, same)
	}
}

func TestHotDeliveryAllowsFallbackRace(t *testing.T) {
	p := &failoverProxy{spec: failoverSpec{Strategy: "fallback", Delivery: "hot", Targets: []failoverTarget{{}, {}}}}
	if !p.raceAllowedLocked() {
		t.Fatal("热备的主备策略应当竞速")
	}
	for _, delivery := range []string{"", "cold", "aggregate", "replicate"} {
		p.spec.Delivery = delivery
		if p.raceAllowedLocked() {
			t.Fatalf("投递方式 %q 的主备策略不该竞速", delivery)
		}
	}
	p.spec = failoverSpec{Strategy: "ip_hash", Delivery: "hot", Targets: []failoverTarget{{}, {}}}
	if p.raceAllowedLocked() {
		t.Fatal("ip_hash 不管投递方式都不该竞速")
	}
}

// 热备：当前这条握手卡住时同时拨下一条健康的，先连上的赢。
func TestHotDeliveryFallbackRacesNextHealthyPath(t *testing.T) {
	tag, elapsed, proxy, late := runRaceDialScenario(t, 970011, "fallback", func(spec *failoverSpec) {
		spec.Delivery = "hot"
		spec.Targets[0].Tier = tierPtr(0)
		spec.Targets[1].Tier = tierPtr(1)
	})
	if tag != "F" {
		t.Fatalf("热备连接落在了 %q，应当是竞速赢的那条", tag)
	}
	if elapsed > time.Second {
		t.Fatalf("热备竞速用了 %v", elapsed)
	}
	time.Sleep(1300 * time.Millisecond)
	if late.Load() != 0 {
		t.Fatal("输掉的拨号没被取消")
	}
	proxy.mu.Lock()
	failures := proxy.statsLocked(0).consecutiveFailures
	proxy.mu.Unlock()
	if failures != 0 {
		t.Fatalf("被取消的拨号记成了 %d 次失败", failures)
	}
}

// 换规格：出站列表变了才要求立刻探一轮。
func TestRebuildReportsTargetListChange(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: routeTargets(2)})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	same := normalizeFailoverSpec(failoverSpec{Strategy: "fallback", Targets: routeTargets(2), MinHoldSeconds: 30, BindAddress: "127.0.0.1", ListenPort: 64100, Enabled: true})
	if proxy.rebuildForSpecLocked(same, time.Now()) {
		t.Fatal("只改了参数，出站没变，不该算换了出站")
	}
	more := same
	more.Targets = routeTargets(3)
	if !proxy.rebuildForSpecLocked(more, time.Now()) {
		t.Fatal("加了一条出站应当算换了出站")
	}
	moved := more
	moved.Targets = append([]failoverTarget(nil), more.Targets...)
	moved.Targets[2].ProbeIP, moved.Targets[2].ProbePort = "10.9.9.9", 443
	if !proxy.rebuildForSpecLocked(moved, time.Now()) {
		t.Fatal("改了探测地址应当算换了出站")
	}
}

func resetHeartbeatWakeForTest() {
	heartbeatForceReconcileWake.Store(false)
	select {
	case <-heartbeatWakeCh:
	default:
	}
}

func waitForProbe(t *testing.T, proxy *failoverProxy, index int, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		proxy.mu.Lock()
		probed := index < len(proxy.stats) && !proxy.statsLocked(index).lastProbeAt.IsZero()
		proxy.mu.Unlock()
		if probed {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("出站 %d 在 %v 内没被探测", index, within)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func waitForHeartbeatWake(t *testing.T, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !heartbeatForceReconcileWake.Load() {
		if time.Now().After(deadline) {
			t.Fatal("第一轮探测之后没有唤醒心跳")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// 代理刚起来、换了出站：立刻探一轮（不等 5 秒的定时器），探完唤醒心跳把统计带给面板。
func TestProbeImmediatelyOnStartAndTargetChange(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })
	resetHeartbeatWakeForTest()
	t.Cleanup(resetHeartbeatWakeForTest)
	const ruleID, sourcePort = 950031, 65031
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })

	spec := failoverTestSpec(failoverTestPort(t))
	spec.Targets = []failoverTarget{
		{TargetIP: "127.0.0.1", TargetPort: failoverTaggedBackend(t, "A")},
		{TargetIP: "127.0.0.1", TargetPort: failoverTaggedBackend(t, "B")},
	}
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("代理没起来")
	}
	proxy := currentFailoverProxy(ruleID, sourcePort)
	waitForProbe(t, proxy, 0, 3*time.Second)
	waitForProbe(t, proxy, 1, 3*time.Second)
	waitForHeartbeatWake(t, 3*time.Second)

	resetHeartbeatWakeForTest()
	changed := spec
	changed.Targets = append(append([]failoverTarget(nil), spec.Targets...), failoverTarget{TargetIP: "127.0.0.1", TargetPort: failoverTaggedBackend(t, "C")})
	if !startFailoverProxy(ruleID, sourcePort, changed, nil) {
		t.Fatal("换出站失败")
	}
	if currentFailoverProxy(ruleID, sourcePort) != proxy {
		t.Fatal("同一个监听地址换出站不该重建代理")
	}
	waitForProbe(t, proxy, 2, 3*time.Second)
	waitForHeartbeatWake(t, 3*time.Second)
}

func TestRouteInboundWindowCountsLastTenMinutes(t *testing.T) {
	var window routeInboundWindow
	base := time.Unix(1_800_000_000, 0)
	// 12 分钟前那一格滚出窗口，不该算进来。
	window.record(false, base.Add(-12*time.Minute))
	for i := 0; i < 9; i++ {
		window.record(true, base.Add(-time.Duration(i)*time.Minute))
	}
	window.record(false, base.Add(-30*time.Second))
	ok, failed := window.summary(base)
	if ok != 9 || failed != 1 {
		t.Fatalf("summary = %d ok / %d failed, want 9 / 1", ok, failed)
	}
	// 同一格被新的一分钟复用时先清零。
	window.record(true, base.Add(10*time.Minute))
	ok, failed = window.summary(base.Add(10 * time.Minute))
	if ok != 1 || failed != 0 {
		t.Fatalf("after wrap summary = %d / %d, want 1 / 0", ok, failed)
	}
}
