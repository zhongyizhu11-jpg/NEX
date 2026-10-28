package main

import (
	"strings"
	"testing"
	"time"
)

/*
抖动抑制：两条线路轮流领先时，每一次切换各自合规，合起来却是来回漂。
一小时内自动切了三次，之后的切回要多等 5 分钟（每多一次翻倍）；逃生不受限。
*/
func TestFlapHoldExtendsAfterRepeatedSwitches(t *testing.T) {
	proxy := scheduleProxy(2, nil, 0)
	failoverProxyEventsSnapshot()
	flip := func(zeroHealthy bool) int {
		proxy.mu.Lock()
		defer proxy.mu.Unlock()
		proxy.targetHealth[0] = zeroHealthy
		proxy.updateFallbackActiveLocked("health check")
		return proxy.activeIndex
	}
	// 三次切换：0 挂 → 1，0 回 → 0（切回），0 挂 → 1。最短驻留是 0，所以都切得动。
	if got := flip(false); got != 1 {
		t.Fatalf("第一次该逃到 1，拿到 %d", got)
	}
	if got := flip(true); got != 0 {
		t.Fatalf("没驻留时该切回 0，拿到 %d", got)
	}
	if got := flip(false); got != 1 {
		t.Fatalf("第三次该逃到 1，拿到 %d", got)
	}
	// 第四次：0 又好了。三次之内切得这么勤，这回得等 5 分钟。
	if got := flip(true); got != 1 {
		t.Fatalf("一小时内切了三次，切回要等抖动抑制，拿到 %d", got)
	}
	events := failoverProxyEventsSnapshot()
	var hold *failoverProxyEvent
	for i := range events {
		if events[i].Kind == "flap_hold" {
			hold = &events[i]
		}
	}
	if hold == nil {
		t.Fatal("抖动抑制生效时该报一条 flap_hold 事件")
	}
	if !strings.HasPrefix(hold.Reason, "flap: 3 switches in 1h, hold 5m") {
		t.Fatalf("原因该写清切了几次、等多久：%q", hold.Reason)
	}
	// 但当前这条挂了照样逃生。
	if got := flip(false); got != 1 {
		t.Fatalf("逃生不该被抖动抑制拦住，拿到 %d", got)
	}
	proxy.mu.Lock()
	proxy.targetHealth[1] = false
	proxy.targetHealth[0] = true
	proxy.updateFallbackActiveLocked("health check")
	escaped := proxy.activeIndex
	proxy.mu.Unlock()
	if escaped != 0 {
		t.Fatalf("1 号挂了必须立刻逃到 0，拿到 %d", escaped)
	}
	// 驻留过了就能切。
	proxy.mu.Lock()
	proxy.targetHealth[1] = true
	proxy.targetHealth[0] = false
	proxy.updateFallbackActiveLocked("health check") // 逃生到 1
	proxy.targetHealth[0] = true
	proxy.updateFallbackActiveLocked("health check") // 被抑制
	held := proxy.activeIndex
	hold5 := proxy.flapHoldLocked(time.Now())
	proxy.lastSwitchAt = time.Now().Add(-hold5 - time.Second)
	proxy.updateFallbackActiveLocked("health check")
	released := proxy.activeIndex
	proxy.mu.Unlock()
	if held != 1 || released != 0 {
		t.Fatalf("驻留里不切（%d）、过了就切回（%d）", held, released)
	}
}

func TestFlapHoldDoublesAndCaps(t *testing.T) {
	proxy := scheduleProxy(2, nil, 0)
	now := time.Now()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.flapHoldLocked(now); got != 0 {
		t.Fatalf("没切过不该有抑制：%s", got)
	}
	for i := 0; i < 3; i++ {
		proxy.noteAutoSwitchLocked(now.Add(-time.Duration(i) * time.Minute))
	}
	if got := proxy.flapHoldLocked(now); got != 5*time.Minute {
		t.Fatalf("三次该等 5 分钟：%s", got)
	}
	proxy.noteAutoSwitchLocked(now)
	if got := proxy.flapHoldLocked(now); got != 10*time.Minute {
		t.Fatalf("四次该等 10 分钟：%s", got)
	}
	for i := 0; i < 10; i++ {
		proxy.noteAutoSwitchLocked(now)
	}
	if got := proxy.flapHoldLocked(now); got != time.Hour {
		t.Fatalf("封顶一小时：%s", got)
	}
	// 一小时前的不算。
	proxy.autoSwitchTimes = nil
	for i := 0; i < 5; i++ {
		proxy.noteAutoSwitchLocked(now.Add(-2 * time.Hour))
	}
	if got := proxy.flapHoldLocked(now); got != 0 {
		t.Fatalf("两小时前的切换不该还算数：%s", got)
	}
}

// 人工指定不算自动切换：人来回点不是线路在漂。
func TestPinSwitchesDoNotCountAsFlapping(t *testing.T) {
	proxy := scheduleProxy(2, nil, 0)
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	for i := 0; i < 4; i++ {
		proxy.setActiveLocked(i%2, "pin")
	}
	if got := proxy.flapHoldLocked(time.Now()); got != 0 {
		t.Fatalf("人工指定的切换不该触发抖动抑制：%s", got)
	}
}
