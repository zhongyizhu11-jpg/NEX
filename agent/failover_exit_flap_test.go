package main

import (
	"testing"
	"time"
)

/*
出口组「出口到目标来回断」的防抖（failover_exit_flap.go）。用户面板（2026-11-26）：指定的 jinx(39.9y) 对高防目标
09:24 断、09:53 恢复、09:55 又断 —— 每次恢复这条规则的流量全回到它身上，两三分钟后再断，客户端时不时超时。
*/
func TestExitGroupFlappingExitWaitsBeforeTakingPinAgain(t *testing.T) {
	spec := exitGroupSpec("round_robin", 3)
	pinned := 1
	spec.PinnedIndex = &pinned
	proxy := routeTestProxy(spec)
	drainFailoverEvents()
	now := time.Now()

	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	// 第一次断、恢复：不观察，马上吃指定（一次中断是正常的故障切换）
	proxy.markUnhealthyLocked(1, "health check", "")
	proxy.readmitForLocked(1, now, "health check")
	if proxy.exitProbationLocked(1, now) {
		t.Fatal("一小时里只断过一次，恢复后不该观察")
	}
	if got := proxy.exitPinPickLocked([]int{0, 1, 2}, false); got != 1 {
		t.Fatalf("恢复后应当马上吃指定，挑到了 %d", got)
	}

	// 第二次断（面板提示）、恢复（提示撤掉）：来回断，先观察 2 分钟
	hinted := func(down bool) []failoverTarget {
		targets := make([]failoverTarget, len(proxy.spec.Targets))
		copy(targets, proxy.spec.Targets)
		targets[1].Down, targets[1].DownReason = down, map[bool]string{true: "出口连不上目标", false: ""}[down]
		return targets
	}
	proxy.applyRelayHintsLocked(hinted(true))
	proxy.applyRelayHintsLocked(hinted(false))
	if left := proxy.exitProbationLeftLocked(1, time.Now()); left <= 0 || left > exitFlapPolicy.Base {
		t.Fatalf("断了两次，恢复后应当观察约 %s，剩 %s", exitFlapPolicy.Base, left)
	}
	if got := proxy.exitPinPickLocked([]int{0, 1, 2}, false); got != -1 {
		t.Fatalf("观察期里不该吃指定，挑到了 %d", got)
	}
	candidates := proxy.pickCandidatesLocked(nil, false)
	for _, index := range candidates {
		if index == 1 {
			t.Fatalf("还有别的能用的出口时，观察中的不该进候选：%v", candidates)
		}
	}
	if len(candidates) != 2 {
		t.Fatalf("另外两台都该在候选里：%v", candidates)
	}
	// 上报：观察中的是备用，别的在用
	_, _, exits, ok := proxy.balanceSnapshotLocked()
	if !ok || exits[1].State != "standby" || exits[0].State != "active" || exits[2].State != "active" {
		t.Fatalf("上报里观察中的应当是备用、别的在用：%+v", exits)
	}

	// 别的都不能用了：观察中的照样用，不至于没路可走
	proxy.targetHealth[0], proxy.targetHealth[2] = false, false
	if candidates := proxy.pickCandidatesLocked(nil, false); len(candidates) != 1 || candidates[0] != 1 {
		t.Fatalf("别的都不能用时只剩观察中的那台：%v", candidates)
	}
	proxy.targetHealth[0], proxy.targetHealth[2] = true, true

	// 观察期过了：照常吃指定
	proxy.exitRecoveredAt[1] = time.Now().Add(-exitFlapPolicy.Base - time.Second)
	if got := proxy.exitPinPickLocked([]int{0, 1, 2}, false); got != 1 {
		t.Fatalf("观察期过了应当吃指定，挑到了 %d", got)
	}

	// 第三次：观察期翻倍
	proxy.markUnhealthyLocked(1, "health check", "")
	proxy.readmitForLocked(1, time.Now(), "health check")
	if left := proxy.exitProbationLeftLocked(1, time.Now()); left <= exitFlapPolicy.Base {
		t.Fatalf("断了三次，观察期应当比 %s 长，剩 %s", exitFlapPolicy.Base, left)
	}
}

// 管理上排除（暂停 / 维护 / 流量停机）和演练不算中断；不是出口组的代理不记。
func TestExitGroupFlapIgnoresAdminDownAndNonExitGroups(t *testing.T) {
	spec := exitGroupSpec("round_robin", 2)
	proxy := routeTestProxy(spec)
	drainFailoverEvents()
	proxy.mu.Lock()
	for _, reason := range []string{"maintenance", "drill", "paused"} {
		targets := make([]failoverTarget, len(proxy.spec.Targets))
		copy(targets, proxy.spec.Targets)
		targets[1].Down, targets[1].DownReason = true, reason
		proxy.applyRelayHintsLocked(targets)
		targets[1].Down, targets[1].DownReason = false, ""
		proxy.applyRelayHintsLocked(targets)
	}
	outages := len(proxy.exitOutages[1])
	probation := proxy.exitProbationLocked(1, time.Now())
	proxy.mu.Unlock()
	if outages != 0 || probation {
		t.Fatalf("管理上排除和演练不该算中断：outages=%d probation=%v", outages, probation)
	}

	// 线路组（不带 BalanceReport）：不记
	plain := exitGroupSpec("round_robin", 2)
	plain.BalanceReport = nil
	route := routeTestProxy(plain)
	route.mu.Lock()
	defer route.mu.Unlock()
	for i := 0; i < 3; i++ {
		route.markUnhealthyLocked(1, "health check", "")
		route.readmitForLocked(1, time.Now(), "health check")
	}
	if len(route.exitOutages[1]) != 0 || route.exitProbationLocked(1, time.Now()) {
		t.Fatal("不是出口组的代理不该记中断")
	}
}
