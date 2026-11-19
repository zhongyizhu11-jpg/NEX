package main

import (
	"testing"
	"time"
)

// F5：「没验证过 UDP」（从没回过 UDP 探活包）的出口只在有别的验证过的出口时才算软信号。以前全都没验证过时
// 也个个都是软信号，软信号最多摘一半 —— 一半出口白白分不到 UDP 新会话（这一版刚上线、对端都还没升级时就是这样）。
func TestUnverifiedUDPExitsAreSoftOnlyNextToAVerifiedOne(t *testing.T) {
	resetFXPEndpointRegistry()
	exits := []exitEndpoint{
		{Host: "127.0.0.1", Port: 39101},
		{Host: "127.0.0.1", Port: 39102},
		{Host: "127.0.0.1", Port: 39103},
		{Host: "127.0.0.1", Port: 39104},
	}
	selector := newExitEndpointSelector(exits, exits[0], "round_robin")
	for _, state := range selector.states {
		state.mu.Lock()
		state.udpWatchers, state.udpUnverified = 1, true
		state.mu.Unlock()
	}
	used := map[int]bool{}
	for i := 0; i < 40; i++ {
		_, index, ok := selector.pickUDP(nil, "")
		if !ok {
			t.Fatal("挑不出出口")
		}
		used[index] = true
		selector.unpick(index)
	}
	if len(used) != len(exits) {
		t.Fatalf("四台出口都没验证过 UDP：都该分到 UDP 新会话，实际只用了 %d 台（%v）", len(used), used)
	}
	// 有一台验证过（回过探活包、UDP 通）：没验证过的才算软信号，验证过的优先。
	state := selector.states[2]
	state.mu.Lock()
	state.udpUnverified, state.udpPongSeen = false, true
	state.mu.Unlock()
	selector.mu.Lock()
	health := selector.healthLocked(time.Now(), true, false)
	selector.mu.Unlock()
	for i, h := range health {
		if want := i != 2; h.Soft != want {
			t.Fatalf("有一台验证过时，第 %d 台 Soft 应该是 %v，得到 %v", i, want, h.Soft)
		}
	}
}
