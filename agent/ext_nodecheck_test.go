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
	m.runSpeed = func(ctx context.Context, dial nodeCheckDialFunc, target speedTarget, progress func(speedSample)) (*speedTestResult, error) {
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
	m.startVia = func(ctx context.Context, via *nodeCheckVia) (nodeCheckDialFunc, func(), func() string, error) {
		if string(via.Outbound) != `{"type":"vless"}` {
			t.Fatalf("outbound = %s", via.Outbound)
		}
		dial := func(ctx context.Context, network, address string) (net.Conn, error) {
			sawDial.Store(true)
			return nil, errors.New("fake")
		}
		return dial, func() { stopped <- struct{}{} }, func() string { return "" }, nil
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

	m.startVia = func(ctx context.Context, via *nodeCheckVia) (nodeCheckDialFunc, func(), func() string, error) {
		return nil, nil, nil, errors.New("这台机器没有 sing-box")
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
	_, _, _, err := startNodeCheckSingbox(context.Background(), &nodeCheckVia{Outbound: json.RawMessage(`{"type":"vless"}`), SingboxBin: "/nonexistent/forwardx-singbox"})
	if err == nil || !strings.Contains(err.Error(), "没有 sing-box") {
		t.Fatalf("err = %v", err)
	}
	_, _, _, err = startNodeCheckSingbox(context.Background(), &nodeCheckVia{Outbound: json.RawMessage(`{"type":"vless"}`), SingboxBin: "/nonexistent/forwardx-singbox", InstallCmd: "echo download failed; exit 1"})
	if err == nil || !strings.Contains(err.Error(), "装 sing-box 没成功") || !strings.Contains(err.Error(), "download failed") {
		t.Fatalf("err = %v", err)
	}
	_, _, _, err = startNodeCheckSingbox(context.Background(), &nodeCheckVia{Outbound: json.RawMessage(`{"type":"vless"}`), SingboxBin: "/nonexistent/forwardx-singbox", InstallCmd: "true"})
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
	result, err := runHTTPSpeedTest(context.Background(), dialer.DialContext, cloudflareSpeedTarget(), func(speedSample) { atomic.AddInt32(&samples, 1) })
	if err != nil {
		t.Fatal(err)
	}
	if result.ClientIP != "203.0.113.9" || result.ASN != "AS13335" || result.Colo != "SIN" || result.ASOrg != "Test Org" || result.Server != "cloudflare" {
		t.Fatalf("meta not carried: %+v", result)
	}
	// 回环上延迟可能不到 0.1 ms，四舍五入就是 0：只要求不是负数。
	if result.LatencyMs < 0 || result.JitterMs < 0 || result.DownloadMbps <= 0 || result.UploadMbps <= 0 {
		t.Fatalf("numbers should be sane: %+v", result)
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

// 测速服务器回非 2xx（Cloudflare 对机房出口要 100 MB 会回 403）：以前 403 那一个字节也算下载、
// 没送出去的上传也算成功，结果是「下载 0、上传 2 Gbps」。现在整段报错，带上状态码。
func TestSpeedTestRejectsNon2xx(t *testing.T) {
	var mode atomic.Value
	mode.Store("down403")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/meta":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("{}"))
		case "/cdn-cgi/trace":
			_, _ = w.Write([]byte("fl=1\nip=203.0.113.7\ncolo=SIN\nloc=SG\n"))
		case "/__down":
			if r.URL.Query().Get("bytes") != "0" && mode.Load() == "down403" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte("x"))
				return
			}
			n, _ := atoiSafe(r.URL.Query().Get("bytes"))
			if n > 1<<20 {
				n = 1 << 20
			}
			_, _ = w.Write(make([]byte, n))
		case "/__up":
			if mode.Load() == "up403" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			_, _ = io.Copy(io.Discard, r.Body)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	oldBase, oldDown, oldUp, oldEvery, oldWarm := speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup
	speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup = server.URL, 2*time.Second, 2*time.Second, 100*time.Millisecond, 200*time.Millisecond
	defer func() {
		speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup = oldBase, oldDown, oldUp, oldEvery, oldWarm
	}()
	dialer := &net.Dialer{}
	started := time.Now()
	result, err := runHTTPSpeedTest(context.Background(), dialer.DialContext, cloudflareSpeedTarget(), nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") || !strings.Contains(err.Error(), "speed.cloudflare.com") {
		t.Fatalf("download 403 should fail the run, got result=%+v err=%v", result, err)
	}
	if time.Since(started) > 1500*time.Millisecond {
		t.Fatalf("403 should stop the phase at once, took %v", time.Since(started))
	}

	mode.Store("up403")
	result, err = runHTTPSpeedTest(context.Background(), dialer.DialContext, cloudflareSpeedTarget(), nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") || !strings.Contains(err.Error(), "/__up") {
		t.Fatalf("upload 403 should fail the run, got result=%+v err=%v", result, err)
	}

	// /meta 回 403 但传输正常：出口 IP / 机房从 /cdn-cgi/trace 补，照样出结果。
	mode.Store("ok")
	result, err = runHTTPSpeedTest(context.Background(), dialer.DialContext, cloudflareSpeedTarget(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.ClientIP != "203.0.113.7" || result.Colo != "SIN" || result.Country != "SG" || result.DownloadMbps <= 0 || result.UploadMbps <= 0 {
		t.Fatalf("trace fallback / numbers: %+v", result)
	}
}

// 上传碰到 413（面板前面的反代限制了请求体）：减小每次的量再试，不算失败。
func TestSpeedTestUploadShrinksOn413(t *testing.T) {
	var maxBody atomic.Int64
	maxBody.Store(2 << 20)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/nodecheck/speed/meta":
			if r.Header.Get("Authorization") != "Bearer tok-1" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte(`{"clientIp":"198.51.100.4"}`))
		case "/api/nodecheck/speed/down":
			n, _ := atoiSafe(r.URL.Query().Get("bytes"))
			if n > 1<<20 {
				n = 1 << 20
			}
			_, _ = w.Write(make([]byte, n))
		case "/api/nodecheck/speed/up":
			if r.ContentLength > maxBody.Load() {
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				return
			}
			_, _ = io.Copy(io.Discard, r.Body)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	oldDown, oldUp, oldEvery, oldWarm := speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup
	speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup = 600*time.Millisecond, 2*time.Second, 100*time.Millisecond, 200*time.Millisecond
	defer func() {
		speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup = oldDown, oldUp, oldEvery, oldWarm
	}()
	dialer := &net.Dialer{}
	result, err := runHTTPSpeedTest(context.Background(), dialer.DialContext, panelSpeedTarget(server.URL+"/", "tok-1"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Server != "panel" || result.ClientIP != "198.51.100.4" || result.UploadMbps <= 0 || result.DownloadMbps <= 0 {
		t.Fatalf("panel target: %+v", result)
	}
}

// 模块层：Cloudflare 连不上而面板给了 token，就改测到面板，结果标 server=panel 并带上原因。
func TestNodeCheckSpeedFallsBackToPanel(t *testing.T) {
	m := newNodeCheckExtModule()
	m.wake = func() {}
	var seen []string
	m.runSpeed = func(ctx context.Context, dial nodeCheckDialFunc, target speedTarget, progress func(speedSample)) (*speedTestResult, error) {
		seen = append(seen, target.name)
		if target.name == "cloudflare" {
			progress(speedSample{T: 100, Down: 0})
			return nil, errors.New("连不上 speed.cloudflare.com：dial tcp 104.16.1.1:443: i/o timeout")
		}
		if target.base != "https://panel.example" || target.headers["Authorization"] != "Bearer tok-9" {
			t.Fatalf("panel target = %+v", target)
		}
		progress(speedSample{T: 500, Down: 88})
		return &speedTestResult{LatencyMs: 120, DownloadMbps: 88, UploadMbps: 20, Samples: []speedSample{{T: 500, Down: 88}}}, nil
	}
	directive, _ := json.Marshal(map[string]any{"runs": []map[string]any{{"runId": "nc-fb", "kind": "speed", "panel": map[string]any{"token": "tok-9"}}}})
	m.Apply(Config{PanelURL: "https://panel.example/"}, directive)
	deadline := time.Now().Add(2 * time.Second)
	for {
		report, _ := m.Report(Config{}).(nodeCheckReport)
		if len(report.Runs) == 1 && report.Runs[0].Status == "done" {
			run := report.Runs[0]
			if run.Speed == nil || run.Speed.Server != "panel" || !strings.Contains(run.Speed.Note, "i/o timeout") || !strings.Contains(run.Speed.Note, "改测到面板") {
				t.Fatalf("fallback result: %+v", run.Speed)
			}
			// 第一轮失败时送上去的曲线点不能留在结果里。
			if len(run.Speed.Samples) != 1 || run.Speed.Samples[0].Down != 88 {
				t.Fatalf("samples should be the panel run's: %+v", run.Speed.Samples)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("run never finished: %+v", report)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if strings.Join(seen, ",") != "cloudflare,panel" {
		t.Fatalf("targets tried = %v", seen)
	}

	// 没给 token：只试 Cloudflare，失败就是失败。
	seen = nil
	directive, _ = json.Marshal(map[string]any{"runs": []map[string]any{{"runId": "nc-nofb", "kind": "speed"}}})
	m.Apply(Config{PanelURL: "https://panel.example"}, directive)
	deadline = time.Now().Add(2 * time.Second)
	for {
		report, _ := m.Report(Config{}).(nodeCheckReport)
		var found *nodeCheckRunReport
		for i := range report.Runs {
			if report.Runs[i].RunID == "nc-nofb" {
				found = &report.Runs[i]
			}
		}
		if found != nil && found.Status == "error" {
			if !strings.Contains(found.Error, "i/o timeout") || strings.Join(seen, ",") != "cloudflare" {
				t.Fatalf("error=%q seen=%v", found.Error, seen)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("error run never reported: %+v", report)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 上行慢的机器：一次 25 MB 在测速时间内送不完，到点掐掉那一次时已送出去的字节照算，不能报「没有传输到任何数据」。
func TestSpeedTestUploadSlowLinkStillCounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/meta":
			_, _ = w.Write([]byte(`{"clientIp":"203.0.113.1"}`))
		case "/__down":
			n, _ := atoiSafe(r.URL.Query().Get("bytes"))
			if n > 256<<10 {
				n = 256 << 10
			}
			_, _ = w.Write(make([]byte, n))
		case "/__up":
			// 每 50 ms 只收 64 KB：25 MB 要 20 秒，测速只给 1 秒。
			buf := make([]byte, 64<<10)
			for {
				if _, err := io.ReadFull(r.Body, buf); err != nil {
					break
				}
				time.Sleep(50 * time.Millisecond)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	oldBase, oldDown, oldUp, oldEvery, oldWarm := speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup
	speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup = server.URL, 500*time.Millisecond, time.Second, 100*time.Millisecond, 200*time.Millisecond
	defer func() {
		speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup = oldBase, oldDown, oldUp, oldEvery, oldWarm
	}()
	dialer := &net.Dialer{}
	result, err := runHTTPSpeedTest(context.Background(), dialer.DialContext, cloudflareSpeedTarget(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.UploadMbps <= 0 {
		t.Fatalf("upload should be measured from the bytes sent so far: %+v", result)
	}
}
