package lbcore

import (
	"testing"
	"time"
)

func TestQualityCostIsLatencyTimesPenaltyOverHeadroom(t *testing.T) {
	if cost := QualityCost(Quality{}); cost != 0 {
		t.Fatalf("不知道延迟应当是 0，得到 %v", cost)
	}
	if cost := QualityCost(Quality{Latency: 30, Jitter: 10}); cost != 40 {
		t.Fatalf("延迟 + 抖动：want 40, got %v", cost)
	}
	// 2% 丢包 × 1.2，利用率 50% ÷ 0.5
	if cost := QualityCost(Quality{Latency: 100, Loss: 0.02, Utilisation: 0.5}); cost < 239.99 || cost > 240.01 {
		t.Fatalf("want 240, got %v", cost)
	}
}

func TestSwitchPolicyUsesTheLatencyPriorityMargin(t *testing.T) {
	policy := SwitchPolicy{}
	cases := []struct {
		active, candidate float64
		better, much      bool
	}{
		{300, 30, true, true},    // 好得多
		{60, 35, false, false},   // 差 25ms：延迟优先里算一样快
		{120, 60, true, false},   // 差 60ms、快一半：明显更好，但不到「好得多」（差不到 100ms）
		{900, 840, false, false}, // 差 60ms，可只快了 7%
		{0, 30, false, false},    // 正在走的没量过
		{300, 0, false, false},   // 候选没量过
		{1000, 400, true, true},  // 差 600ms、不到一半
		{100, 49.9, true, false}, // 差 50.1ms、快一半多一点，但差不到两个门槛
	}
	for _, c := range cases {
		better, much := policy.Better(c.active, c.candidate)
		if better != c.better || much != c.much {
			t.Errorf("%v → %v: want better=%v much=%v, got %v %v", c.active, c.candidate, c.better, c.much, better, much)
		}
	}
	// 门槛和延迟优先同一个参数
	if better, _ := (SwitchPolicy{Margin: 20}).Better(60, 35); !better {
		t.Fatal("门槛 20ms 时 60 → 35 应当换")
	}
}

func TestSwitchPolicyHold(t *testing.T) {
	policy := SwitchPolicy{Hold: 3 * time.Minute}
	if hold := policy.HoldFor(false); hold != 3*time.Minute {
		t.Fatalf("got %v", hold)
	}
	if hold := policy.HoldFor(true); hold != DefaultSwitchFastHold {
		t.Fatalf("好得多应当只等 %v，got %v", DefaultSwitchFastHold, hold)
	}
	if hold := (SwitchPolicy{Hold: 5 * time.Second}).HoldFor(true); hold != 5*time.Second {
		t.Fatalf("Hold 比 FastHold 短时按 Hold，got %v", hold)
	}
}

func TestChallengerStartsTimingOnFirstSight(t *testing.T) {
	var challenger Challenger
	start := time.Unix(1000, 0)
	// 第 0 条是合法下标：零值不能被当成「第 0 条已经领先了很久」。
	if challenger.Ready(0, start, time.Minute) {
		t.Fatal("第一次见到只开始计时")
	}
	if challenger.Ready(0, start.Add(59*time.Second), time.Minute) {
		t.Fatal("还不到 1 分钟")
	}
	if !challenger.Ready(0, start.Add(time.Minute), time.Minute) {
		t.Fatal("连着领先 1 分钟应当成立")
	}
	if challenger.Ready(1, start.Add(2*time.Minute), time.Minute) {
		t.Fatal("换了人重新计时")
	}
	challenger.Reset()
	if challenger.Ready(1, start.Add(3*time.Minute), 0) {
		t.Fatal("Reset 之后又是第一次见到")
	}
}

func TestDisplayScoreFollowsTheCost(t *testing.T) {
	if _, ok := DisplayScore(Quality{}); ok {
		t.Fatal("不知道延迟不打分")
	}
	cases := []struct {
		quality Quality
		want    int
	}{
		{Quality{Latency: 30}, 100},
		{Quality{Latency: 40}, 100},
		{Quality{Latency: 220}, 50},
		{Quality{Latency: 400}, 0},
		{Quality{Latency: 650}, 0},
		{Quality{Latency: 100, Loss: 0.02}, 78}, // 成本 120 → 77.8
	}
	for _, c := range cases {
		if score, ok := DisplayScore(c.quality); !ok || score != c.want {
			t.Errorf("%+v: want %d, got %d (%v)", c.quality, c.want, score, ok)
		}
	}
	// 分数高低和成本高低一致
	a, _ := DisplayScore(Quality{Latency: 80, Jitter: 20})
	b, _ := DisplayScore(Quality{Latency: 90})
	if !(a < b) {
		t.Fatalf("成本 100 的分应当比成本 90 的低：%d vs %d", a, b)
	}
}
