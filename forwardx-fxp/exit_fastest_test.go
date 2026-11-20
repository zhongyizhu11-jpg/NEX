package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

/*
延迟优先「只走最快的一台」（exit_fastest.go）。整链 = 入口到出口握手 1ms + 出口到目标的中位数。
*/

func fastestSelector(t *testing.T, chains ...float64) *exitEndpointSelector {
	t.Helper()
	resetFXPEndpointRegistry()
	endpoints := make([]exitEndpoint, len(chains))
	for i := range chains {
		endpoints[i] = exitEndpoint{Host: "127.0.0.1", Port: 21101 + i, TargetStatus: true}
	}
	selector := newExitEndpointSelector(endpoints[1:], endpoints[0], "latency", &balanceDetectConfig{LatencyMarginMs: 50, FastestOnly: true})
	if !selector.fastestOnly {
		t.Fatal("带了 fastestOnly 的延迟优先应当开着只走最快的一台")
	}
	now := time.Now()
	for i, chain := range chains {
		selector.loads[i].observeLatency(time.Millisecond, now)
		setTargetChain(selector, i, chain)
	}
	return selector
}

// setTargetChain 把第 index 台到目标的延迟整个换成 chain − 1（握手那 1ms 另算）。
func setTargetChain(selector *exitEndpointSelector, index int, chain float64) {
	selector.mu.Lock()
	defer selector.mu.Unlock()
	health := selector.target.health[index]
	*health = targetHealth{}
	for i := 0; i < 5; i++ {
		health.observe(true, chain-1, time.Now(), selector.target.detect)
	}
}

func fastestCounts(selector *exitEndpointSelector, n int, udp bool) []int {
	counts := make([]int, len(selector.endpoints))
	for i := 0; i < n; i++ {
		var index int
		if udp {
			_, index, _ = selector.pickUDP(nil, "203.0.113.9")
		} else {
			_, index, _ = selector.pick(nil, "203.0.113.9")
		}
		if index >= 0 {
			counts[index]++
		}
	}
	return counts
}

func TestFastestOnlyPicksOnlyTheFastestExit(t *testing.T) {
	selector := fastestSelector(t, 3, 4, 60, 90)
	if counts := fastestCounts(selector, 60, false); counts[0] != 60 {
		t.Fatalf("整链 3/4/60/90ms：只该走最快的第 1 台，实际 %v", counts)
	}
	if counts := fastestCounts(selector, 20, true); counts[0] != 20 {
		t.Fatalf("UDP 新会话也走同一台，实际 %v", counts)
	}
	// 不开时 3ms、4ms 一样快，两台一起分
	plain := fastestSelector(t, 3, 4, 60, 90)
	plain.fastestOnly = false
	if counts := fastestCounts(plain, 60, false); counts[0] == 0 || counts[1] == 0 || counts[2] != 0 || counts[3] != 0 {
		t.Fatalf("没开只走最快的一台：一样快的两台都该分到，实际 %v", counts)
	}
}

func TestFastestOnlySlightlyFasterExitDoesNotTakeOver(t *testing.T) {
	selector := fastestSelector(t, 3, 4, 60)
	start := time.Now()
	fastestCounts(selector, 1, false)
	setTargetChain(selector, 1, 2)
	selector.mu.Lock()
	defer selector.mu.Unlock()
	for minute := 0; minute <= 10; minute++ {
		if index := selector.fastestChoiceLocked(start.Add(time.Duration(minute) * time.Minute)); index != 0 {
			t.Fatalf("快 1ms 不该换过去（第 %d 分钟换到了 %d）", minute, index)
		}
	}
}

func TestFastestOnlyMuchFasterExitTakesOverAfterTheHold(t *testing.T) {
	selector := fastestSelector(t, 100, 120, 200)
	start := time.Now()
	fastestCounts(selector, 1, false)
	setTargetChain(selector, 2, 40)
	selector.mu.Lock()
	for _, after := range []time.Duration{time.Second, 30 * time.Second, 59 * time.Second} {
		if index := selector.fastestChoiceLocked(start.Add(after)); index != 0 {
			selector.mu.Unlock()
			t.Fatalf("%s：还没稳住 60 秒就换到了 %d", after, index)
		}
	}
	if index := selector.fastestChoiceLocked(start.Add(61 * time.Second)); index != 2 {
		selector.mu.Unlock()
		t.Fatalf("快出 60ms、稳住 60 秒后该换到第 3 台，得到 %d", index)
	}
	selector.mu.Unlock()
	if counts := fastestCounts(selector, 10, false); counts[2] != 10 {
		t.Fatalf("换过去以后新连接该走第 3 台：%v", counts)
	}
}

func TestFastestOnlyCurrentDownTakesTheNextFastestAtOnce(t *testing.T) {
	selector := fastestSelector(t, 3, 4, 60)
	fastestCounts(selector, 1, false)
	// 第 1 台到目标不通（连着两次）
	selector.observeTarget(0, false, 0)
	selector.observeTarget(0, false, 0)
	if counts := fastestCounts(selector, 10, false); counts[1] != 10 {
		t.Fatalf("在用的坏了，该当场换到次快的第 2 台：%v", counts)
	}
	// 这条连接拨第 2 台失败、带着排除重挑：给第 3 台，在用的还是第 2 台
	if _, index, _ := selector.pick(map[int]bool{1: true}); index != 2 {
		t.Fatalf("换路重拨该给剩下的第 3 台，得到 %d", index)
	}
	selector.mu.Lock()
	current, _ := selector.fastest.Current()
	selector.mu.Unlock()
	if current != 1 {
		t.Fatalf("换路重拨不该挪在用的，得到 %d", current)
	}
}

func TestFastestOnlyReportsTheSingleActiveExit(t *testing.T) {
	selector := fastestSelector(t, 60, 3, 4)
	selector.mu.Lock()
	exits := selector.balanceSnapshotLocked(time.Now())
	selector.mu.Unlock()
	states := []string{exits[0].State, exits[1].State, exits[2].State}
	if strings.Join(states, ",") != "standby,active,standby" {
		t.Fatalf("只有最快的那台在用，别的候补：%v", states)
	}
}

func TestBalanceDetectConfigReadsFastestOnly(t *testing.T) {
	var detect balanceDetectConfig
	if err := json.Unmarshal([]byte(`{"latencyMarginMs":50,"fastestOnly":true}`), &detect); err != nil || !detect.FastestOnly {
		t.Fatalf("fastestOnly 读不出来：%v %+v", err, detect)
	}
	// 只对延迟优先起作用
	resetFXPEndpointRegistry()
	auto := newExitEndpointSelector([]exitEndpoint{{Host: "127.0.0.1", Port: 21202}}, exitEndpoint{Host: "127.0.0.1", Port: 21201}, "auto", &detect)
	if auto.fastestOnly {
		t.Fatal("自动不该开只走最快的一台")
	}
}
