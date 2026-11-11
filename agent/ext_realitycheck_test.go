package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

// 本机起一个带 h2 的 TLS 服务（httptest 的证书是给 example.com 签的），把「解析到的公网地址」拨回它。
func realityCheckTestModule(t *testing.T) (*realityCheckExtModule, func()) {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	server.EnableHTTP2 = true
	server.StartTLS()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	local := server.Listener.Addr().String()
	m := newRealityCheckExtModule()
	m.roots = roots
	m.wake = nil
	m.lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
		switch host {
		case "example.com":
			return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
		case "intranet.example":
			return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("10.0.0.8")}, nil
		}
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	dialer := &net.Dialer{}
	m.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, local)
	}
	return m, server.Close
}

func TestRealityCheckFeasibleTarget(t *testing.T) {
	m, stop := realityCheckTestModule(t)
	defer stop()
	result := m.checkTarget(context.Background(), realityCheckTarget{Dest: "example.com:443", ServerName: "example.com"})
	if !result.Reachable || !result.TLS13 || !result.X25519 || !result.H2 || !result.CertValid || !result.Feasible {
		t.Fatalf("expected feasible target, got %+v", result)
	}
	if result.ResolvedIP != "93.184.216.34" {
		t.Fatalf("expected resolved ip to be reported, got %q", result.ResolvedIP)
	}
}

func TestRealityCheckWrongServerNameFailsCertificate(t *testing.T) {
	m, stop := realityCheckTestModule(t)
	defer stop()
	result := m.checkTarget(context.Background(), realityCheckTarget{Dest: "example.com:443", ServerName: "www.other-site.com"})
	if !result.Reachable || result.CertValid || result.Feasible {
		t.Fatalf("certificate for another name must not be valid, got %+v", result)
	}
}

func TestRealityCheckBlocksPrivateAndInvalidTargets(t *testing.T) {
	m, stop := realityCheckTestModule(t)
	defer stop()
	cases := map[string]realityCheckTarget{
		"blocked":  {Dest: "intranet.example:443", ServerName: "intranet.example"},
		"invalid":  {Dest: "not a host", ServerName: ""},
		"resolve":  {Dest: "missing.example:443", ServerName: "missing.example"},
		"loopback": {Dest: "127.0.0.1:443", ServerName: "example.com"},
	}
	expected := map[string]string{"blocked": "blocked", "invalid": "invalid", "resolve": "resolve", "loopback": "blocked"}
	for name, target := range cases {
		result := m.checkTarget(context.Background(), target)
		if result.Feasible || result.Error != expected[name] {
			t.Fatalf("%s: expected error %q, got %+v", name, expected[name], result)
		}
	}
}

func TestRealityCheckModuleRunsDirectiveOnceAndReports(t *testing.T) {
	m, stop := realityCheckTestModule(t)
	defer stop()
	directive, _ := json.Marshal(realityCheckDirective{Runs: []realityCheckRunDirective{{
		RunID:   "rc-test-1",
		Targets: []realityCheckTarget{{Dest: "example.com:443", ServerName: "example.com"}},
	}}})
	m.Apply(Config{}, directive)
	m.Apply(Config{}, directive) // 重发的指令不会再跑一次
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		report, _ := m.Report(Config{}).(realityCheckReport)
		if len(report.Runs) == 1 && report.Runs[0].Status == "done" {
			if len(report.Runs[0].Results) != 1 || !report.Runs[0].Results[0].Feasible {
				t.Fatalf("unexpected results %+v", report.Runs[0].Results)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("reality check run did not finish")
}
