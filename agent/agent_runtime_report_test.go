package main

import (
	"encoding/json"
	"runtime"
	"testing"
)

func TestAgentRuntimeSnapshotHasTheReportedFields(t *testing.T) {
	report := agentRuntimeSnapshot()
	for _, key := range []string{"heapBytes", "goroutines", "gcCount", "gcPauseMaxUs", "gcPauseTotalMs", "udpSessions", "cpuAes"} {
		if _, ok := report[key]; !ok {
			t.Fatalf("agentRuntime is missing %q: %v", key, report)
		}
	}
	if runtime.GOOS == "linux" {
		if rss, ok := report["rssBytes"].(uint64); !ok || rss == 0 {
			t.Fatalf("rssBytes = %v on linux", report["rssBytes"])
		}
	}
	if _, ok := report["pprof"]; ok {
		t.Fatal("pprof status reported while pprof is off")
	}
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		UDPSessions struct {
			Active, Cap int64
		} `json:"udpSessions"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil || decoded.UDPSessions.Cap <= 0 {
		t.Fatalf("udpSessions did not serialize: %s", raw)
	}
}

// GC 停顿取的是两次心跳之间那几轮里最长的一次；没有新的一轮报 0。
func TestAgentRuntimeGCPauseMaxCoversOnlyNewRounds(t *testing.T) {
	agentRuntimeGCMu.Lock()
	saved := agentRuntimeLastNumGC
	agentRuntimeLastNumGC = 0
	agentRuntimeGCMu.Unlock()
	t.Cleanup(func() {
		agentRuntimeGCMu.Lock()
		agentRuntimeLastNumGC = saved
		agentRuntimeGCMu.Unlock()
	})
	var ms runtime.MemStats
	ms.NumGC = 3
	ms.PauseNs[(1+255)%256] = 100
	ms.PauseNs[(2+255)%256] = 900
	ms.PauseNs[(3+255)%256] = 400
	if got := agentRuntimeGCPauseMaxSinceLast(&ms); got != 900 {
		t.Fatalf("max over rounds 1-3 = %d, want 900", got)
	}
	if got := agentRuntimeGCPauseMaxSinceLast(&ms); got != 0 {
		t.Fatalf("no new rounds: got %d, want 0", got)
	}
	ms.NumGC = 4
	ms.PauseNs[(4+255)%256] = 50
	if got := agentRuntimeGCPauseMaxSinceLast(&ms); got != 50 {
		t.Fatalf("only round 4: got %d, want 50", got)
	}
}
