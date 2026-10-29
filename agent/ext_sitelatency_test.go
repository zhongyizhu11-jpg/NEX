package main

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"
)

type siteLatencyFakeConn struct{ net.Conn }

func (siteLatencyFakeConn) Close() error { return nil }

func newTestSiteLatencyModule(clock *time.Time) *siteLatencyExtModule {
	m := newSiteLatencyExtModule()
	m.async = false
	m.now = func() time.Time { return *clock }
	m.resolve = func(ctx context.Context, host string) (string, error) {
		if host == "nx.example" {
			return "", &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
		}
		return "192.0.2.1", nil
	}
	m.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if strings.HasSuffix(addr, ":81") {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
		}
		return siteLatencyFakeConn{}, nil
	}
	return m
}

func siteLatencyDirectiveJSON(t *testing.T, since int64) json.RawMessage {
	raw, err := json.Marshal(siteLatencyDirective{IntervalSeconds: 120, Since: since, Targets: []siteLatencyTarget{
		{Key: "ok", Host: "ok.example", Port: 443},
		{Key: "dns", Host: "nx.example", Port: 443},
		{Key: "refused", Host: "ok.example", Port: 81},
		{Key: "ok", Host: "dup.example", Port: 443},
		{Key: "bad", Host: "", Port: 443},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func siteLatencyReport(t *testing.T, m *siteLatencyExtModule) map[string][]siteLatencySample {
	t.Helper()
	report := m.Report(Config{})
	out := map[string][]siteLatencySample{}
	if report == nil {
		return out
	}
	for _, target := range report.(map[string]any)["targets"].([]siteLatencyReportTarget) {
		out[target.Key] = target.Samples
	}
	return out
}

// 一轮：解析失败记 dns、拒绝记 refused、连上记耗时；重复和空的站点不要。
func TestSiteLatencyMeasuresAndClassifies(t *testing.T) {
	clock := time.UnixMilli(1_800_000_000_000)
	m := newTestSiteLatencyModule(&clock)
	m.Apply(Config{}, siteLatencyDirectiveJSON(t, 0))
	got := siteLatencyReport(t, m)
	if len(got) != 3 {
		t.Fatalf("应当只有 3 个站点：%+v", got)
	}
	if s := got["ok"]; len(s) != 1 || s[0].Ms < 1 || s[0].F != "" || s[0].T != clock.UnixMilli() {
		t.Fatalf("连上的样本不对：%+v", s)
	}
	if s := got["dns"]; len(s) != 1 || s[0].Ms != -1 || s[0].F != "dns" {
		t.Fatalf("解析失败的样本不对：%+v", s)
	}
	if s := got["refused"]; len(s) != 1 || s[0].F != "refused" {
		t.Fatalf("被拒绝的样本不对：%+v", s)
	}
}

// 没到间隔不测；面板说已经有到哪就只报更新的；样本封顶。
func TestSiteLatencyIntervalSinceAndCap(t *testing.T) {
	clock := time.UnixMilli(1_800_000_000_000)
	m := newTestSiteLatencyModule(&clock)
	first := clock.UnixMilli()
	m.Apply(Config{}, siteLatencyDirectiveJSON(t, 0))
	clock = clock.Add(30 * time.Second)
	m.Apply(Config{}, siteLatencyDirectiveJSON(t, first))
	if got := siteLatencyReport(t, m); len(got) != 0 {
		t.Fatalf("面板已经有了、也没到间隔，不该再报：%+v", got)
	}
	for i := 0; i < siteLatencyKeep+5; i++ {
		clock = clock.Add(2 * time.Minute)
		m.Apply(Config{}, siteLatencyDirectiveJSON(t, first))
	}
	got := siteLatencyReport(t, m)
	if len(got["ok"]) != siteLatencyKeep {
		t.Fatalf("样本应当封顶 %d 个：%d", siteLatencyKeep, len(got["ok"]))
	}
	// 面板重启：since=0，整段都交。
	m.Apply(Config{}, siteLatencyDirectiveJSON(t, 0))
	if len(siteLatencyReport(t, m)["ok"]) != siteLatencyKeep {
		t.Fatal("since=0 应当整段补齐")
	}
}

// 站点表换了：旧站点的样本丢掉；没有指令（老面板）就不测。
func TestSiteLatencyTargetsChangeAndIdle(t *testing.T) {
	clock := time.UnixMilli(1_800_000_000_000)
	m := newTestSiteLatencyModule(&clock)
	if m.Report(Config{}) != nil {
		t.Fatal("没收到指令不该有东西报")
	}
	m.Apply(Config{}, siteLatencyDirectiveJSON(t, 0))
	raw, _ := json.Marshal(siteLatencyDirective{Targets: []siteLatencyTarget{{Key: "ok", Host: "ok.example", Port: 443}}})
	m.Apply(Config{}, raw)
	got := siteLatencyReport(t, m)
	if len(got) != 1 || len(got["ok"]) != 1 {
		t.Fatalf("换表后只该剩 ok：%+v", got)
	}
}

func TestSiteLatencyResolveLiteralIP(t *testing.T) {
	ip, err := siteLatencyResolve(context.Background(), "[2001:db8::1]")
	if err != nil || ip != "2001:db8::1" {
		t.Fatalf("字面 IPv6 应当原样用：%q %v", ip, err)
	}
	if _, err := siteLatencyResolve(context.Background(), "203.0.113.9"); err != nil {
		t.Fatal(err)
	}
}
