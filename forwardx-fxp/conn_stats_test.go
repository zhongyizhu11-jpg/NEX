package main

import (
	"errors"
	"testing"
	"time"
)

func resetConnStatsForTest() {
	connStats.Lock()
	connStats.entries = map[connStatsKey]*connStatsValue{}
	connStats.Unlock()
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func TestRecordConnStageAggregatesAndBuckets(t *testing.T) {
	resetConnStatsForTest()
	cfg := config{PanelURL: "https://panel.example/", Token: "tok"}
	recordConnStage(cfg, 7, 9, "entry", "tcp", "203.0.113.1:443", 30*time.Millisecond, nil)
	recordConnStage(cfg, 7, 9, "entry", "tcp", "203.0.113.1:443", 1500*time.Millisecond, nil)
	recordConnStage(cfg, 7, 9, "entry", "tcp", "203.0.113.1:443", 5*time.Second, timeoutErr{})
	recordConnStage(config{}, 7, 9, "entry", "tcp", "x", 0, nil) // 没有面板地址：不记
	recordConnStage(cfg, 0, 9, "entry", "tcp", "x", 0, nil)      // 没有隧道：不记

	taken := takeConnStats()
	if len(taken) != 1 {
		t.Fatalf("entries = %d, want 1", len(taken))
	}
	for key, value := range taken {
		if key.panelURL != "https://panel.example" || key.stage != "tcp" {
			t.Fatalf("unexpected key %+v", key)
		}
		if value.Attempts != 3 || value.Failures != 1 || value.SumMs != 1530 || value.MaxMs != 1500 {
			t.Fatalf("unexpected value %+v", value)
		}
		if value.Buckets[0] != 1 || value.Buckets[5] != 1 {
			t.Fatalf("unexpected buckets %+v", value.Buckets)
		}
		if value.LastError != "timeout" {
			t.Fatalf("last error = %q", value.LastError)
		}
	}
	if len(takeConnStats()) != 0 {
		t.Fatal("take must clear the counters")
	}
}

func TestRestoreConnStatsMergesFailedReport(t *testing.T) {
	resetConnStatsForTest()
	cfg := config{PanelURL: "https://p", Token: "tok"}
	recordConnStage(cfg, 1, 0, "exit", "target", "10.0.0.1:80", 10*time.Millisecond, nil)
	taken := takeConnStats()
	recordConnStage(cfg, 1, 0, "exit", "target", "10.0.0.1:80", 20*time.Millisecond, errors.New("dial tcp: connection refused"))
	restoreConnStats(taken)
	merged := takeConnStats()
	for _, value := range merged {
		if value.Attempts != 2 || value.Failures != 1 || value.SumMs != 10 || value.LastError != "connection refused" {
			t.Fatalf("merge result %+v", value)
		}
	}
}

func TestConnStatsRowsGroupByPanel(t *testing.T) {
	resetConnStatsForTest()
	recordConnStage(config{PanelURL: "https://a", Token: "t1"}, 1, 0, "entry", "pool", "h:1", 0, nil)
	recordConnStage(config{PanelURL: "https://b", Token: "t2"}, 2, 0, "entry", "tcp", "h:2", 0, nil)
	groups := connStatsRows(takeConnStats())
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(groups))
	}
}

func TestConnStatsEndpointLabel(t *testing.T) {
	if got := connStatsEndpoint("2001:db8::1", 443); got != "[2001:db8::1]:443" {
		t.Fatalf("ipv6 label = %q", got)
	}
	if got := connStatsEndpoint("", 443); got != "-" {
		t.Fatalf("empty label = %q", got)
	}
}
