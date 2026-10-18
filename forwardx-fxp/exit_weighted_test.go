package main

import "testing"

// 出口组「按权重」：500M 和 300M 两个出口按 5:3 分新连接；交错排，不连着压在一个上。
func TestExitSelectorWeightedSplitsByWeight(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2, Weight: 3}},
		exitEndpoint{Host: "127.0.0.1", Port: 1, Weight: 5},
		"weighted",
	)
	counts := map[int]int{}
	maxRun, run, last := 0, 0, -1
	for i := 0; i < 80; i++ {
		_, index, ok := selector.pick(nil)
		if !ok {
			t.Fatal("挑不出端点")
		}
		counts[index]++
		if index == last {
			run++
		} else {
			run, last = 1, index
		}
		if run > maxRun {
			maxRun = run
		}
	}
	if counts[0] != 50 || counts[1] != 30 {
		t.Fatalf("应该按 5:3 分：%v", counts)
	}
	if maxRun > 2 {
		t.Fatalf("连着 %d 次压在同一个出口上，应该交错", maxRun)
	}
}

// 坏了的出口不参与按权重分，剩下的照常分。
func TestExitSelectorWeightedSkipsFailedEndpoint(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2, Weight: 3}},
		exitEndpoint{Host: "127.0.0.1", Port: 1, Weight: 5},
		"weighted",
	)
	selector.markFailure(0, errTestEndpointDown)
	for i := 0; i < 10; i++ {
		if _, index, ok := selector.pick(nil); !ok || index != 1 {
			t.Fatalf("坏出口还在被派连接：index=%d ok=%v", index, ok)
		}
	}
}

// 没写权重（旧面板）按 1 算，等于轮流。
func TestExitSelectorWeightedDefaultsToEqual(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2}},
		exitEndpoint{Host: "127.0.0.1", Port: 1},
		"weighted",
	)
	counts := map[int]int{}
	for i := 0; i < 10; i++ {
		_, index, _ := selector.pick(nil)
		counts[index]++
	}
	if counts[0] != 5 || counts[1] != 5 {
		t.Fatalf("没有权重时应该平均：%v", counts)
	}
	if normalizeExitStrategy("weighted") != "weighted" {
		t.Fatal("weighted 被规整成了别的策略")
	}
}
