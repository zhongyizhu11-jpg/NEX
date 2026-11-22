package main

import (
	"testing"
)

func resetFXPRuntimeMetricsForTest() {
	fxpRuntimeMetrics.Lock()
	fxpRuntimeMetrics.counters = map[fxpRuntimeMetricKey]int64{}
	fxpRuntimeMetrics.gauges = map[fxpRuntimeMetricKey]int64{}
	fxpRuntimeMetrics.readers = map[fxpRuntimeMetricKey][]*fxpRuntimeGaugeReader{}
	fxpRuntimeMetrics.process = map[string]int64{}
	fxpRuntimeMetrics.groups = map[fxpRuntimeMetricsGroup]struct{}{}
	fxpRuntimeMetrics.Unlock()
}

func findMetricRow(rows []fxpRuntimeMetricRow, tunnelID int, role, name string) (fxpRuntimeMetricRow, bool) {
	for _, row := range rows {
		if row.TunnelID == tunnelID && row.Role == role && row.Name == name {
			return row, true
		}
	}
	return fxpRuntimeMetricRow{}, false
}

// 计数按（面板, 隧道, 规则, 角色, 名字）攒，取一次清零；没有面板配置的什么都不记。
func TestRuntimeMetricsCountersAndSnapshot(t *testing.T) {
	resetFXPRuntimeMetricsForTest()
	cfg := config{PanelURL: "https://panel.example/", Token: "tok", TunnelID: 7, RuleID: 3, Role: "entry"}
	fxpMetricAdd(cfg, "udp_queue_drop", 2)
	fxpMetricAdd(cfg, "udp_queue_drop", 3)
	fxpMetricAdd(cfg, "pool_miss", 1)
	fxpMetricAdd(config{TunnelID: 7}, "pool_miss", 1) // 没有面板地址：不记
	fxpMetricAddProcess("peer_gone")
	rows, counters, process := fxpRuntimeMetricsSnapshot()
	group := fxpRuntimeMetricsGroup{panelURL: "https://panel.example", token: "tok"}
	list := rows[group]
	if row, ok := findMetricRow(list, 7, "entry", "udp_queue_drop"); !ok || row.Value != 5 || row.Kind != "counter" || row.RuleID != 3 {
		t.Fatalf("udp_queue_drop row = %+v %v", row, ok)
	}
	if row, ok := findMetricRow(list, 0, "process", "peer_gone"); !ok || row.Value != 1 {
		t.Fatalf("process row = %+v %v", row, ok)
	}
	if len(counters) != 2 || len(process) != 1 {
		t.Fatalf("snapshot returned %d counters, %d process entries", len(counters), len(process))
	}
	if again, _, _ := fxpRuntimeMetricsSnapshot(); len(again[group]) != 0 {
		t.Fatalf("second snapshot still had %d rows, counters were not cleared", len(again[group]))
	}
	// 报失败放回去，下一次一起报。
	fxpRuntimeMetricsRestore(counters, process)
	rows, _, _ = fxpRuntimeMetricsSnapshot()
	if row, ok := findMetricRow(rows[group], 7, "entry", "udp_queue_drop"); !ok || row.Value != 5 {
		t.Fatalf("restored row = %+v %v", row, ok)
	}
}

// gauge：加减维护的（tcp_sessions）不会被取数清掉、不会减成负数；登记读函数的（udp_sessions）注销后不再报。
func TestRuntimeMetricsGauges(t *testing.T) {
	resetFXPRuntimeMetricsForTest()
	cfg := config{PanelURL: "https://panel.example", Token: "tok", TunnelID: 9, Role: "exit"}
	fxpMetricGaugeDelta(cfg, "tcp_sessions", 1)
	fxpMetricGaugeDelta(cfg, "tcp_sessions", 1)
	fxpMetricGaugeDelta(cfg, "tcp_sessions", -5)
	live := int64(4)
	release := fxpMetricGauge(cfg, "udp_sessions", func() int64 { return live })
	group := fxpRuntimeMetricsGroup{panelURL: "https://panel.example", token: "tok"}
	rows, _, _ := fxpRuntimeMetricsSnapshot()
	if row, ok := findMetricRow(rows[group], 9, "exit", "tcp_sessions"); !ok || row.Value != 0 || row.Kind != "gauge" {
		t.Fatalf("tcp_sessions = %+v %v (must clamp at 0)", row, ok)
	}
	if row, ok := findMetricRow(rows[group], 9, "exit", "udp_sessions"); !ok || row.Value != 4 {
		t.Fatalf("udp_sessions = %+v %v", row, ok)
	}
	fxpMetricGaugeDelta(cfg, "tcp_sessions", 2)
	live = 6
	rows, _, _ = fxpRuntimeMetricsSnapshot()
	if row, _ := findMetricRow(rows[group], 9, "exit", "tcp_sessions"); row.Value != 2 {
		t.Fatalf("tcp_sessions after delta = %+v", row)
	}
	if row, _ := findMetricRow(rows[group], 9, "exit", "udp_sessions"); row.Value != 6 {
		t.Fatalf("udp_sessions re-read = %+v", row)
	}
	release()
	release() // 重复注销无害
	rows, _, _ = fxpRuntimeMetricsSnapshot()
	if _, ok := findMetricRow(rows[group], 9, "exit", "udp_sessions"); ok {
		t.Fatal("released gauge must not be reported")
	}
}
