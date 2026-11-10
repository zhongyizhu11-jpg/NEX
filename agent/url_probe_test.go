package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func urlTask(target string) urlProbeTask {
	return urlProbeTask{ServiceID: 7, URL: target, IntervalSeconds: 30, TimeoutSeconds: 2, ExpectStatus: "200-399", ProbeKey: "service:7:http:abc"}
}

func TestURLProbeSuccessReportsStatusAndLatency(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	m := runURLProbe(urlTask(server.URL + "/healthz"))
	if !m.Reachable || m.ProbeSuccesses != 1 || m.ProbeCount != 1 {
		t.Fatalf("expected success, got %+v", m)
	}
	if m.HTTPStatus != http.StatusNoContent || m.LatencyMs < 1 {
		t.Fatalf("unexpected status/latency %+v", m)
	}
}

func TestURLProbeStatusMismatchIsHTTPStatusFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	m := runURLProbe(urlTask(server.URL))
	if m.Reachable || m.ProbeSuccesses != 0 || m.Failure != "http_status" || m.HTTPStatus != 503 {
		t.Fatalf("expected http_status failure, got %+v", m)
	}
	payload := urlProbeResultPayload(urlTask(server.URL), m)
	if payload["failure"] != "http_status" || payload["httpStatus"] != 503 || payload["isTimeout"] != true {
		t.Fatalf("unexpected payload %#v", payload)
	}
	if _, leaked := payload["targetIp"]; leaked {
		t.Fatalf("URL must not be reported back: %#v", payload)
	}
	// 自定义预期状态码：503 被写进预期里就算通
	custom := urlTask(server.URL)
	custom.ExpectStatus = "200,503"
	if got := runURLProbe(custom); !got.Reachable {
		t.Fatalf("503 should match custom expectation, got %+v", got)
	}
}

func TestURLProbeDoesNotFollowRedirects(t *testing.T) {
	var targetHits int
	var mu sync.Mutex
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		targetHits++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redirect.Close()

	m := runURLProbe(urlTask(redirect.URL))
	if !m.Reachable || m.HTTPStatus != http.StatusFound {
		t.Fatalf("302 should be the probe's own status and count as 2xx/3xx success, got %+v", m)
	}
	strict := urlTask(redirect.URL)
	strict.ExpectStatus = "200"
	if got := runURLProbe(strict); got.Reachable || got.Failure != "http_status" || got.HTTPStatus != http.StatusFound {
		t.Fatalf("302 must not satisfy expected 200, got %+v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if targetHits != 0 {
		t.Fatalf("redirect target must not be requested, hits=%d", targetHits)
	}
}

func TestURLProbeTimeout(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	task := urlTask(server.URL)
	task.TimeoutSeconds = 1
	started := time.Now()
	m := runURLProbe(task)
	if m.Reachable || m.Failure != "timeout" {
		t.Fatalf("expected timeout, got %+v", m)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("timeout not enforced: %s", elapsed)
	}
}

func TestURLProbeTLSErrorUnlessSkipVerify(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	m := runURLProbe(urlTask(server.URL))
	if m.Reachable || m.Failure != "tls" {
		t.Fatalf("self-signed certificate must fail as tls, got %+v", m)
	}
	skip := urlTask(server.URL)
	skip.InsecureSkipVerify = true
	if got := runURLProbe(skip); !got.Reachable || got.HTTPStatus != 200 {
		t.Fatalf("insecureSkipVerify should accept the certificate, got %+v", got)
	}
}

func TestURLProbeLatencyIsConnectToFirstByte(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		// 响应体拖很久：首字节之后的时间不算进延迟，也不等它
		time.Sleep(1500 * time.Millisecond)
		_, _ = w.Write([]byte(strings.Repeat("x", 1024)))
	}))
	defer server.Close()
	started := time.Now()
	m := runURLProbe(urlTask(server.URL))
	elapsed := time.Since(started)
	if !m.Reachable {
		t.Fatalf("expected success, got %+v", m)
	}
	if m.LatencyMs < 140 || m.LatencyMs > 1000 {
		t.Fatalf("latency should cover the server delay before the first byte only, got %dms", m.LatencyMs)
	}
	if elapsed > time.Second {
		t.Fatalf("probe must not wait for the response body, took %s", elapsed)
	}
}

func TestURLProbeSendsNoCredentialsAndNewConnection(t *testing.T) {
	var mu sync.Mutex
	var headers []http.Header
	var remotes []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		headers = append(headers, r.Header.Clone())
		remotes = append(remotes, r.RemoteAddr)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	for i := 0; i < 2; i++ {
		if m := runURLProbe(urlTask(server.URL)); !m.Reachable {
			t.Fatalf("probe %d failed: %+v", i, m)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for _, header := range headers {
		if header.Get("Authorization") != "" || header.Get("Cookie") != "" || header.Get("X-Agent-Token") != "" {
			t.Fatalf("probe must not carry credentials: %v", header)
		}
	}
	if len(remotes) != 2 || remotes[0] == remotes[1] {
		t.Fatalf("each probe must use a fresh connection, remotes=%v", remotes)
	}
}

func TestURLProbeRejectsNonHTTPSchemes(t *testing.T) {
	for _, target := range []string{"file:///etc/passwd", "ftp://example.com/", "gopher://x", "http://user:pass@example.com/", "https://exa mple.com/", "", "//example.com"} {
		if _, ok := parseURLProbeTarget(target); ok {
			t.Fatalf("%q must be rejected", target)
		}
		m := runURLProbe(urlTask(target))
		if m.Reachable || m.Failure != "error" {
			t.Fatalf("%q should fail without a request, got %+v", target, m)
		}
	}
	if _, ok := parseURLProbeTarget("https://example.com/health?x=1"); !ok {
		t.Fatal("https URL should be accepted")
	}
	long := "https://example.com/" + strings.Repeat("a", urlProbeMaxURLLength)
	if _, ok := parseURLProbeTarget(long); ok {
		t.Fatal("over-long URL must be rejected")
	}
}

func TestURLProbeStatusRanges(t *testing.T) {
	ranges, ok := parseURLProbeStatusRanges("")
	if !ok || !urlProbeStatusExpected(ranges, 200) || !urlProbeStatusExpected(ranges, 399) || urlProbeStatusExpected(ranges, 404) {
		t.Fatalf("default should be 200-399: %+v", ranges)
	}
	ranges, ok = parseURLProbeStatusRanges("204, 301-302")
	if !ok || !urlProbeStatusExpected(ranges, 204) || !urlProbeStatusExpected(ranges, 302) || urlProbeStatusExpected(ranges, 200) {
		t.Fatalf("unexpected ranges %+v", ranges)
	}
	for _, bad := range []string{"abc", "399-200", "700", "99"} {
		if _, ok := parseURLProbeStatusRanges(bad); ok {
			t.Fatalf("%q should be rejected", bad)
		}
	}
	if urlProbeTimeout(0) != 5*time.Second || urlProbeTimeout(90) != 30*time.Second {
		t.Fatal("timeout must default to 5s and cap at 30s")
	}
}

func TestURLProbeScheduleRespectsIntervalAndRunning(t *testing.T) {
	schedule := &urlProbeSchedule{}
	now := time.Unix(1_700_000_000, 0)
	task := urlTask("https://example.com/")
	if got := schedule.take([]urlProbeTask{task}, now); len(got) != 1 {
		t.Fatalf("first round should run, got %d", len(got))
	}
	// 还在跑：不重复起
	if got := schedule.take([]urlProbeTask{task}, now.Add(time.Minute)); len(got) != 0 {
		t.Fatalf("running task must not start twice")
	}
	schedule.finish(task.ServiceID)
	if got := schedule.take([]urlProbeTask{task}, now.Add(10*time.Second)); len(got) != 0 {
		t.Fatalf("not due yet")
	}
	if got := schedule.take([]urlProbeTask{task}, now.Add(27*time.Second)); len(got) != 1 {
		t.Fatalf("due within jitter slack")
	}
	schedule.finish(task.ServiceID)
	changed := task
	changed.ExpectStatus = "200"
	if got := schedule.take([]urlProbeTask{changed}, now.Add(28*time.Second)); len(got) != 1 {
		t.Fatalf("changed config should run immediately")
	}
	schedule.finish(task.ServiceID)
	schedule.take(nil, now.Add(time.Hour))
	if len(schedule.runs) != 0 {
		t.Fatalf("removed services must be forgotten: %+v", schedule.runs)
	}
}

func TestBuildURLProbeTasksOnlyHTTPAndTCPingSkipsThem(t *testing.T) {
	probes := []hostProbeServiceProbe{
		{ServiceID: 1, Method: "http", TargetIP: "https://example.com/", IntervalSeconds: 60, TimeoutSeconds: 3, ExpectStatus: "200", ProbeKey: "k"},
		{ServiceID: 2, Method: "tcping", TargetIP: "example.com", TargetPort: 443},
		{ServiceID: 3, Method: "ping", TargetIP: "example.com"},
	}
	tasks := buildURLProbeTasks(probes)
	if len(tasks) != 1 || tasks[0].ServiceID != 1 || tasks[0].TimeoutSeconds != 3 || tasks[0].ProbeKey != "k" {
		t.Fatalf("unexpected url tasks %+v", tasks)
	}
}

func TestRunURLProbeBatchReportsEveryResult(t *testing.T) {
	schedule := &urlProbeSchedule{}
	tasks := make([]urlProbeTask, 0, urlProbeMaxConcurrency+3)
	for i := 1; i <= urlProbeMaxConcurrency+3; i++ {
		task := urlTask("https://example.com/")
		task.ServiceID = i
		tasks = append(tasks, task)
	}
	schedule.take(tasks, time.Now())
	var reported []map[string]any
	runURLProbeBatch(schedule, tasks, func(task urlProbeTask) probeMeasurement {
		if task.ServiceID == 2 {
			panic("boom")
		}
		return probeMeasurement{ProbeCount: 1, ProbeSuccesses: 1, Reachable: true, LatencyMs: 5, HTTPStatus: 200}
	}, func(results []map[string]any) { reported = append(reported, results...) })
	if len(reported) != len(tasks) {
		t.Fatalf("expected %d results, got %d", len(tasks), len(reported))
	}
	for _, item := range reported {
		if item["serviceId"] == 2 && item["failure"] != "error" {
			t.Fatalf("panic should be reported as error: %#v", item)
		}
	}
	for _, run := range schedule.runs {
		if run.running {
			t.Fatal("all runs must be finished")
		}
	}
}
