package main

import (
	"testing"
	"time"
)

/*
切换演练（面板下发的提示原因是 drill）引起的切走和切回不算进抖动抑制：演练是人故意做的。
同样的翻转换成真的中转异常，照旧一次次数进去。
*/
func TestDrillSwitchesDoNotCountTowardFlapHold(t *testing.T) {
	proxy := scheduleProxy(2, nil, 0)
	failoverProxyEventsSnapshot()
	hint := func(reason string) int {
		proxy.mu.Lock()
		defer proxy.mu.Unlock()
		targets := append([]failoverTarget(nil), proxy.spec.Targets...)
		targets[0].Down = reason != ""
		targets[0].DownReason = reason
		proxy.applyRelayHintsLocked(targets)
		return proxy.activeIndex
	}
	// 连着演练三回：每回都切走、撤掉后切回
	for round := 1; round <= 3; round++ {
		if got := hint("drill"); got != 1 {
			t.Fatalf("第 %d 回演练：主线路当成挂了，该切到 1，拿到 %d", round, got)
		}
		if got := hint(""); got != 0 {
			t.Fatalf("第 %d 回演练：撤掉后该切回 0，拿到 %d（演练不该触发抖动抑制）", round, got)
		}
	}
	proxy.mu.Lock()
	count := proxy.recentAutoSwitchesLocked(time.Now())
	hold := proxy.flapHoldLocked(time.Now())
	proxy.mu.Unlock()
	if count != 0 || hold != 0 {
		t.Fatalf("六次切换都是演练引起的，不该算进抖动抑制：count=%d hold=%s", count, hold)
	}

	// 对照：真的中转异常（原因不是 drill）照旧算
	if got := hint("JP01 → 落地"); got != 1 {
		t.Fatalf("中转异常该切到 1，拿到 %d", got)
	}
	if got := hint(""); got != 0 {
		t.Fatalf("中转恢复该切回 0，拿到 %d", got)
	}
	proxy.mu.Lock()
	count = proxy.recentAutoSwitchesLocked(time.Now())
	proxy.mu.Unlock()
	if count != 2 {
		t.Fatalf("真故障的切走和切回各算一次，拿到 %d", count)
	}
}

// 演练撤掉以后隔了很久才切回（比如被最短驻留压着、中间又出了别的事）：那已经不是「演练的切回」了。
func TestDrillFailbackExemptionExpires(t *testing.T) {
	proxy := scheduleProxy(2, nil, 0)
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.drillEndedAt[0] = time.Now().Add(-time.Duration(proxy.spec.RecoverSeconds)*time.Second - failoverDrillFailbackSlack - time.Minute)
	if proxy.drillSwitchLocked(1, 0, time.Now()) {
		t.Fatal("演练撤掉太久之后的切回不该再免计")
	}
	proxy.drillEndedAt[0] = time.Now()
	if !proxy.drillSwitchLocked(1, 0, time.Now()) {
		t.Fatal("演练刚撤掉的切回该免计")
	}
	if proxy.drillSwitchLocked(1, 0, time.Now()) {
		t.Fatal("一次演练只免一次切回")
	}
}
