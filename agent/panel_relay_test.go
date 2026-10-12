package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// 新设置先不切：试通了才走中转；面板地址对不上的拨号一律直拨。
func TestPanelRelayRouteSelection(t *testing.T) {
	s := &panelRelayState{}
	now := time.Unix(1_700_000_000, 0)
	if target, via := s.route("panel.example.com:443"); via || target != "panel.example.com:443" {
		t.Fatalf("no relay configured must dial directly, got %q %v", target, via)
	}
	if !s.configure("203.0.113.5:20001", "Panel.Example.com:443", now) {
		t.Fatal("configure should report a change")
	}
	if s.configure("203.0.113.5:20001", "panel.example.com:443", now) {
		t.Fatal("same settings must be a no-op")
	}
	if _, via := s.route("panel.example.com:443"); via {
		t.Fatal("relay must not be used before the first successful probe")
	}
	via, ok := s.claimProbe(now)
	if !ok || via != "203.0.113.5:20001" {
		t.Fatalf("probe should be due immediately, got %q %v", via, ok)
	}
	if _, again := s.claimProbe(now); again {
		t.Fatal("only one probe may run at a time")
	}
	if !s.finishProbe(via, nil, now) {
		t.Fatal("successful probe should switch to the relay")
	}
	if target, via := s.route("PANEL.example.com:443"); !via || target != "203.0.113.5:20001" {
		t.Fatalf("panel address should go through relay, got %q %v", target, via)
	}
	if target, via := s.route("api.ipify.org:443"); via || target != "api.ipify.org:443" {
		t.Fatalf("non-panel address must dial directly, got %q %v", target, via)
	}
	if !s.configure("", "panel.example.com:443", now) {
		t.Fatal("clearing should report a change")
	}
	if _, via := s.route("panel.example.com:443"); via {
		t.Fatal("cleared relay must dial directly")
	}
}

func activeRelayState(t *testing.T, now time.Time) *panelRelayState {
	t.Helper()
	s := &panelRelayState{}
	s.configure("198.51.100.7:20001", "panel.example.com:443", now)
	via, _ := s.claimProbe(now)
	if !s.finishProbe(via, nil, now) {
		t.Fatal("setup probe failed")
	}
	return s
}

// 连续 3 次失败退回直连；成功会清零计数。
func TestPanelRelayFallbackAfterConsecutiveFailures(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	s := activeRelayState(t, now)
	if s.noteFailure("x", now) || s.noteFailure("x", now.Add(time.Second)) {
		t.Fatal("two failures must not fall back yet")
	}
	s.noteSuccess(now.Add(2 * time.Second))
	if s.noteFailure("x", now.Add(3*time.Second)) || s.noteFailure("x", now.Add(4*time.Second)) {
		t.Fatal("success should reset the failure streak")
	}
	if !s.noteFailure("boom", now.Add(5*time.Second)) {
		t.Fatal("third consecutive failure must fall back")
	}
	snap := s.snapshot()
	if snap.Active || !snap.Fallback || snap.FallbackCount != 1 || snap.LastError != "boom" {
		t.Fatalf("unexpected snapshot after fallback: %+v", snap)
	}
	if _, via := s.route("panel.example.com:443"); via {
		t.Fatal("fallback must dial the panel directly")
	}
	if s.noteFailure("again", now.Add(6*time.Second)) {
		t.Fatal("failures while already direct must not re-trigger")
	}
}

// 从第一次失败起 2 分钟内一次没成功，第二次失败就退回。
func TestPanelRelayFallbackAfterFailureWindow(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	s := activeRelayState(t, now)
	s.noteFailure("x", now)
	if !s.noteFailure("x", now.Add(panelRelayFailWindow)) {
		t.Fatal("a failing streak lasting the whole window must fall back")
	}
}

// 退回后按退避节奏重试；试通就切回去，中途换了设置的试探结果作废。
func TestPanelRelayProbeBackoffAndRecovery(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	s := activeRelayState(t, now)
	for i := 0; i < panelRelayFailThreshold; i++ {
		s.noteFailure("x", now)
	}
	if _, ok := s.claimProbe(now.Add(panelRelayProbeBackoff[0] - time.Second)); ok {
		t.Fatal("probe must wait for the first backoff step")
	}
	at := now.Add(panelRelayProbeBackoff[0])
	via, ok := s.claimProbe(at)
	if !ok {
		t.Fatal("probe should be due after the first backoff step")
	}
	if s.finishProbe(via, io.EOF, at) {
		t.Fatal("failed probe must stay direct")
	}
	if next := s.snapshot().NextProbeAt; !next.Equal(at.Add(panelRelayProbeBackoff[0])) {
		t.Fatalf("next probe at %v, want %v", next, at.Add(panelRelayProbeBackoff[0]))
	}
	// 退避封顶在最后一档。
	for i := 0; i < 10; i++ {
		at = s.snapshot().NextProbeAt
		via, _ = s.claimProbe(at)
		s.finishProbe(via, io.EOF, at)
	}
	if gap := s.snapshot().NextProbeAt.Sub(at); gap != panelRelayProbeBackoff[len(panelRelayProbeBackoff)-1] {
		t.Fatalf("backoff should cap at %v, got %v", panelRelayProbeBackoff[len(panelRelayProbeBackoff)-1], gap)
	}
	at = s.snapshot().NextProbeAt
	via, _ = s.claimProbe(at)
	s.configure("198.51.100.8:20001", "panel.example.com:443", at)
	if s.finishProbe(via, nil, at) {
		t.Fatal("a probe for an old relay must not switch to the new one")
	}
	via, _ = s.claimProbe(at)
	if via != "198.51.100.8:20001" || !s.finishProbe(via, nil, at) {
		t.Fatal("probe for the new relay should switch")
	}
	if _, viaRelay := s.route("panel.example.com:443"); !viaRelay {
		t.Fatal("expected relay route after recovery")
	}
}

func TestPanelRelayRestoreFromDisk(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	active := &panelRelayState{}
	active.restore(panelRelayPersisted{Via: "198.51.100.7:20001", PanelAddr: "panel.example.com:443", Active: true}, now)
	if _, via := active.route("panel.example.com:443"); !via {
		t.Fatal("restored active relay should be used right away")
	}
	waiting := &panelRelayState{}
	waiting.restore(panelRelayPersisted{Via: "198.51.100.7:20001", PanelAddr: "panel.example.com:443"}, now)
	if _, via := waiting.route("panel.example.com:443"); via {
		t.Fatal("restored inactive relay must stay direct until probed")
	}
	bad := &panelRelayState{}
	bad.restore(panelRelayPersisted{Via: "not a host", PanelAddr: "panel.example.com:443", Active: true}, now)
	if bad.snapshot().Via != "" {
		t.Fatal("invalid saved via must be ignored")
	}
}

func TestPanelAddrFromURL(t *testing.T) {
	cases := map[string]string{
		"http://1.2.3.4:9810":          "1.2.3.4:9810",
		"https://Panel.Example.com":    "panel.example.com:443",
		"http://panel.example.com/sub": "panel.example.com:80",
		"https://[2001:db8::1]:8443/":  "[2001:db8::1]:8443",
		"ftp://x":                      "",
	}
	for in, want := range cases {
		if got := panelAddrFromURL(in); got != want {
			t.Fatalf("panelAddrFromURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

// 中转只接受名单里的 IP。
func TestPanelRelayListenerAllowlist(t *testing.T) {
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	defer panel.Close()
	port := freeTCPPort(t)
	l := newPanelRelayListener()
	defer l.stop()
	target := panel.Listener.Addr().String()
	l.apply(&relayListenDirective{Port: port, Target: target, Allow: []string{"192.0.2.10"}}, time.Now())
	if l.addr() == nil {
		t.Fatalf("listener did not start: %s", l.lastError)
	}
	relayAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", relayAddr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.WriteString(conn, "GET / HTTP/1.1\r\nHost: x\r\n\r\n")
	buf := make([]byte, 16)
	if n, _ := conn.Read(buf); n != 0 {
		t.Fatalf("connection from a non-allowed IP must be closed, read %q", buf[:n])
	}
	_ = conn.Close()
	if l.rejected.Load() != 1 || l.relayed.Load() != 0 {
		t.Fatalf("rejected=%d relayed=%d", l.rejected.Load(), l.relayed.Load())
	}
	// 名单更新后不用重开端口就生效。
	l.apply(&relayListenDirective{Port: port, Target: target, Allow: []string{"127.0.0.1"}}, time.Now())
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{
		DialContext: (&net.Dialer{}).DialContext, Proxy: nil,
	}}
	res, err := client.Get("http://" + relayAddr + "/")
	if err != nil {
		t.Fatalf("allowed IP should be relayed: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(body) != "ok" || l.relayed.Load() != 1 {
		t.Fatalf("body=%q relayed=%d", body, l.relayed.Load())
	}
	// 关掉中转：端口放掉。
	l.apply(nil, time.Now())
	if l.addr() != nil {
		t.Fatal("listener should stop when the directive drops listen")
	}
}

func withIsolatedPanelRelay(t *testing.T) {
	t.Helper()
	oldPath := panelRelayStatePath
	oldState := panelRelay
	panelRelayStatePath = filepath.Join(t.TempDir(), "panel-relay.json")
	ensurePanelRelayLoaded() // 先把 Once 用掉，别去读真机上的文件
	panelRelay = &panelRelayState{}
	t.Cleanup(func() {
		panelRelay = oldState
		panelRelayStatePath = oldPath
	})
}

// 端到端：被中转的 Agent 用自己的 HTTP 客户端访问面板 URL，实际经本机中转监听到达假面板；
// 中转坏掉后连续失败三次退回直连，请求照样能到面板。
func TestPanelRelayEndToEndThroughListenerAndFallback(t *testing.T) {
	withIsolatedPanelRelay(t)
	var seenHost string
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenHost = r.Host
		_, _ = io.WriteString(w, "panel")
	}))
	defer panel.Close()
	panelAddr := panel.Listener.Addr().String()

	port := freeTCPPort(t)
	relay := newPanelRelayListener()
	defer relay.stop()
	relay.apply(&relayListenDirective{Port: port, Target: panelAddr, Allow: []string{"127.0.0.1", "::1"}}, time.Now())
	if relay.addr() == nil {
		t.Fatalf("relay listener did not start: %s", relay.lastError)
	}
	via := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))

	// 试探也走真的：经中转能拿到面板的回应。
	if err := probePanelViaRelay(panel.URL, via); err != nil {
		t.Fatalf("probe through relay failed: %v", err)
	}
	relayedAfterProbe := relay.relayed.Load()

	now := time.Now()
	panelRelay.configure(via, panelAddrFromURL(panel.URL), now)
	claimed, _ := panelRelay.claimProbe(now)
	panelRelay.finishProbe(claimed, nil, now)

	transport := newAgentHTTPTransport(false)
	transport.Proxy = nil
	client := &http.Client{Timeout: 5 * time.Second, Transport: transport}
	get := func() string {
		t.Helper()
		res, err := client.Get(panel.URL + "/api/agent/ext")
		if err != nil {
			t.Fatalf("request failed: %v", err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return string(body)
	}
	if body := get(); body != "panel" {
		t.Fatalf("unexpected body %q", body)
	}
	if relay.relayed.Load() != relayedAfterProbe+1 {
		t.Fatalf("request should have gone through the relay, relayed=%d", relay.relayed.Load())
	}
	if seenHost != panelAddr {
		t.Fatalf("panel must see its own Host header, got %q", seenHost)
	}
	if snap := panelRelay.snapshot(); !snap.Active || snap.LastSuccessAt.IsZero() {
		t.Fatalf("relay should be active with a recorded success: %+v", snap)
	}

	// 中转机上的转发停了：拨不通 → 三次后退回直连。
	relay.stop()
	transport.CloseIdleConnections()
	for i := 0; i < panelRelayFailThreshold; i++ {
		if _, err := client.Get(panel.URL + "/"); err == nil {
			t.Fatal("request through a dead relay should fail")
		}
	}
	snap := panelRelay.snapshot()
	if !snap.Fallback || snap.Active {
		t.Fatalf("expected fallback after %d failures: %+v", panelRelayFailThreshold, snap)
	}
	if body := get(); body != "panel" {
		t.Fatalf("direct fallback should reach the panel, got %q", body)
	}
}

// 中转连得上、但它连不上面板（接了就断）：发了请求一个字节都没回，算失败。
func TestPanelRelayCountsSilentRelayAsFailure(t *testing.T) {
	withIsolatedPanelRelay(t)
	// 面板地址用 127.0.0.1:1：没人听（拨了就被拒），也不会像随手关掉的端口那样被别的监听复用。
	panelURL := "http://127.0.0.1:1"

	port := freeTCPPort(t)
	relay := newPanelRelayListener()
	defer relay.stop()
	// 目标是一个已经关掉的端口：中转接下连接后拨不通面板，直接关掉。
	relay.apply(&relayListenDirective{Port: port, Target: panelAddrFromURL(panelURL), Allow: []string{"127.0.0.1", "::1"}}, time.Now())
	via := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	now := time.Now()
	panelRelay.configure(via, panelAddrFromURL(panelURL), now)
	claimed, _ := panelRelay.claimProbe(now)
	panelRelay.finishProbe(claimed, nil, now)

	transport := newAgentHTTPTransport(false)
	transport.Proxy = nil
	client := &http.Client{Timeout: 5 * time.Second, Transport: transport}
	if _, err := client.Get(panelURL + "/"); err == nil {
		t.Fatal("expected failure")
	}
	if snap := panelRelay.snapshot(); snap.LastError == "" {
		t.Fatalf("silent relay should be recorded as a failure: %+v", snap)
	}
	if relay.failed.Load() == 0 {
		t.Fatal("relay should count the failed upstream dial")
	}
}
