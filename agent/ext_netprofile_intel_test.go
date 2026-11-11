package main

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
)

// IP 信息（2.2.253 起）：只查测通的协议族、{ip} 换成出口地址、白名单外的域名不请求、状态码原样交回。
func TestNetProfileIntelFetchesPerFamilyWithAllowlist(t *testing.T) {
	m := newTestNetProfileModule()
	m.httpGet = func(ctx context.Context, network, url string) (string, error) {
		if network == "tcp4" {
			return "203.0.113.7\n", nil
		}
		return "", errors.New("dial tcp6: connect: network is unreachable")
	}
	m.dial = func(ctx context.Context, network, addr string) (net.Conn, error) { return nil, fakeTimeoutErr{} }
	m.lookupHost = func(ctx context.Context, name string) ([]string, error) {
		return nil, &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
	}
	var mu sync.Mutex
	var requested []string
	m.intelGet = func(ctx context.Context, network, url string) (int, string, error) {
		mu.Lock()
		requested = append(requested, network+" "+url)
		mu.Unlock()
		switch {
		case strings.Contains(url, "proxycheck.io"):
			return 429, `{"status":"denied","message":"limit"}`, nil
		case strings.Contains(url, "ipinfo.io"):
			return 0, "", errors.New("dial tcp4: i/o timeout")
		}
		return 200, `{"ip":"203.0.113.7","location":{"country_code":"JP"}}`, nil
	}
	m.Apply(Config{}, []byte(`{"intervalSeconds":21600,"runId":"np-1","intel":[
		{"id":"ipapi_is","url":"https://api.ipapi.is/"},
		{"id":"ipinfo","url":"https://ipinfo.io/json"},
		{"id":"proxycheck","url":"https://proxycheck.io/v2/{ip}?vpn=1&asn=1&risk=1"},
		{"id":"evil","url":"https://evil.example.com/{ip}"},
		{"id":"plain","url":"http://api.ipapi.is/"}
	]}`))
	report, _ := m.Report(Config{}).(map[string]any)
	result, _ := report["result"].(*netProfileResult)
	if result == nil {
		t.Fatalf("expected a result, got %#v", report)
	}
	if len(result.Intel) != 5 {
		t.Fatalf("only the working IPv4 family should be queried, got %d entries: %+v", len(result.Intel), result.Intel)
	}
	byID := map[string]netProfileIntelEntry{}
	for _, entry := range result.Intel {
		if entry.Family != 4 || entry.Address != "203.0.113.7" {
			t.Fatalf("unexpected family/address: %+v", entry)
		}
		byID[entry.Source] = entry
	}
	if byID["ipapi_is"].Status != 200 || !strings.Contains(byID["ipapi_is"].Body, "JP") {
		t.Fatalf("ipapi.is body should be passed through: %+v", byID["ipapi_is"])
	}
	if byID["proxycheck"].Status != 429 {
		t.Fatalf("status code must be reported as-is: %+v", byID["proxycheck"])
	}
	if byID["ipinfo"].Error == "" {
		t.Fatalf("network errors become an error string: %+v", byID["ipinfo"])
	}
	if byID["evil"].Error == "" || byID["plain"].Error == "" {
		t.Fatalf("non-allowlisted / non-https sources must not be requested: %+v %+v", byID["evil"], byID["plain"])
	}
	for _, line := range requested {
		if !strings.HasPrefix(line, "tcp4 ") {
			t.Fatalf("intel must be forced onto the family under test: %s", line)
		}
		if strings.Contains(line, "evil.example.com") || strings.HasPrefix(line, "tcp4 http://") {
			t.Fatalf("requested a forbidden url: %s", line)
		}
	}
	found := false
	for _, line := range requested {
		if line == "tcp4 https://proxycheck.io/v2/203.0.113.7?vpn=1&asn=1&risk=1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("{ip} placeholder should be replaced, requested=%v", requested)
	}
}

func TestNetProfileIntelURL(t *testing.T) {
	cases := map[string]string{
		"https://api.ipapi.is/":                "https://api.ipapi.is/",
		"https://proxycheck.io/v2/{ip}?risk=1": "https://proxycheck.io/v2/2001:db8::1?risk=1",
		"https://ipinfo.io:8443/json":          "",
		"https://user@ipinfo.io/json":          "",
		"https://ipinfo.io.evil.example.com/":  "",
		"ftp://ipinfo.io/json":                 "",
		"":                                     "",
	}
	for raw, want := range cases {
		if got := netProfileIntelURL(raw, "2001:db8::1"); got != want {
			t.Fatalf("netProfileIntelURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

// 没有 intel 列表（面板觉得缓存还新、或者旧面板）就不请求任何数据源。
func TestNetProfileIntelSkippedWithoutDirective(t *testing.T) {
	m := newTestNetProfileModule()
	m.httpGet = func(ctx context.Context, network, url string) (string, error) { return "203.0.113.7", nil }
	m.dial = func(ctx context.Context, network, addr string) (net.Conn, error) { return nil, fakeTimeoutErr{} }
	m.lookupHost = func(ctx context.Context, name string) ([]string, error) {
		return nil, &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
	}
	m.intelGet = func(ctx context.Context, network, url string) (int, string, error) {
		t.Fatalf("intel should not be fetched: %s", url)
		return 0, "", nil
	}
	m.Apply(Config{}, []byte(`{"intervalSeconds":21600,"runId":"np-2"}`))
	report, _ := m.Report(Config{}).(map[string]any)
	if result, _ := report["result"].(*netProfileResult); result == nil || len(result.Intel) != 0 {
		t.Fatalf("expected a result without intel, got %#v", report)
	}
}
