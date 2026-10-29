package main

import (
	"strings"
	"testing"
	"time"
)

// 真实连接拨通了：连续失败清零，不会因为之前两次拨不通就离阈值只差一步。
func TestDialSuccessClearsConsecutiveFailures(t *testing.T) {
	drainFailoverEvents()
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2), FailureThreshold: 3})
	proxy.markTargetFailure(0, "dial failed")
	proxy.markTargetFailure(0, "dial failed")
	proxy.markDialSuccess(0, 12*time.Millisecond)
	proxy.markTargetFailure(0, "dial failed")
	proxy.mu.RLock()
	healthy, failures := proxy.targetHealth[0], proxy.statsLocked(0).consecutiveFailures
	proxy.mu.RUnlock()
	if !healthy || failures != 1 {
		t.Fatalf("拨通一次应当清零连续失败：healthy=%v failures=%d", healthy, failures)
	}
	proxy.mu.Lock()
	report := proxy.statsReportLocked()
	proxy.mu.Unlock()
	target := report.Targets[0]
	if target.DialOK != 1 || target.DialFailed != 3 || target.DialSlow != 0 || target.DialMs != 12 || target.LastDialAt == 0 {
		t.Fatalf("快照里的拨号计数不对：%+v", target)
	}
	if events := drainFailoverEvents(); len(events) != 0 {
		t.Fatalf("没到阈值不该报事件：%+v", events)
	}
}

// 连续三次拨得慢（比探测延迟慢 3 倍且不低于 500ms）算一次失败；中间一次正常拨号就重新数。
func TestSlowDialStreakAsksForProbeWithoutFailing(t *testing.T) {
	stats := &routeTargetStats{}
	now := time.Now()
	for i := 0; i < 2; i++ {
		if stats.recordDial(true, 700, now, 40) {
			t.Fatalf("第 %d 次慢拨就触发了", i+1)
		}
	}
	if stats.recordDial(true, 50, now, 40) {
		t.Fatal("正常拨号不该触发")
	}
	if stats.consecutiveSlow != 0 {
		t.Fatalf("正常拨号应当重置慢拨计数：%d", stats.consecutiveSlow)
	}
	for i := 0; i < 2; i++ {
		stats.recordDial(true, 700, now, 40)
	}
	if !stats.recordDial(true, 700, now, 40) {
		t.Fatal("连续第三次慢拨应当触发")
	}
	if stats.consecutiveFailures != 0 || stats.consecutiveSlow != 0 {
		t.Fatalf("触发后只要求探测、不记失败，并清慢拨计数：failures=%d slow=%d", stats.consecutiveFailures, stats.consecutiveSlow)
	}
	summary := stats.dialSummary(now)
	if summary.ok != 6 || summary.slow != 5 || summary.failed != 0 {
		t.Fatalf("拨号汇总不对：%+v", summary)
	}
	// 一直慢也不会把线路判坏：测速时几十条连接一起拨，慢是常态。
	for i := 0; i < 30; i++ {
		stats.recordDial(true, 900, now, 40)
	}
	if stats.consecutiveFailures != 0 {
		t.Fatalf("只是慢不该攒失败：%d", stats.consecutiveFailures)
	}
	// 探测延迟很高时门槛跟着抬：探测 300ms，拨 700ms 不算慢（门槛 900ms）。
	if routeDialIsSlow(700, 300) {
		t.Fatal("探测本来就慢时，拨 700ms 不该算慢")
	}
	if !routeDialIsSlow(900, 300) || !routeDialIsSlow(500, 0) || routeDialIsSlow(499, 0) {
		t.Fatal("慢拨门槛算错了")
	}
}

// 拨号记录只留最近 10 分钟，老的滚出去。
func TestDialSamplesExpire(t *testing.T) {
	stats := &routeTargetStats{}
	now := time.Now()
	stats.recordDial(false, 0, now.Add(-11*time.Minute), 0)
	stats.recordDial(true, 20, now.Add(-9*time.Minute), 0)
	summary := stats.dialSummary(now)
	if summary.failed != 0 || summary.ok != 1 {
		t.Fatalf("11 分钟前的记录应当过期：%+v", summary)
	}
}

// 凑够连续慢拨：报一条 slow_dial 事件，原因里写拨号耗时和探测延迟。
func TestSlowDialStreakReportsEvent(t *testing.T) {
	drainFailoverEvents()
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2), FailureThreshold: 3})
	// 没探过就没有探测延迟，门槛是 500ms 下限。
	for i := 0; i < routeSlowDialStreak; i++ {
		proxy.markDialSuccess(0, 800*time.Millisecond)
	}
	events := routeEventsOfKind(drainFailoverEvents(), "slow_dial")
	if len(events) != 1 {
		t.Fatalf("应当正好一条 slow_dial 事件：%+v", events)
	}
	if events[0].ToIndex != 0 || !strings.HasPrefix(events[0].Reason, "slow dial: 800ms x3") {
		t.Fatalf("事件没带序号和原因：%+v", events[0])
	}
	proxy.mu.RLock()
	healthy := proxy.targetHealth[0]
	proxy.mu.RUnlock()
	if !healthy {
		t.Fatal("慢拨本身不该把线路标成异常，要等探测说话")
	}
}
