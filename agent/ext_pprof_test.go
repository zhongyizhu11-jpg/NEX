package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func newTestPprofServer() *agentPprofServer {
	return &agentPprofServer{
		// 测试里不抢 6060：直接随机端口。
		listen: func(string) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") },
		now:    time.Now,
	}
}

func pprofGet(t *testing.T, addr string, path string) (int, string) {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + addr + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestAgentPprofOffByDefaultAndOnlyOnLoopback(t *testing.T) {
	server := newTestPprofServer()
	if status := server.status(); status.Running {
		t.Fatal("pprof must be off until the panel turns it on")
	}
	server.apply(agentPprofDirective{Enabled: true, Until: time.Now().Add(time.Minute).Unix()})
	defer server.stop()
	status := server.status()
	if !status.Running {
		t.Fatalf("pprof did not start: %+v", status)
	}
	host, _, err := net.SplitHostPort(status.Addr)
	if err != nil || host != "127.0.0.1" {
		t.Fatalf("pprof listens on %q, want 127.0.0.1 only", status.Addr)
	}
	if code, body := pprofGet(t, status.Addr, "/debug/pprof/"); code != http.StatusOK || !strings.Contains(body, "goroutine") {
		t.Fatalf("index: %d %q", code, body)
	}
	if code, body := pprofGet(t, status.Addr, "/debug/pprof/goroutine?debug=1"); code != http.StatusOK || !strings.Contains(body, "goroutine profile") {
		t.Fatalf("goroutine profile: %d", code)
	}
	if code, _ := pprofGet(t, status.Addr, "/debug/pprof/heap"); code != http.StatusOK {
		t.Fatalf("heap profile: %d", code)
	}
	if code, _ := pprofGet(t, status.Addr, "/debug/pprof/nope"); code != http.StatusNotFound {
		t.Fatalf("unknown profile: %d, want 404", code)
	}
	server.apply(agentPprofDirective{Enabled: false})
	if server.status().Running {
		t.Fatal("pprof still running after the panel turned it off")
	}
	if _, err := net.DialTimeout("tcp", status.Addr, 300*time.Millisecond); err == nil {
		t.Fatal("pprof port still accepts connections after stop")
	}
}

// 截止时间由 Agent 自己计时：面板不再发指令也会按时关。
func TestAgentPprofTurnsItselfOffAtTheDeadline(t *testing.T) {
	server := newTestPprofServer()
	server.apply(agentPprofDirective{Enabled: true, Until: time.Now().Add(1 * time.Second).Unix()})
	defer server.stop()
	if !server.status().Running {
		t.Fatal("pprof did not start")
	}
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if !server.status().Running {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("pprof still running after its deadline")
}

// 指令里的截止时间过长时封顶 agentPprofMaxDuration；过期的指令不开。
func TestAgentPprofCapsDurationAndIgnoresExpiredDirective(t *testing.T) {
	server := newTestPprofServer()
	server.apply(agentPprofDirective{Enabled: true, Until: time.Now().Add(-time.Second).Unix()})
	if server.status().Running {
		t.Fatal("an expired directive started pprof")
	}
	server.apply(agentPprofDirective{Enabled: true, Until: time.Now().Add(48 * time.Hour).Unix()})
	defer server.stop()
	status := server.status()
	if !status.Running {
		t.Fatal("pprof did not start")
	}
	if limit := time.Now().Add(agentPprofMaxDuration + time.Minute).Unix(); status.Until > limit {
		t.Fatalf("until %d exceeds the %s cap", status.Until, agentPprofMaxDuration)
	}
}

func TestPprofExtModuleParsesDirective(t *testing.T) {
	old := agentPprof
	agentPprof = newTestPprofServer()
	defer func() {
		agentPprof.stop()
		agentPprof = old
	}()
	raw, _ := json.Marshal(map[string]any{"enabled": true, "until": time.Now().Add(time.Minute).Unix()})
	pprofExtModule{}.Apply(Config{}, raw)
	report, ok := pprofExtModule{}.Report(Config{}).(agentPprofStatusReport)
	if !ok || !report.Running || report.Addr == "" {
		t.Fatalf("report after enable: %+v", report)
	}
	pprofExtModule{}.Apply(Config{}, json.RawMessage(`{"enabled":false}`))
	if report := (pprofExtModule{}).Report(Config{}).(agentPprofStatusReport); report.Running {
		t.Fatal("still running after disable")
	}
}
