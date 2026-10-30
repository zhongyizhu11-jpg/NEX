package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 同一个 runId 只跑一次；认不出的 kind / 坏 id 不收；跑完报 done 带结果，再报一次还在。
func TestNodeCheckRunsOncePerRunID(t *testing.T) {
	m := newNodeCheckExtModule()
	var calls int32
	m.wake = func() {}
	m.runSpeed = func(ctx context.Context, dial nodeCheckDialFunc, progress func(speedSample)) (*speedTestResult, error) {
		atomic.AddInt32(&calls, 1)
		progress(speedSample{T: 500, Down: 12.5})
		return &speedTestResult{LatencyMs: 9, DownloadMbps: 12.5, UploadMbps: 3, Colo: "SIN", Samples: []speedSample{{T: 500, Down: 12.5}}}, nil
	}
	if m.Report(Config{}) != nil {
		t.Fatal("nothing to report before any run")
	}
	directive, _ := json.Marshal(nodeCheckDirective{Runs: []nodeCheckRunDirective{
		{RunID: "nc-1", Kind: "speed"},
		{RunID: "nc-1", Kind: "speed"},
		{RunID: "bad id!", Kind: "speed"},
		{RunID: "nc-2", Kind: "weird"},
	}})
	m.Apply(Config{}, directive)
	m.Apply(Config{}, directive)
	deadline := time.Now().Add(2 * time.Second)
	for {
		report, _ := m.Report(Config{}).(nodeCheckReport)
		if len(report.Runs) == 1 && report.Runs[0].Status == "done" {
			run := report.Runs[0]
			if run.RunID != "nc-1" || run.Kind != "speed" || run.Speed == nil || run.Speed.Colo != "SIN" || run.FinishedAt == 0 || run.Phase != "" {
				t.Fatalf("unexpected report %+v", run)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("run never finished: %+v", report)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("run should happen once, got %d", n)
	}
	if report, _ := m.Report(Config{}).(nodeCheckReport); len(report.Runs) != 1 {
		t.Fatalf("done result should stay in the next report: %+v", report)
	}
}

// 经节点：先起 sing-box 拿拨号函数，跑完一定停掉；起不来就报 error 而不是 done。
func TestNodeCheckViaProxyStartsAndStopsSingbox(t *testing.T) {
	m := newNodeCheckExtModule()
	m.wake = func() {}
	stopped := make(chan struct{}, 1)
	var sawDial atomic.Bool
	m.startVia = func(ctx context.Context, via *nodeCheckVia) (nodeCheckDialFunc, func(), error) {
		if string(via.Outbound) != `{"type":"vless"}` {
			t.Fatalf("outbound = %s", via.Outbound)
		}
		dial := func(ctx context.Context, network, address string) (net.Conn, error) {
			sawDial.Store(true)
			return nil, errors.New("fake")
		}
		return dial, func() { stopped <- struct{}{} }, nil
	}
	m.runExit = func(ctx context.Context, dial nodeCheckDialFunc, viaProxy bool, family string, targets []siteLatencyTarget) (*exitCheckResult, error) {
		if !viaProxy {
			t.Fatal("viaProxy should be true")
		}
		_, _ = dial(ctx, "tcp", "example.com:443")
		return &exitCheckResult{Sites: []siteLatencyReportTarget{{Key: "google", Samples: []siteLatencySample{{Ms: 42}}}}, Unlock: []unlockResult{{Service: "netflix", Status: "ok"}}}, nil
	}
	directive, _ := json.Marshal(map[string]any{"runs": []map[string]any{{"runId": "nc-via", "kind": "exit", "via": map[string]any{"outbound": map[string]any{"type": "vless"}}}}})
	m.Apply(Config{}, directive)
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("sing-box was never stopped")
	}
	// 停掉 sing-box 之后才标 done：多等一会儿。
	var report nodeCheckReport
	waitDeadline := time.Now().Add(2 * time.Second)
	for {
		report, _ = m.Report(Config{}).(nodeCheckReport)
		if len(report.Runs) == 1 && report.Runs[0].Status == "done" {
			break
		}
		if time.Now().After(waitDeadline) {
			t.Fatalf("run never finished: %+v", report)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if report.Runs[0].Exit == nil || !sawDial.Load() {
		t.Fatalf("unexpected report %+v", report)
	}
	if report.Runs[0].Exit.Unlock[0].Service != "netflix" || report.Runs[0].Exit.Sites[0].Key != "google" {
		t.Fatalf("exit result not carried: %+v", report.Runs[0].Exit)
	}

	m.startVia = func(ctx context.Context, via *nodeCheckVia) (nodeCheckDialFunc, func(), error) {
		return nil, nil, errors.New("这台机器没有 sing-box")
	}
	directive, _ = json.Marshal(map[string]any{"runs": []map[string]any{{"runId": "nc-nobin", "kind": "speed", "via": map[string]any{"outbound": map[string]any{"type": "vless"}}}}})
	m.Apply(Config{}, directive)
	deadline := time.Now().Add(2 * time.Second)
	for {
		report, _ := m.Report(Config{}).(nodeCheckReport)
		var found *nodeCheckRunReport
		for i := range report.Runs {
			if report.Runs[i].RunID == "nc-nobin" {
				found = &report.Runs[i]
			}
		}
		if found != nil && found.Status == "error" {
			if !strings.Contains(found.Error, "sing-box") {
				t.Fatalf("error = %q", found.Error)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("error run never reported: %+v", report)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 没装 sing-box 的机器：面板没给装机脚本就说清楚怎么办；给了就先跑脚本，脚本失败把输出带回去。
func TestNodeCheckSingboxMissingBinary(t *testing.T) {
	_, _, err := startNodeCheckSingbox(context.Background(), &nodeCheckVia{Outbound: json.RawMessage(`{"type":"vless"}`), SingboxBin: "/nonexistent/forwardx-singbox"})
	if err == nil || !strings.Contains(err.Error(), "没有 sing-box") {
		t.Fatalf("err = %v", err)
	}
	_, _, err = startNodeCheckSingbox(context.Background(), &nodeCheckVia{Outbound: json.RawMessage(`{"type":"vless"}`), SingboxBin: "/nonexistent/forwardx-singbox", InstallCmd: "echo download failed; exit 1"})
	if err == nil || !strings.Contains(err.Error(), "装 sing-box 没成功") || !strings.Contains(err.Error(), "download failed") {
		t.Fatalf("err = %v", err)
	}
	_, _, err = startNodeCheckSingbox(context.Background(), &nodeCheckVia{Outbound: json.RawMessage(`{"type":"vless"}`), SingboxBin: "/nonexistent/forwardx-singbox", InstallCmd: "true"})
	if err == nil || !strings.Contains(err.Error(), "装完还是没有") {
		t.Fatalf("err = %v", err)
	}
}

// 对一个本地「Cloudflare」跑一遍：有延迟 / 抖动、下载上传都大于 0、曲线有样本、元数据带进来。
func TestCloudflareSpeedTestAgainstLocalServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/meta":
			_ = json.NewEncoder(w).Encode(map[string]any{"clientIp": "203.0.113.9", "asn": 13335, "asOrganization": "Test Org", "colo": "SIN", "country": "SG", "city": "Singapore"})
		case r.URL.Path == "/__down":
			n := 0
			if v := r.URL.Query().Get("bytes"); v != "" {
				n, _ = atoiSafe(v)
			}
			if n > 4<<20 {
				n = 4 << 20
			}
			chunk := make([]byte, 64<<10)
			for n > 0 {
				size := len(chunk)
				if n < size {
					size = n
				}
				if _, err := w.Write(chunk[:size]); err != nil {
					return
				}
				n -= size
			}
		case r.URL.Path == "/__up":
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	oldBase, oldDown, oldUp, oldEvery, oldWarm := speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup
	speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup = server.URL, 700*time.Millisecond, 500*time.Millisecond, 100*time.Millisecond, 200*time.Millisecond
	defer func() {
		speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup = oldBase, oldDown, oldUp, oldEvery, oldWarm
	}()
	dialer := &net.Dialer{}
	var samples int32
	result, err := runCloudflareSpeedTest(context.Background(), dialer.DialContext, func(speedSample) { atomic.AddInt32(&samples, 1) })
	if err != nil {
		t.Fatal(err)
	}
	if result.ClientIP != "203.0.113.9" || result.ASN != "AS13335" || result.Colo != "SIN" || result.ASOrg != "Test Org" {
		t.Fatalf("meta not carried: %+v", result)
	}
	if result.LatencyMs <= 0 || result.DownloadMbps <= 0 || result.UploadMbps <= 0 {
		t.Fatalf("numbers should be positive: %+v", result)
	}
	if len(result.Samples) < 4 || atomic.LoadInt32(&samples) != int32(len(result.Samples)) {
		t.Fatalf("samples = %d (progress %d)", len(result.Samples), samples)
	}
	hasDown, hasUp := false, false
	for _, sample := range result.Samples {
		hasDown = hasDown || sample.Down > 0
		hasUp = hasUp || sample.Up > 0
	}
	if !hasDown || !hasUp {
		t.Fatalf("curve should carry both phases: %+v", result.Samples)
	}
}

func TestSummarizeLatenciesAndASN(t *testing.T) {
	latency, jitter := summarizeLatencies([]float64{10, 12, 11, 30})
	if latency != 11.5 || jitter != 7.3 {
		t.Fatalf("latency=%v jitter=%v", latency, jitter)
	}
	if normalizeSpeedASN(float64(13335)) != "AS13335" || normalizeSpeedASN("as209699") != "AS209699" || normalizeSpeedASN("") != "" || normalizeSpeedASN(float64(0)) != "" {
		t.Fatal("asn normalize")
	}
}

func atoiSafe(value string) (int, error) {
	n := 0
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}
