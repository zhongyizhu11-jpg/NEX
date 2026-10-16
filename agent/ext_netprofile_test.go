package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeTimeoutErr struct{}

func (fakeTimeoutErr) Error() string   { return "i/o timeout" }
func (fakeTimeoutErr) Timeout() bool   { return true }
func (fakeTimeoutErr) Temporary() bool { return true }

// 假的 SMTP 服务端：写一行欢迎语，然后读客户端发来的东西（应该只有 QUIT）。
func fakeSMTPConn(t *testing.T, banner string, received *[]string, mu *sync.Mutex) net.Conn {
	client, server := net.Pipe()
	go func() {
		defer server.Close()
		_ = server.SetDeadline(time.Now().Add(2 * time.Second))
		if banner != "" {
			if _, err := server.Write([]byte(banner + "\r\n")); err != nil {
				return
			}
		}
		buf := make([]byte, 256)
		n, _ := server.Read(buf)
		mu.Lock()
		*received = append(*received, string(buf[:n]))
		mu.Unlock()
	}()
	return client
}

func newTestNetProfileModule() *netProfileExtModule {
	m := newNetProfileExtModule()
	m.async = false
	m.fallbackIPv4 = func() string { return "" }
	m.hasGlobalIPv6 = func() bool { return true }
	return m
}

func TestNetProfileRunsAllChecksWithFakes(t *testing.T) {
	m := newTestNetProfileModule()
	var mu sync.Mutex
	var received []string
	var networks []string
	m.httpGet = func(ctx context.Context, network, url string) (string, error) {
		mu.Lock()
		networks = append(networks, network+" "+url)
		mu.Unlock()
		if network == "tcp4" {
			return "203.0.113.7\n", nil
		}
		return "", errors.New("dial tcp6: connect: network is unreachable")
	}
	m.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		switch {
		case strings.HasPrefix(addr, "gmail"):
			return fakeSMTPConn(t, "220 mx.google.com ESMTP ready", &received, &mu), nil
		case strings.HasPrefix(addr, "mx1"):
			return nil, errors.New("dial tcp 17.57.154.33:25: connect: connection refused")
		default:
			return nil, fakeTimeoutErr{}
		}
	}
	var queried []string
	m.lookupHost = func(ctx context.Context, name string) ([]string, error) {
		mu.Lock()
		queried = append(queried, name)
		mu.Unlock()
		switch {
		case strings.HasSuffix(name, ".zen.spamhaus.org."):
			return []string{"127.255.255.254"}, nil
		case strings.HasSuffix(name, ".bl.spamcop.net."):
			return []string{"127.0.0.2"}, nil
		case strings.HasSuffix(name, ".b.barracudacentral.org."):
			return nil, &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
		default:
			return nil, &net.DNSError{Err: "server misbehaving", Name: name, IsTemporary: true}
		}
	}
	directive, _ := json.Marshal(netProfileDirective{IntervalSeconds: 21600, RunID: "np-1"})
	m.Apply(Config{}, directive)

	report, ok := m.Report(Config{}).(map[string]any)
	if !ok {
		t.Fatalf("expected a report with the result")
	}
	result := report["result"].(*netProfileResult)
	if report["runId"] != "np-1" || result.ResultID == "" {
		t.Fatalf("report should carry runId and resultId: %#v", report)
	}
	if !result.IPv4.OK || result.IPv4.Address != "203.0.113.7" || result.IPv4.LatencyMs < 1 {
		t.Fatalf("ipv4 check wrong: %#v", result.IPv4)
	}
	if result.IPv6.OK || !strings.Contains(result.IPv6.Error, "unreachable") || result.IPv6.Configured == nil || !*result.IPv6.Configured {
		t.Fatalf("ipv6 check wrong: %#v", result.IPv6)
	}
	if result.SMTP25.Status != "open" || !strings.Contains(result.SMTP25.Detail, "220 mx.google.com") {
		t.Fatalf("smtp should be open via gmail: %#v", result.SMTP25)
	}
	statuses := map[string]string{}
	for _, item := range result.SMTP25.Targets {
		statuses[strings.SplitN(item.Target, ".", 2)[0]] = item.Status
	}
	if statuses["gmail-smtp-in"] != "open" || statuses["mx1"] != "refused" || statuses["alt1"] != "timeout" {
		t.Fatalf("per-target statuses wrong: %#v", statuses)
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	if len(received) != 1 || received[0] != "QUIT\r\n" {
		t.Fatalf("client must only send QUIT after the banner, got %q", received)
	}
	mu.Unlock()
	if result.DNSBLAddress != "203.0.113.7" || len(result.DNSBL) != 4 {
		t.Fatalf("dnsbl should query the public ipv4 on 4 lists: %#v", result)
	}
	for _, name := range queried {
		if !strings.HasPrefix(name, "7.113.0.203.") || !strings.HasSuffix(name, ".") {
			t.Fatalf("dnsbl query name should be reversed + absolute: %s", name)
		}
	}
	byList := map[string]netProfileDNSBLEntry{}
	for _, entry := range result.DNSBL {
		byList[entry.List] = entry
	}
	if e := byList["zen.spamhaus.org"]; e.Listed || e.Error != "无法查询（公共解析器被拒绝）" {
		t.Fatalf("spamhaus refused code must not count as listed: %#v", e)
	}
	if e := byList["bl.spamcop.net"]; !e.Listed || e.Code != "127.0.0.2" {
		t.Fatalf("spamcop should be listed: %#v", e)
	}
	if e := byList["b.barracudacentral.org"]; e.Listed || !e.NotFound || e.Error != "" {
		t.Fatalf("nxdomain should be clean: %#v", e)
	}
	if e := byList["cbl.abuseat.org"]; e.Listed || e.Error == "" {
		t.Fatalf("servfail should be an error: %#v", e)
	}
	_ = networks
}

func TestNetProfilePendingResultKeptUntilAcked(t *testing.T) {
	m := newTestNetProfileModule()
	m.httpGet = func(ctx context.Context, network, url string) (string, error) { return "", errors.New("down") }
	m.dial = func(ctx context.Context, network, addr string) (net.Conn, error) { return nil, fakeTimeoutErr{} }
	m.lookupHost = func(ctx context.Context, name string) ([]string, error) { return nil, errors.New("unused") }
	now := time.Unix(1_800_000_000, 0)
	m.now = func() time.Time { return now }

	first, _ := json.Marshal(netProfileDirective{})
	m.Apply(Config{}, first)
	report := m.Report(Config{}).(map[string]any)
	result := report["result"].(*netProfileResult)
	if result.SMTP25.Status != "timeout" || len(result.DNSBL) != 0 {
		t.Fatalf("all-timeout smtp, no ipv4 → no dnsbl: %#v", result)
	}
	// 回执不对：照样留着
	wrong, _ := json.Marshal(netProfileDirective{AckResultID: "nope", LastCheckedAt: now.Unix() - 10})
	m.Apply(Config{}, wrong)
	if m.Report(Config{}) == nil {
		t.Fatalf("result must be kept until acked")
	}
	ack, _ := json.Marshal(netProfileDirective{AckResultID: result.ResultID, LastCheckedAt: now.Unix()})
	m.Apply(Config{}, ack)
	if r := m.Report(Config{}); r != nil {
		t.Fatalf("acked result should be dropped, got %#v", r)
	}
	// 6 小时没到、没有新 runId：不测
	now = now.Add(time.Hour)
	calls := 0
	m.httpGet = func(ctx context.Context, network, url string) (string, error) { calls++; return "", errors.New("down") }
	m.Apply(Config{}, ack)
	if calls != 0 {
		t.Fatalf("should not re-run before interval")
	}
	// 新的 runId：立刻测；同一个 runId 再来不重复测
	run, _ := json.Marshal(netProfileDirective{RunID: "np-2", LastCheckedAt: now.Unix() - 3600})
	m.Apply(Config{}, run)
	if calls == 0 {
		t.Fatalf("new runId should trigger a run")
	}
	before := calls
	m.Apply(Config{}, run)
	if calls != before {
		t.Fatalf("same runId must not run twice")
	}
	// 到点了：再测
	now = now.Add(7 * time.Hour)
	m.Apply(Config{}, ack)
	if calls == before {
		t.Fatalf("should run again after interval")
	}
}

func TestNetProfileRejectsWrongFamilyAddress(t *testing.T) {
	m := newTestNetProfileModule()
	m.httpGet = func(ctx context.Context, network, url string) (string, error) {
		if strings.Contains(url, "icanhazip") {
			return "198.51.100.1", nil // 走 tcp6 却回了 IPv4：不算通
		}
		return "2001:db8::5", nil
	}
	got := m.checkFamily("tcp6", []string{"https://ipv6.icanhazip.com", "https://api6.ipify.org"})
	if !got.OK || got.Address != "2001:db8::5" {
		t.Fatalf("should fall through to the second url with a real v6 address: %#v", got)
	}
}

func TestInterpretDNSBLEntryCodes(t *testing.T) {
	cases := []struct {
		answers []string
		listed  bool
		code    string
		err     bool
	}{
		{[]string{"127.0.0.2"}, true, "127.0.0.2", false},
		{[]string{"127.0.0.4", "127.0.0.10"}, true, "127.0.0.4,127.0.0.10", false},
		{[]string{"127.255.255.252"}, false, "", true},
		{[]string{"127.255.255.255"}, false, "", true},
		{[]string{"93.184.216.34"}, false, "", true},
		{[]string{}, false, "", false},
	}
	for _, c := range cases {
		entry := netProfileDNSBLEntry{List: "zen.spamhaus.org", Answers: c.answers}
		interpretDNSBLEntry(&entry)
		if entry.Listed != c.listed || entry.Code != c.code || (entry.Error != "") != c.err {
			t.Fatalf("answers %v → %#v", c.answers, entry)
		}
	}
	if reverseIPv4ForDNSBL("1.2.3.4") != "4.3.2.1" || reverseIPv4ForDNSBL("2001:db8::1") != "" {
		t.Fatalf("reverse ipv4 wrong")
	}
}

func TestNetProfileGlobalIPv6Detection(t *testing.T) {
	for value, want := range map[string]bool{
		"2001:db8::1": true,
		"fe80::1":     false,
		"fd00::1":     false,
		"::1":         false,
		"192.0.2.1":   false,
	} {
		if got := netProfileIsGlobalIPv6(net.ParseIP(value)); got != want {
			t.Fatalf("%s: got %v want %v", value, got, want)
		}
	}
}

func TestSummarizeSMTPBlockedWhenRefused(t *testing.T) {
	got := summarizeSMTP([]netProfileSMTPTarget{
		{Target: "a:25", Status: "timeout", Detail: "i/o timeout"},
		{Target: "b:25", Status: "refused", Detail: "connection refused"},
	})
	if got.Status != "blocked" || !strings.Contains(got.Detail, "b:25") {
		t.Fatalf("mixed timeout + refused should be blocked with the refused detail: %#v", got)
	}
}

func TestResolveProbeTargetForFamily(t *testing.T) {
	original := resolveProbeFamilyTargets
	t.Cleanup(func() { resolveProbeFamilyTargets = original })
	resolveProbeFamilyTargets = func(host string) []string {
		if host == "dual.example" {
			return []string{"192.0.2.10", "2001:db8::10"}
		}
		return []string{"192.0.2.20"}
	}
	if got, ok := resolveProbeTargetForFamily("dual.example", "ipv6"); !ok || got != "2001:db8::10" {
		t.Fatalf("ipv6 pick wrong: %s %v", got, ok)
	}
	if got, ok := resolveProbeTargetForFamily("dual.example", "ipv4"); !ok || got != "192.0.2.10" {
		t.Fatalf("ipv4 pick wrong: %s %v", got, ok)
	}
	if _, ok := resolveProbeTargetForFamily("v4only.example", "ipv6"); ok {
		t.Fatalf("missing family must fail instead of falling back")
	}
	if got, ok := resolveProbeTargetForFamily("v4only.example", "auto"); !ok || got != "v4only.example" {
		t.Fatalf("auto keeps the target untouched: %s", got)
	}
	if got, ok := resolveProbeTargetForFamily("192.0.2.30", "ipv6"); !ok || got != "192.0.2.30" {
		t.Fatalf("ip literal is left alone: %s", got)
	}
}

func TestServiceProbeFamilyMissingReportsTimeoutWithOriginalTarget(t *testing.T) {
	original := resolveProbeFamilyTargets
	t.Cleanup(func() { resolveProbeFamilyTargets = original })
	resolveProbeFamilyTargets = func(host string) []string { return []string{"192.0.2.20"} }
	task := tcpingTask{Kind: "service", ServiceID: 7, Method: "tcping", TargetIP: "v4only.example", TargetPort: 443, Family: "ipv6"}
	result := executeTCPingTaskWithProbes(task, nil, nil)
	if result.Payload["isTimeout"] != true || result.Payload["targetIp"] != "v4only.example" || result.Payload["serviceId"] != 7 {
		t.Fatalf("family miss should be a timeout reported against the original target: %#v", result.Payload)
	}
	var pinged string
	task = tcpingTask{Kind: "service", ServiceID: 8, Method: "ping", TargetIP: "dual.example", Family: "ipv4"}
	resolveProbeFamilyTargets = func(host string) []string { return []string{"2001:db8::1", "192.0.2.9"} }
	result = executeTCPingTaskWithProbes(task, nil, func(target string, timeout time.Duration, count int) probeMeasurement {
		pinged = target
		return probeMeasurement{ProbeCount: count, ProbeSuccesses: count, Reachable: true, LatencyMs: 5}
	})
	if pinged != "192.0.2.9" || result.Payload["targetIp"] != "dual.example" || result.Payload["isTimeout"] != false {
		t.Fatalf("ping should use the ipv4 address but report the hostname: pinged=%s %#v", pinged, result.Payload)
	}
}

func TestHostProbeServiceFamilyDecodes(t *testing.T) {
	var probe hostProbeServiceProbe
	if err := json.Unmarshal([]byte(`{"serviceId":1,"targetIp":"a.example","targetPort":443,"method":"tcping","family":"ipv6"}`), &probe); err != nil {
		t.Fatal(err)
	}
	if normalizeProbeFamily(probe.Family) != "ipv6" || normalizeProbeFamily("auto") != "" || normalizeProbeFamily("") != "" {
		t.Fatalf("family decode wrong: %#v", probe)
	}
}
