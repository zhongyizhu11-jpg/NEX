package main

import (
	"encoding/json"
	"testing"
	"time"
)

/*
第 3 批三样东西放在同一份规格里一起验（它们是三条分支分别做的，各自的测试只测各自的）：

  - UDP 健康检查：ProbeUdpEcho（行为参数，进签名）、TCP+UDP 两侧分开判；
  - 动态权重：Strategy "auto"、LoadPct（运行时提示，不进签名、不落盘）；
  - 同出口 IP：ExitIP（运行时提示，不进签名、不落盘），挂了换路时平手优先同出口。
*/

func batch3Targets() []failoverTarget {
	targets := exitIPTargets(3, " 203.0.113.9 ", "203.0.113.10", "203.0.113.9")
	for i := range targets {
		targets[i].ProbeUdpEcho = true
	}
	targets[0].LoadPct = 90
	return targets
}

// 三样字段同时带：签名只认 ProbeUdpEcho；落盘只去掉两个运行时提示；热更新提示时两个一起换上。
func TestBatch3CombinedSpecFields(t *testing.T) {
	base := failoverSpec{Protocol: "both", Strategy: "auto", Targets: routeTargets(3), ListenPort: 65031, BindAddress: "127.0.0.1", Enabled: true}
	full := base
	full.Targets = batch3Targets()
	normalized := normalizeFailoverSpec(full)
	if normalized.Strategy != "auto" {
		t.Fatalf("auto 被规整成了 %q", normalized.Strategy)
	}
	if !normalized.Targets[0].ProbeUdpEcho || normalized.Targets[0].LoadPct != 90 || normalized.Targets[0].ExitIP != "203.0.113.9" {
		t.Fatalf("三样字段规整后应当都在：%+v", normalized.Targets[0])
	}

	// 只差运行时提示（LoadPct / ExitIP）：签名不变 —— 面板每轮改负载、改出口地址都不能重建代理。
	hintsOnly := full
	hintsOnly.Targets = batch3Targets()
	for i := range hintsOnly.Targets {
		hintsOnly.Targets[i].LoadPct = 0
		hintsOnly.Targets[i].ExitIP = ""
	}
	if failoverSignature(normalizeFailoverSpec(hintsOnly)) != failoverSignature(normalized) {
		t.Fatal("LoadPct / ExitIP 是运行时提示，不该进签名")
	}
	// ProbeUdpEcho 是行为参数：带不带签名要不一样（换了探测方式要重建）。
	noEcho := full
	noEcho.Targets = batch3Targets()
	for i := range noEcho.Targets {
		noEcho.Targets[i].ProbeUdpEcho = false
	}
	if failoverSignature(normalizeFailoverSpec(noEcho)) == failoverSignature(normalized) {
		t.Fatal("ProbeUdpEcho 是行为参数，应当进签名")
	}

	stripped := stripFailoverRelayHints(normalized)
	for i, target := range stripped.Targets {
		if target.LoadPct != 0 || target.ExitIP != "" {
			t.Fatalf("落盘应当去掉第 %d 条的运行时提示：%+v", i, target)
		}
		if !target.ProbeUdpEcho {
			t.Fatalf("落盘不该去掉第 %d 条的 ProbeUdpEcho（行为参数）", i)
		}
	}
	if normalized.Targets[0].LoadPct != 90 || normalized.Targets[0].ExitIP == "" {
		t.Fatal("stripFailoverRelayHints 不该改原规格")
	}

	// 同一份规格带着新的提示再下发：不重建，两个提示一起换上。
	proxy := routeTestProxy(base)
	proxy.mu.Lock()
	proxy.applyRelayHintsLocked(normalized.Targets)
	load, exit := proxy.spec.Targets[0].LoadPct, proxy.exitIPLocked(2)
	proxy.mu.Unlock()
	if load != 90 || exit != "203.0.113.9" {
		t.Fatalf("applyRelayHintsLocked 应当同时换上 LoadPct 和 ExitIP：load=%d exit=%q", load, exit)
	}
}

// 主备 + TCP/UDP 分开判 + 同出口 IP：TCP 挂了换到同出口的那条；UDP 会话按 UDP 那一侧另挑。
func TestBatch3FallbackSameExitWithUDPSplit(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Protocol: "both", Strategy: "fallback", Targets: batch3Targets()})
	proxy.mu.Lock()
	// 0 的 TCP 挂了；1、2 的 TCP 都通，2 和 0 同出口 → TCP 换到 2。
	proxy.targetHealth[0] = false
	// UDP 那一侧：只有 1 通（0、2 的 UDP 端口关着）。
	proxy.udpSide.health[0] = false
	proxy.udpSide.health[1] = true
	proxy.udpSide.health[2] = false
	drainFailoverEvents()
	proxy.updateFallbackActiveAtLocked(time.Now(), "health check")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active != 2 {
		t.Fatalf("TCP 应当换到和挂掉那条同出口 IP 的第 2 条：active=%d", active)
	}
	if switched := routeEventsOfKind(drainFailoverEvents(), "switch"); len(switched) != 1 || switched[0].ToIndex != 2 {
		t.Fatalf("应当记一次换到第 2 条的切换：%+v", switched)
	}
	if _, index := proxy.pickTargetForKeyProto("", nil, false); index != 2 {
		t.Fatalf("TCP 连接应当走在走的第 2 条，挑到了 %d", index)
	}
	// 在走的第 2 条 UDP 不通：UDP 会话避开它，走 UDP 唯一通的第 1 条。
	for i := 0; i < 5; i++ {
		if _, index := proxy.pickTargetForKeyProto("", nil, true); index != 1 {
			t.Fatalf("UDP 会话应当走 UDP 通的第 1 条，第 %d 次挑到了 %d", i+1, index)
		}
	}
}

// 「自动」+ TCP/UDP 分开判 + 负载：TCP 在两条都健康时避开忙的那条；UDP 会话只在 UDP 通的里挑，忙也得走。
func TestBatch3AutoWithLoadAndUDPSplit(t *testing.T) {
	targets := batch3Targets()[:2]
	proxy := routeTestProxy(failoverSpec{Protocol: "both", Strategy: "auto", Targets: targets})
	proxy.mu.Lock()
	// 两条 TCP 都通；UDP 只有第 0 条（负载 90%）通。
	proxy.udpSide.health[0] = true
	proxy.udpSide.health[1] = false
	proxy.mu.Unlock()
	for i := 0; i < 20; i++ {
		// 没有连接时：两条都会被挑出来比，0 的 (0+1)÷0.1 远大于 1 的 (0+1)÷1 → 总是 1。
		if _, index := proxy.pickTargetForKeyProto("", nil, false); index != 1 {
			t.Fatalf("TCP 应当避开负载 90%% 的第 0 条，第 %d 次挑到了 %d", i+1, index)
		}
		// UDP 只有第 0 条通：忙也只能走它。
		if _, index := proxy.pickTargetForKeyProto("", nil, true); index != 0 {
			t.Fatalf("UDP 会话应当走 UDP 唯一通的第 0 条，第 %d 次挑到了 %d", i+1, index)
		}
	}
	// 第 1 条 TCP 也挂了：TCP 只剩第 0 条，忙也走它。
	proxy.mu.Lock()
	proxy.targetHealth[1] = false
	proxy.mu.Unlock()
	if _, index := proxy.pickTargetForKeyProto("", nil, false); index != 0 {
		t.Fatalf("只剩第 0 条健康时 TCP 应当走它，挑到了 %d", index)
	}
}

/*
运行时提示（中转异常、下游延迟、沿途负载、出口 IP）不进动作签名和托管服务签名：面板每轮换一次负载，
Agent 不能因此重新执行动作、重启 realm / socat（正在走的连接会全断）。提示由 runningRules 同步原地换上。
*/
func TestActionSignaturesIgnoreRelayHints(t *testing.T) {
	const serviceName = "forwardx-realm-30001"
	const unit = "[Service]\nExecStart=/usr/local/bin/realm -l 0.0.0.0:30001 -r 127.0.0.1:65040\n"
	build := func(mutate func(targets []failoverTarget)) action {
		targets := batch3Targets()
		for i := range targets {
			targets[i].LoadPct = 0
			targets[i].ExitIP = ""
		}
		if mutate != nil {
			mutate(targets)
		}
		spec := failoverSpec{Enabled: true, ListenPort: 65040, BindAddress: "127.0.0.1", Protocol: "both", Strategy: "auto", Targets: targets}
		return action{Op: "apply", StatusType: "rule", RuleID: 7, SourcePort: 30001, ForwardType: "realm", ServiceName: serviceName, Unit: unit, Failover: &spec}
	}
	plain := build(nil)
	hinted := build(func(targets []failoverTarget) {
		targets[0].LoadPct = 90
		targets[1].LoadPct = 35
		targets[0].ExitIP = "203.0.113.9"
		targets[1].ExtraLatencyMs = 12
		targets[2].Down = true
		targets[2].DownReason = "relay down: hk → jp"
	})
	if actionCommandSignature(plain) != actionCommandSignature(hinted) {
		t.Fatal("运行时提示变了动作签名不该变（否则 Agent 会重新执行这条动作）")
	}
	if managedServiceActionSignature(plain, serviceName, unit) != managedServiceActionSignature(hinted, serviceName, unit) {
		t.Fatal("运行时提示变了托管服务签名不该变（否则 realm / socat 会被重启）")
	}
	if hinted.Failover.Targets[0].LoadPct != 90 || hinted.Failover.Targets[2].DownReason == "" {
		t.Fatal("算签名不该改动作里带的规格（提示还要交给调度代理）")
	}

	// 行为参数变了照样要变：换了探测方式、权重都得重新执行。
	for name, mutate := range map[string]func([]failoverTarget){
		"probeUdpEcho": func(targets []failoverTarget) { targets[1].ProbeUdpEcho = false },
		"weight":       func(targets []failoverTarget) { targets[1].Weight = 7 },
		"targetPort":   func(targets []failoverTarget) { targets[1].TargetPort++ },
	} {
		changed := build(mutate)
		if actionCommandSignature(changed) == actionCommandSignature(plain) {
			t.Fatalf("%s 是行为参数，动作签名应当变", name)
		}
		if managedServiceActionSignature(changed, serviceName, unit) == managedServiceActionSignature(plain, serviceName, unit) {
			t.Fatalf("%s 是行为参数，托管服务签名应当变", name)
		}
	}

	// 没带提示的规格：和直接序列化逐字节相同（升级后签名不变、不重做）；Targets 为 nil 时也一样。
	for _, spec := range []*failoverSpec{plain.Failover, {Enabled: true, ListenPort: 1, Targets: nil}, {Enabled: true, Targets: []failoverTarget{}}} {
		want, err := json.Marshal(spec)
		if err != nil {
			t.Fatal(err)
		}
		got, ok := failoverSpecSignatureJSON(spec)
		if !ok || got != string(want) {
			t.Fatalf("没带提示的规格应当和直接序列化一样：\n got %s\nwant %s", got, want)
		}
	}
	if _, ok := failoverSpecSignatureJSON(nil); ok {
		t.Fatal("没有线路组规格时不写进签名")
	}
}

// TCP+UDP 分开判 + 同出口 IP：TCP 在走的那条 UDP 不通时，UDP 会话也优先换到和它同出口的那条（同一个访客的
// TCP 和 UDP 在对端看到的是同一个来源）；同出口的那条 UDP 也不通就照旧第一条 UDP 通的；人工指定压过同出口。
func TestBatch3UDPFallbackPrefersSameExitAsTCPActive(t *testing.T) {
	targets := exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9")
	proxy := routeTestProxy(failoverSpec{Protocol: "both", Strategy: "fallback", Targets: targets})
	proxy.mu.Lock()
	// TCP 走着 0（通）；0 的 UDP 不通，1、2 的 UDP 通，2 和 0 同出口。
	proxy.udpSide.health[0] = false
	proxy.mu.Unlock()
	for i := 0; i < 5; i++ {
		if _, index := proxy.pickTargetForKeyProto("", nil, true); index != 2 {
			t.Fatalf("UDP 会话应当换到和 TCP 在走的第 0 条同出口的第 2 条，第 %d 次挑到了 %d", i+1, index)
		}
	}
	if _, index := proxy.pickTargetForKeyProto("", nil, false); index != 0 {
		t.Fatalf("TCP 不受影响，还走第 0 条：挑到了 %d", index)
	}
	// 同出口的第 2 条 UDP 也不通：照旧第一条 UDP 通的第 1 条。
	proxy.mu.Lock()
	proxy.udpSide.health[2] = false
	proxy.mu.Unlock()
	if _, index := proxy.pickTargetForKeyProto("", nil, true); index != 1 {
		t.Fatalf("只剩第 1 条 UDP 通：挑到了 %d", index)
	}

	// 人工指定第 1 条：UDP 通就走它，同出口不插手。
	pinned := 1
	pinnedProxy := routeTestProxy(failoverSpec{Protocol: "both", Strategy: "fallback", Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9"), PinnedIndex: &pinned})
	pinnedProxy.mu.Lock()
	pinnedProxy.activeIndex = 0
	pinnedProxy.udpSide.health[0] = false
	pinnedProxy.mu.Unlock()
	if _, index := pinnedProxy.pickTargetForKeyProto("", nil, true); index != 1 {
		t.Fatalf("人工指定的第 1 条 UDP 通就该走它：挑到了 %d", index)
	}
}

// 「一起分」的线路 + TCP/UDP 分开判 + 同出口 IP：落地 A 的 UDP 不通（TCP 还通），UDP 会话在剩下的落地里负载平手时
// 优先和 A 同出口的 C —— 「哪个落地用不了」按 UDP 那一侧判。
func TestBatch3LineSpreadSameExitUsesUDPSide(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Protocol: "both", Strategy: "fallback", Targets: exitIPLineTargets("least_load")})
	proxy.mu.Lock()
	proxy.udpSide.health[0] = false
	proxy.mu.Unlock()
	for i := 0; i < 6; i++ {
		if _, index := proxy.pickTargetForKeyProto("198.51.100.1", nil, true); index != 2 {
			t.Fatalf("A 的 UDP 不通，UDP 会话负载平手时应当优先同出口的 C：第 %d 次挑到了 %d", i+1, index)
		}
	}
	// TCP 那一侧 A 好好的：TCP 连接照旧在三个落地之间分（A 也在里面）。
	seen := map[int]bool{}
	for i := 0; i < 9; i++ {
		_, index := proxy.pickTargetForKeyProto("198.51.100.1", nil, false)
		seen[index] = true
	}
	if !seen[0] {
		t.Fatalf("TCP 那一侧 A 是通的，应当还分得到：%v", seen)
	}
}
