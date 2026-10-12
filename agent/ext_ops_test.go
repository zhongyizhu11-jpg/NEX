package main

import (
	"encoding/json"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func waitOpsReport(t *testing.T, m *opsExtModule, done func(opsReport) bool) opsReport {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if raw := m.Report(Config{}); raw != nil {
			report := raw.(opsReport)
			if done(report) {
				return report
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for ops report")
	return opsReport{}
}

// 同一个 requestId 只重启一次：指令每轮重发、Agent 重启后再收到，都不会再来一遍。
func TestOpsRestartAllIsIdempotentPerRequest(t *testing.T) {
	oldPath, oldActive, oldRestart, oldFXP := opsRestartAllStatePath, opsServiceActive, opsServiceRestart, opsRestartFXPAll
	opsRestartAllStatePath = filepath.Join(t.TempDir(), "ops-restart-all.json")
	t.Cleanup(func() {
		opsRestartAllStatePath, opsServiceActive, opsServiceRestart, opsRestartFXPAll = oldPath, oldActive, oldRestart, oldFXP
	})
	var restarts atomic.Int32
	opsServiceActive = func(name string) bool { return name == "forwardx-runtime" }
	opsServiceRestart = func(name string) bool { restarts.Add(1); return true }
	opsRestartFXPAll = func() ([]string, []opsRestartFailure) {
		return []string{"fxp:exit-1"}, []opsRestartFailure{{Name: "fxp:entry-2", Error: "x"}}
	}

	m := newOpsExtModule()
	directive, _ := json.Marshal(map[string]any{"restartAll": map[string]string{"requestId": "req-1"}})
	m.Apply(Config{}, directive)
	m.Apply(Config{}, directive)
	report := waitOpsReport(t, m, func(r opsReport) bool { return len(r.RestartAll) == 1 && r.RestartAll[0].Status == "done" })
	result := report.RestartAll[0]
	if restarts.Load() != 1 {
		t.Fatalf("service restarted %d times, want 1", restarts.Load())
	}
	if len(result.Restarted) != 2 || result.Restarted[0] != "forwardx-runtime" || len(result.Failed) != 1 {
		t.Fatalf("unexpected result %+v", result)
	}
	m.Apply(Config{}, directive)
	time.Sleep(50 * time.Millisecond)
	if restarts.Load() != 1 {
		t.Fatal("re-sent directive must not restart again")
	}

	// 「Agent 重启」：新模块从磁盘读到做过的 requestId。
	fresh := newOpsExtModule()
	fresh.Apply(Config{}, directive)
	report = waitOpsReport(t, fresh, func(r opsReport) bool { return len(r.RestartAll) == 1 })
	if !report.RestartAll[0].Repeated || restarts.Load() != 1 {
		t.Fatalf("restart after agent restart: %+v restarts=%d", report.RestartAll[0], restarts.Load())
	}
	// 新的 requestId 照常执行。
	next, _ := json.Marshal(map[string]any{"restartAll": map[string]string{"requestId": "req-2"}})
	fresh.Apply(Config{}, next)
	waitOpsReport(t, fresh, func(r opsReport) bool {
		for _, item := range r.RestartAll {
			if item.RequestID == "req-2" && item.Status == "done" {
				return true
			}
		}
		return false
	})
	if restarts.Load() != 2 {
		t.Fatalf("new request should restart once more, got %d", restarts.Load())
	}
}

func TestOpsRestartCandidatesOnlyPanelRuntimes(t *testing.T) {
	for name, want := range map[string]bool{
		"forwardx-realm-10001":    true,
		"forwardx-socat-tcp-2000": true,
		"forwardx-runtime":        true,
		"forwardx-tunnel-runtime": true,
		"forwardx-nginx":          true,
		"forwardx-singbox":        true,
		"forwardx-agent":          false,
		"forwardx-agent-upgrade":  false,
		"sshd":                    false,
		"forwardx-wireguard":      false,
		"forwardx-realm;rm":       false,
	} {
		if got := opsServiceRestartable(name); got != want {
			t.Fatalf("opsServiceRestartable(%q) = %v, want %v", name, got, want)
		}
	}
}

// 扫描和停掉原配置：停之前重新扫，key 对不上就不动。
func TestOpsStopOnlyTouchesSelectedKey(t *testing.T) {
	oldScan, oldShell := opsScanFn, opsRunShell
	t.Cleanup(func() { opsScanFn, opsRunShell = oldScan, oldShell })
	specs := parseIptablesSaveNAT(string(opsFixture(t, "iptables-save.txt")), "iptables")
	items := opsFinalizeScanItems(opsItemsFromSpecs("iptables", "iptables-save", "", specs), nil)
	opsScanFn = func() []opsScanItem { return items }
	var ran []string
	opsRunShell = func(cmd string) bool { ran = append(ran, cmd); return true }

	m := newOpsExtModule()
	scan, _ := json.Marshal(map[string]any{"scan": map[string]string{"scanId": "s1"}})
	m.Apply(Config{}, scan)
	report := waitOpsReport(t, m, func(r opsReport) bool { return len(r.Scans) == 1 && r.Scans[0].Status == "done" })
	if len(report.Scans[0].Items) != len(items) {
		t.Fatalf("scan returned %d items, want %d", len(report.Scans[0].Items), len(items))
	}
	var target opsScanItem
	for _, item := range items {
		if item.ListenPort == 50001 {
			target = item
		}
	}
	stop, _ := json.Marshal(map[string]any{"stops": []map[string]string{{"actionId": "a1", "key": target.Key}, {"actionId": "a2", "key": "deadbeefdeadbeef"}}})
	m.Apply(Config{}, stop)
	report = waitOpsReport(t, m, func(r opsReport) bool {
		done := 0
		for _, s := range r.Stops {
			if s.Status == "done" {
				done++
			}
		}
		return done == 2
	})
	for _, s := range report.Stops {
		if s.ActionID == "a1" && !s.OK {
			t.Fatalf("selected item should stop: %+v", s)
		}
		if s.ActionID == "a2" && s.OK {
			t.Fatal("unknown key must not stop anything")
		}
	}
	if len(ran) != 2 {
		t.Fatalf("expected the two DNAT deletes for port 50001 (tcp+udp), ran %q", ran)
	}
	for _, cmd := range ran {
		if !containsFold(cmd, "'--dport' '50001'") {
			t.Fatalf("touched an unselected rule: %q", cmd)
		}
	}
}
