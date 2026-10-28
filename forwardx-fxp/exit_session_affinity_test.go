package main

import (
	"fmt"
	"testing"
)

// 叠加：同一个会话的两条腿经两台中继到出口组。每台中继各挑各的出口（本机的轮询计数、本机看到的负载），
// 两条腿会被分到不同出口上 —— 出口各自只收到一半分片，拼不回来。按会话 id 挑就不会。
func TestSessionAffinityKeepsLegsOfOneSessionOnOneExit(t *testing.T) {
	exits := []exitEndpoint{{Host: "10.0.0.2", Port: 2, CapacityMbps: 500}}
	fallback := exitEndpoint{Host: "10.0.0.1", Port: 1, CapacityMbps: 500}
	for _, strategy := range []string{"round_robin", "least_load", "weighted", "ip_hash", "random"} {
		resetFXPEndpointRegistry()
		relayA := newExitEndpointSelector(exits, fallback, strategy)
		relayB := newExitEndpointSelector(exits, fallback, strategy)
		// 两台中继各有各的视角：B 上第一台出口压着一堆连接、轮询计数也不同步。
		relayA.loads = []*fxpHostLoad{{host: "10.0.0.1"}, {host: "10.0.0.2"}}
		relayB.loads = []*fxpHostLoad{{host: "10.0.0.1"}, {host: "10.0.0.2"}}
		relayB.loads[0].active.Store(50)
		relayB.next = 1

		counts := map[int]int{}
		for i := 0; i < 400; i++ {
			sessionID := fmt.Sprintf("session-%d", i)
			_, a, okA := relayA.pickSessionAffinity(nil, sessionID)
			_, b, okB := relayB.pickSessionAffinity(nil, sessionID)
			if !okA || !okB {
				t.Fatalf("%s：挑不出出口", strategy)
			}
			if a != b {
				t.Fatalf("%s：会话 %s 的两条腿落在不同出口 %d / %d", strategy, sessionID, a, b)
			}
			counts[a]++
		}
		// 不同会话照样分散到两台出口（同容量大约一半一半）。
		if counts[0] < 150 || counts[1] < 150 {
			t.Fatalf("%s：会话没有分散到两台出口：%v", strategy, counts)
		}
	}
}

// 一台出口挂了，各台中继都排除它之后挑的是同一台（按同一个哈希顺序往下走），腿还是不会分开。
func TestSessionAffinityFallsBackConsistently(t *testing.T) {
	resetFXPEndpointRegistry()
	exits := []exitEndpoint{{Host: "10.0.0.2", Port: 2}, {Host: "10.0.0.3", Port: 3}}
	fallback := exitEndpoint{Host: "10.0.0.1", Port: 1}
	relayA := newExitEndpointSelector(exits, fallback, "round_robin")
	relayB := newExitEndpointSelector(exits, fallback, "round_robin")
	for i := 0; i < 100; i++ {
		sessionID := fmt.Sprintf("s-%d", i)
		_, first, _ := relayA.pickSessionAffinity(nil, sessionID)
		excluded := map[int]bool{first: true}
		_, a, _ := relayA.pickSessionAffinity(excluded, sessionID)
		_, b, _ := relayB.pickSessionAffinity(excluded, sessionID)
		if a == first || a != b {
			t.Fatalf("会话 %s：排除 %d 后两台中继挑了 %d / %d", sessionID, first, a, b)
		}
	}
}

// 主备：本来各台中继就挑同一台（第一个健康的），按会话挑不改变它。
func TestSessionAffinityKeepsFallbackOrder(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector([]exitEndpoint{{Host: "10.0.0.2", Port: 2}}, exitEndpoint{Host: "10.0.0.1", Port: 1}, "fallback")
	for i := 0; i < 20; i++ {
		_, index, ok := selector.pickSessionAffinity(nil, fmt.Sprintf("s-%d", i))
		if !ok || index != 0 {
			t.Fatalf("主备应该一直走第一台，得到 %d", index)
		}
	}
}
