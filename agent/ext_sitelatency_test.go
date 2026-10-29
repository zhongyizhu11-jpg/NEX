package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"math/big"
	"net"
	"strings"
	"sync/atomic"
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
	m.verify = func(ctx context.Context, conn net.Conn, host string) string {
		switch host {
		case "poison.example":
			return "poisoned"
		case "blocked.example":
			return "blocked"
		}
		return ""
	}
	m.sleep = func(time.Duration) {}
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
	if s := got["ok"]; len(s) != 1 || s[0].Ms < 1 || s[0].F != "" || s[0].T != clock.UnixMilli() || s[0].N != siteLatencyAttempts || s[0].K != siteLatencyAttempts {
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

// 一轮握三次：没连上的次数算进 n-k，耗时取连上那几次的中位数。
func TestSiteLatencyRepeatsHandshakesAndTakesMedian(t *testing.T) {
	clock := time.UnixMilli(1_800_000_000_000)
	m := newTestSiteLatencyModule(&clock)
	var calls atomic.Int32
	m.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if calls.Add(1) == 2 {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ETIMEDOUT, Source: nil}
		}
		return siteLatencyFakeConn{}, nil
	}
	sample := m.measureOne(siteLatencyTarget{Key: "ok", Host: "ok.example", Port: 443}, 1)
	if sample.N != 3 || sample.K != 2 || sample.Ms < 1 || sample.F != "" {
		t.Fatalf("三次里两次连上：%+v", sample)
	}
	if got := siteLatencyMedian([]int{40, 9, 12}); got != 12 {
		t.Fatalf("中位数：%d", got)
	}
	if got := siteLatencyMedian([]int{10, 13}); got != 12 {
		t.Fatalf("偶数个取中间两个的平均：%d", got)
	}
}

// 证书对不上（DNS 被污染）/ TLS 被掐：整轮算没连上，不留那个几毫秒的假耗时。
func TestSiteLatencyTLSFailureFailsTheRound(t *testing.T) {
	clock := time.UnixMilli(1_800_000_000_000)
	m := newTestSiteLatencyModule(&clock)
	for host, want := range map[string]string{"poison.example": "poisoned", "blocked.example": "blocked"} {
		sample := m.measureOne(siteLatencyTarget{Key: "x", Host: host, Port: 443}, 1)
		if sample.Ms != -1 || sample.F != want || sample.K != 0 {
			t.Fatalf("%s：%+v", host, sample)
		}
	}
	// 不是 443、或者明说不要 TLS：只握 TCP。
	off := false
	for _, target := range []siteLatencyTarget{{Key: "x", Host: "poison.example", Port: 80}, {Key: "x", Host: "poison.example", Port: 443, TLS: &off}} {
		if sample := m.measureOne(target, 1); sample.Ms < 1 {
			t.Fatalf("不做 TLS 时应当连上：%+v", sample)
		}
	}
}

func siteLatencyTestCert(t *testing.T, names ...string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: names[0]},
		DNSNames:     names,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// 起一个本地服务，handle 决定它怎么对待来连的客户端；返回地址。
func siteLatencyTestServer(t *testing.T, handle func(net.Conn)) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go handle(conn)
		}
	}()
	return listener.Addr().String()
}

// 真的走一遍 TLS：证书是这个域名的才算；别的域名、明文服务算污染；连上就被关算阻断。
func TestSiteLatencyVerifyTLSAgainstRealHandshakes(t *testing.T) {
	cert := siteLatencyTestCert(t, "site.example")
	tlsAddr := siteLatencyTestServer(t, func(conn net.Conn) {
		server := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}})
		_ = server.Handshake()
		time.Sleep(50 * time.Millisecond)
		_ = server.Close()
	})
	plainAddr := siteLatencyTestServer(t, func(conn net.Conn) {
		_, _ = conn.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n"))
		time.Sleep(50 * time.Millisecond)
		_ = conn.Close()
	})
	resetAddr := siteLatencyTestServer(t, func(conn net.Conn) {
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetLinger(0) // 关的时候发 RST
		}
		buf := make([]byte, 16)
		_, _ = conn.Read(buf) // 收到 ClientHello 再掐
		_ = conn.Close()
	})
	silentAddr := siteLatencyTestServer(t, func(conn net.Conn) {
		time.Sleep(2 * time.Second)
		_ = conn.Close()
	})
	check := func(addr, host string, timeout time.Duration) string {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		return siteLatencyVerifyTLS(ctx, conn, host)
	}
	if got := check(tlsAddr, "site.example", 3*time.Second); got != "" {
		t.Fatalf("证书就是这个域名的，应当通过：%q", got)
	}
	if got := check(tlsAddr, "www.google.com", 3*time.Second); got != "poisoned" {
		t.Fatalf("证书是别的域名的，应当是 poisoned：%q", got)
	}
	if got := check(plainAddr, "site.example", 3*time.Second); got != "poisoned" {
		t.Fatalf("对面不是 TLS，应当是 poisoned：%q", got)
	}
	if got := check(resetAddr, "site.example", 3*time.Second); got != "blocked" {
		t.Fatalf("握手被重置，应当是 blocked：%q", got)
	}
	if got := check(silentAddr, "site.example", 300*time.Millisecond); got != "blocked" {
		t.Fatalf("握手没回应，应当是 blocked：%q", got)
	}
}
