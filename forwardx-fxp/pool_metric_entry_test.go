package main

import (
	"testing"
	"time"
)

// 普通入口这条路（selectedTransport.connectLocked）也要记 pool_hit / pool_miss：以前只有多路那条腿记，
// 面板上看不出连接池到底用上没有。
func TestEntryConnectRecordsPoolHitAndMiss(t *testing.T) {
	resetFXPEndpointRegistry()
	resetFXPRuntimeMetricsForTest()
	targetPort := startEchoTCPTarget(t)
	key := "pool-metric-key"
	ports := startRoadmapExits(t, 1, 241, 242, key, targetPort)
	exits := []exitEndpoint{{Host: "127.0.0.1", Port: ports[0], Key: key}}
	selector := newExitEndpointSelector(exits, exits[0], "fallback")
	cfg := config{PanelURL: "https://panel.example", Token: "tok", Role: "entry", TunnelID: 241, RuleID: 242, Key: key, TargetIP: "127.0.0.1", TargetPort: targetPort}
	group := fxpRuntimeMetricsGroup{panelURL: "https://panel.example", token: "tok"}
	count := func(name string) int64 {
		fxpRuntimeMetrics.Lock()
		defer fxpRuntimeMetrics.Unlock()
		var total int64
		for metricKey, value := range fxpRuntimeMetrics.counters {
			if metricKey.panelURL == group.panelURL && metricKey.tunnelID == 241 && metricKey.name == name {
				total += value
			}
		}
		return total
	}

	first := newSelectedTransport(selector, cfg, "198.51.100.7")
	if err := first.connect(); err != nil {
		t.Fatal(err)
	}
	first.closeTransport()
	if count("pool_miss") != 1 || count("pool_hit") != 0 {
		t.Fatalf("池子是空的：第一次应记 1 次 miss，记了 miss=%d hit=%d", count("pool_miss"), count("pool_hit"))
	}

	// 取过一次之后池子会补；等补上一条再连，应该是命中
	state := selector.states[0]
	deadline := time.Now().Add(5 * time.Second)
	for {
		state.mu.Lock()
		idle := len(state.idle)
		state.mu.Unlock()
		if idle > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("5 秒内池子没补上连接")
		}
		time.Sleep(20 * time.Millisecond)
	}
	second := newSelectedTransport(selector, cfg, "198.51.100.7")
	if err := second.connect(); err != nil {
		t.Fatal(err)
	}
	second.closeTransport()
	if count("pool_hit") != 1 || count("pool_miss") != 1 {
		t.Fatalf("池里有现成的：第二次应记 1 次 hit，现在 miss=%d hit=%d", count("pool_miss"), count("pool_hit"))
	}
}
