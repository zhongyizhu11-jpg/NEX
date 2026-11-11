package main

import (
	"encoding/json"
	"testing"
	"time"
)

// 心跳快照里带着此刻生效的规格：面板拿它和用户配的那份比（期望 vs 实际对账）。
func TestStatsReportCarriesEffectiveSpec(t *testing.T) {
	pinned := 1
	schedule := &failoverSchedule{Timezone: "Asia/Shanghai", Windows: []failoverScheduleWindow{
		{Days: []int{1, 2, 3, 4, 5}, From: "18:00", To: "01:00", TargetIndex: 1},
		// 起止相同的窗口规整时会被扔掉：报的是机器真用的那份
		{Days: nil, From: "08:00", To: "08:00", TargetIndex: 0},
	}}
	proxy := routeTestProxy(failoverSpec{
		Strategy: "fallback", AutoFailback: true, Targets: routeTargets(3),
		PinnedIndex: &pinned, PinnedUntil: time.Now().Add(time.Hour).UnixMilli(),
		Schedule: schedule, MinHoldSeconds: 60, PreferFastest: true, FailureThreshold: 2,
		FailoverSeconds: 3, RecoverSeconds: 300, ScoreMargin: 10, ScoreHoldSeconds: 30, PrewarmSeconds: 300,
		SwitchMode: "smooth", Delivery: "hot",
	})
	proxy.mu.Lock()
	report := proxy.statsReportLocked()
	proxy.mu.Unlock()
	spec := report.Spec
	if spec == nil {
		t.Fatal("快照里没有规格")
	}
	if spec.PinnedIndex == nil || *spec.PinnedIndex != 1 || spec.PinnedUntil == 0 {
		t.Fatalf("钉子没报对：%+v", spec)
	}
	if spec.Schedule == nil || len(spec.Schedule.Windows) != 1 || spec.Schedule.Windows[0].TargetIndex != 1 {
		t.Fatalf("时段表没报成规整后的那份：%+v", spec.Schedule)
	}
	if spec.MinHoldSeconds != 60 || !spec.PreferFastest || spec.Strategy != "fallback" || spec.Delivery != "hot" {
		t.Fatalf("调度设置没报对：%+v", spec)
	}
	if spec.FailureThreshold != 2 || spec.FailoverSeconds != 3 || spec.RecoverSeconds != 300 || !spec.AutoFailback {
		t.Fatalf("切换保护没报对：%+v", spec)
	}
	if spec.ScoreMargin != 10 || spec.ScoreHoldSeconds != 30 || spec.PrewarmSeconds != 300 || spec.SwitchMode != "smooth" || spec.TargetCount != 3 {
		t.Fatalf("其余字段没报对：%+v", spec)
	}
	// JSON 里没钉住要写成 null，不是省略：面板那边 undefined 和 null 的意思不一样（老 Agent 没有这份 / 机器说没钉）。
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	specJSON, _ := decoded["spec"].(map[string]any)
	if _, ok := specJSON["pinnedIndex"]; !ok {
		t.Fatalf("spec 里缺 pinnedIndex 字段：%s", raw)
	}
}

// 过期的钉子报成「没钉」：和面板的读法一致，不然面板以为机器还钉着。
func TestStatsReportExpiredPinIsNull(t *testing.T) {
	pinned := 1
	proxy := routeTestProxy(failoverSpec{
		Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2),
		PinnedIndex: &pinned, PinnedUntil: time.Now().Add(-time.Minute).UnixMilli(),
	})
	proxy.mu.Lock()
	report := proxy.statsReportLocked()
	proxy.mu.Unlock()
	if report.Spec == nil || report.Spec.PinnedIndex != nil || report.Spec.PinnedUntil != 0 {
		t.Fatalf("过期的钉子应当报成没钉：%+v", report.Spec)
	}
	raw, _ := json.Marshal(report.Spec)
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	if value, ok := decoded["pinnedIndex"]; !ok || value != nil {
		t.Fatalf("没钉要写成 null：%s", raw)
	}
	// 没有时段表、冷备：省略，老面板读不到也没事
	if _, ok := decoded["schedule"]; ok {
		t.Fatalf("没有时段表不该带 schedule：%s", raw)
	}
}
