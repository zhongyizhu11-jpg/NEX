package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeSites 起一个 TLS 测试服务，所有域名都拨到它；按 "域名/路径" 找处理函数，找不到就 404。
func fakeSites(t *testing.T, routes map[string]http.HandlerFunc) *unlockProbe {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if handler, ok := routes[host+r.URL.Path]; ok {
			handler(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	t.Cleanup(server.Close)
	addr := server.Listener.Addr().String()
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", addr)
	}
	probe := newUnlockProbe("auto", dial, &tls.Config{InsecureSkipVerify: true}) // 只在测试里
	t.Cleanup(probe.close)
	return probe
}

func page(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func redirect(to string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, to, http.StatusFound) }
}

func challenge() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Mitigated", "challenge")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("<title>Just a moment...</title>"))
	}
}

func trace(loc string) http.HandlerFunc {
	return page(200, "fl=1\nh=x\nip=203.0.113.1\nloc="+loc+"\ntls=TLSv1.3\n")
}

func expect(t *testing.T, got unlockResult, status, region string) {
	t.Helper()
	if got.Status != status || got.Region != region {
		t.Fatalf("got status=%s region=%q detail=%q, want status=%s region=%q", got.Status, got.Region, got.Detail, status, region)
	}
	if got.Detail == "" {
		t.Fatalf("detail should not be empty: %+v", got)
	}
}

const nfOK = `<html>{"requestCountry":{"id":"JP","countryName":"Japan"}}<h1>LEGO Ninjago</h1></html>`
const nfOhNo = `<html><h1>Oh no! This title isn't available to watch in your location.</h1></html>`

func TestUnlockNetflix(t *testing.T) {
	ctx := context.Background()
	t.Run("full unlock with region from redirect", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.netflix.com/title/81280792":    redirect("/hk/title/81280792"),
			"www.netflix.com/hk/title/81280792": page(200, "<html>ok</html>"),
			"www.netflix.com/title/70143836":    page(200, nfOhNo),
			"www.netflix.com/title/80018499":    page(200, "<html>ok</html>"),
		})
		expect(t, unlockCheckNetflix(ctx, p), unlockStatusOK, "HK")
	})
	t.Run("full unlock with region from body", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.netflix.com/title/81280792": page(200, nfOK),
			"www.netflix.com/title/70143836": page(200, nfOK),
			"www.netflix.com/title/80018499": page(200, nfOK),
		})
		expect(t, unlockCheckNetflix(ctx, p), unlockStatusOK, "JP")
	})
	t.Run("originals only", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.netflix.com/title/81280792": page(200, nfOhNo),
			"www.netflix.com/title/70143836": page(200, nfOhNo),
			"www.netflix.com/title/80018499": page(200, `{"id":"SG","countryName":"Singapore"}`),
		})
		expect(t, unlockCheckNetflix(ctx, p), unlockStatusPartial, "SG")
	})
	t.Run("blocked", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.netflix.com/title/81280792": page(403, "denied"),
			"www.netflix.com/title/70143836": page(403, "denied"),
			"www.netflix.com/title/80018499": page(403, "denied"),
		})
		got := unlockCheckNetflix(ctx, p)
		expect(t, got, unlockStatusBlocked, "")
		if !strings.Contains(got.Detail, "IP") {
			t.Fatalf("403 detail should mention IP: %q", got.Detail)
		}
	})
	t.Run("unknown page", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.netflix.com/title/81280792": page(500, "oops"),
			"www.netflix.com/title/70143836": page(500, "oops"),
			"www.netflix.com/title/80018499": page(500, "oops"),
		})
		expect(t, unlockCheckNetflix(ctx, p), unlockStatusUnknown, "")
	})
}

func TestUnlockNetworkFailureIsUnknown(t *testing.T) {
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		return nil, errors.New("dial tcp6: connect: network is unreachable")
	}
	p := newUnlockProbe("ipv6", dial, nil)
	defer p.close()
	for _, svc := range unlockServices {
		got := svc.Check(context.Background(), p)
		if got.Status != unlockStatusUnknown {
			t.Fatalf("%s: network failure should be unknown, got %+v", svc.ID, got)
		}
		if got.Detail == "" {
			t.Fatalf("%s: detail should explain the failure", svc.ID)
		}
	}
}

func TestUnlockDisney(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name           string
		routes         map[string]http.HandlerFunc
		status, region string
	}{
		{"ok with locale", map[string]http.HandlerFunc{
			"www.disneyplus.com/":      redirect("/en-gb"),
			"www.disneyplus.com/en-gb": page(200, "<html>Disney+</html>"),
		}, unlockStatusOK, "GB"},
		{"ok with countryCode", map[string]http.HandlerFunc{
			"www.disneyplus.com/": page(200, `{"countryCode":"US"}`),
		}, unlockStatusOK, "US"},
		{"unavailable", map[string]http.HandlerFunc{
			"www.disneyplus.com/":            redirect("/unavailable"),
			"www.disneyplus.com/unavailable": page(200, "not here"),
		}, unlockStatusBlocked, ""},
		{"preview", map[string]http.HandlerFunc{
			"www.disneyplus.com/":              redirect("/en-th/preview"),
			"www.disneyplus.com/en-th/preview": page(200, "soon"),
		}, unlockStatusBlocked, "TH"},
		{"forbidden", map[string]http.HandlerFunc{"www.disneyplus.com/": page(403, "403 ERROR")}, unlockStatusBlocked, ""},
		{"unknown", map[string]http.HandlerFunc{"www.disneyplus.com/": page(502, "bad gateway")}, unlockStatusUnknown, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { expect(t, unlockCheckDisney(ctx, fakeSites(t, c.routes)), c.status, c.region) })
	}
}

func TestUnlockYouTubePremium(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name           string
		body           string
		status, region string
	}{
		{"ok", `"INNERTUBE_CONTEXT_GL":"US" ... YouTube and YouTube Music ad-free`, unlockStatusOK, "US"},
		{"ok contentRegion", `"contentRegion":"JP" ad-free`, unlockStatusOK, "JP"},
		{"not available", `"INNERTUBE_CONTEXT_GL":"RU" Premium is not available in your country`, unlockStatusBlocked, "RU"},
		{"china", `<a href="https://www.google.cn/">`, unlockStatusBlocked, "CN"},
		{"unknown", `<html>consent</html>`, unlockStatusUnknown, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := fakeSites(t, map[string]http.HandlerFunc{"www.youtube.com/premium": page(200, c.body)})
			expect(t, unlockCheckYouTubePremium(ctx, p), c.status, c.region)
		})
	}
}

func TestUnlockChatGPT(t *testing.T) {
	ctx := context.Background()
	routes := func(api, ios http.HandlerFunc, favStatus int) map[string]http.HandlerFunc {
		return map[string]http.HandlerFunc{
			"api.openai.com/compliance/cookie_requirements": api,
			"ios.chat.openai.com/":                          ios,
			"chatgpt.com/cdn-cgi/trace":                     trace("SG"),
			"chatgpt.com/favicon.ico":                       page(favStatus, "ico"),
		}
	}
	apiOK := page(200, `{"requires_cookie_consent":false}`)
	apiBlocked := page(403, `{"error":{"code":"unsupported_country"}}`)
	iosOK := page(200, `{"cf_details":"Request is not allowed. Please try again later."}`)
	iosVPN := page(403, `{"cf_details":"It seems like you are using a VPN"}`)
	cases := []struct {
		name   string
		routes map[string]http.HandlerFunc
		status string
	}{
		{"ok", routes(apiOK, iosOK, 200), unlockStatusOK},
		{"web only", routes(apiOK, iosVPN, 200), unlockStatusPartial},
		{"app only", routes(apiBlocked, iosOK, 200), unlockStatusPartial},
		{"blocked both", routes(apiBlocked, iosVPN, 200), unlockStatusBlocked},
		{"blocked favicon", routes(apiBlocked, iosOK, 403), unlockStatusBlocked},
		{"challenge", routes(apiOK, challenge(), 200), unlockStatusUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { expect(t, unlockCheckChatGPT(ctx, fakeSites(t, c.routes)), c.status, "SG") })
	}
}

func TestUnlockClaude(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name   string
		routes map[string]http.HandlerFunc
		status string
	}{
		{"ok", map[string]http.HandlerFunc{"claude.ai/": redirect("/login"), "claude.ai/login": page(200, "Claude")}, unlockStatusOK},
		{"blocked", map[string]http.HandlerFunc{
			"claude.ai/": redirect("https://www.anthropic.com/app-unavailable-in-region"),
			"www.anthropic.com/app-unavailable-in-region": page(200, "unavailable"),
		}, unlockStatusBlocked},
		{"challenge", map[string]http.HandlerFunc{"claude.ai/": challenge()}, unlockStatusUnknown},
		{"server error", map[string]http.HandlerFunc{"claude.ai/": page(500, "x")}, unlockStatusUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.routes["claude.ai/cdn-cgi/trace"] = trace("US")
			expect(t, unlockCheckClaude(ctx, fakeSites(t, c.routes)), c.status, "US")
		})
	}
}

func TestUnlockGemini(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name           string
		handler        http.HandlerFunc
		status, region string
	}{
		{"ok", page(200, `[["wrb.fr",null,"[45631641,null,true]"]] ... ,2,1,200,"USA"]`), unlockStatusOK, "USA"},
		{"ok escaped json", page(200, `{\"45631641\":true,\"45841483\":false} ,2,1,200,"JPN"`), unlockStatusOK, "JPN"},
		{"blocked", page(200, `[45631641,null,false] ,2,1,200,"HKG"`), unlockStatusBlocked, "HKG"},
		{"blocked escaped json", page(200, `{\"45631641\":false} ,2,1,200,"RUS"`), unlockStatusBlocked, "RUS"},
		{"marker missing", page(200, `<html>new layout</html>`), unlockStatusUnknown, ""},
		{"unknown", page(503, `busy`), unlockStatusUnknown, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := fakeSites(t, map[string]http.HandlerFunc{"gemini.google.com/": c.handler})
			expect(t, unlockCheckGemini(ctx, p), c.status, c.region)
		})
	}
}

func TestUnlockGrokAndPerplexity(t *testing.T) {
	ctx := context.Background()
	type check func(context.Context, *unlockProbe) unlockResult
	sites := []struct {
		host  string
		check check
	}{{"grok.com", unlockCheckGrok}, {"www.perplexity.ai", unlockCheckPerplexity}}
	for _, site := range sites {
		cases := []struct {
			name    string
			handler http.HandlerFunc
			status  string
		}{
			{"ok", page(200, "<html>Ask anything</html>"), unlockStatusOK},
			{"blocked marker", page(403, "Sorry, this service is not available in your region."), unlockStatusBlocked},
			{"blocked 451", page(451, "legal"), unlockStatusBlocked},
			{"challenge", challenge(), unlockStatusUnknown},
			{"server error", page(500, "x"), unlockStatusUnknown},
		}
		for _, c := range cases {
			t.Run(site.host+" "+c.name, func(t *testing.T) {
				p := fakeSites(t, map[string]http.HandlerFunc{site.host + "/": c.handler, site.host + "/cdn-cgi/trace": trace("DE")})
				expect(t, site.check(ctx, p), c.status, "DE")
			})
		}
	}
}

func TestUnlockTikTok(t *testing.T) {
	ctx := context.Background()
	t.Run("ok", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{"www.tiktok.com/": page(200, `{"region":"JP","lang":"ja"}`)})
		expect(t, unlockCheckTikTok(ctx, p), unlockStatusOK, "JP")
	})
	t.Run("retry explore", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.tiktok.com/":        page(200, `Please wait...`),
			"www.tiktok.com/explore": page(200, `"region":"TW"`),
		})
		expect(t, unlockCheckTikTok(ctx, p), unlockStatusOK, "TW")
	})
	t.Run("blocked", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{"www.tiktok.com/": page(451, "")})
		expect(t, unlockCheckTikTok(ctx, p), unlockStatusBlocked, "")
	})
	t.Run("unknown", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{"www.tiktok.com/": page(200, `<html></html>`)})
		expect(t, unlockCheckTikTok(ctx, p), unlockStatusUnknown, "")
	})
}

func TestUnlockRedirectLimit(t *testing.T) {
	var hits int32
	routes := map[string]http.HandlerFunc{}
	for i := 0; i < 10; i++ {
		next := "/r" + string(rune('0'+i+1))
		routes["loop.test/r"+string(rune('0'+i))] = func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&hits, 1)
			http.Redirect(w, r, next, http.StatusFound)
		}
	}
	p := fakeSites(t, routes)
	r, err := p.get(context.Background(), "https://loop.test/r0", nil)
	if err != nil {
		t.Fatalf("redirect limit should return last response, got %v", err)
	}
	if r.Status != http.StatusFound || atomic.LoadInt32(&hits) != unlockMaxRedirects+1 {
		t.Fatalf("status=%d hits=%d, want 302 after %d requests", r.Status, hits, unlockMaxRedirects+1)
	}
}

func TestRunUnlockChecksRecoversAndCapsConcurrency(t *testing.T) {
	var running, peak int32
	slow := func(ctx context.Context, p *unlockProbe) unlockResult {
		n := atomic.AddInt32(&running, 1)
		for {
			old := atomic.LoadInt32(&peak)
			if n <= old || atomic.CompareAndSwapInt32(&peak, old, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt32(&running, -1)
		return unlockResult{Status: unlockStatusOK, Region: "us", Detail: "ok"}
	}
	services := []unlockService{
		{ID: "a", Check: slow}, {ID: "b", Check: slow}, {ID: "c", Check: slow}, {ID: "d", Check: slow},
		{ID: "e", Check: slow}, {ID: "f", Check: slow},
		{ID: "boom", Check: func(ctx context.Context, p *unlockProbe) unlockResult { panic("x") }},
		{ID: "weird", Check: func(ctx context.Context, p *unlockProbe) unlockResult {
			return unlockResult{Status: "maybe", Region: "not-a-region", Detail: strings.Repeat("长", 500)}
		}},
	}
	results := runUnlockChecks(context.Background(), &unlockProbe{client: http.DefaultClient}, services)
	if len(results) != len(services) {
		t.Fatalf("got %d results", len(results))
	}
	for i, r := range results {
		if r.Service != services[i].ID {
			t.Fatalf("result %d is %s, want %s", i, r.Service, services[i].ID)
		}
	}
	if results[0].Region != "US" {
		t.Fatalf("region should be upper-cased, got %q", results[0].Region)
	}
	if results[6].Status != unlockStatusUnknown {
		t.Fatalf("panic should become unknown: %+v", results[6])
	}
	if results[7].Status != unlockStatusUnknown || results[7].Region != "" || len([]rune(results[7].Detail)) != 120 {
		t.Fatalf("bad result should be normalised: %+v", results[7])
	}
	if p := atomic.LoadInt32(&peak); p > unlockConcurrency {
		t.Fatalf("peak concurrency %d exceeds cap %d", p, unlockConcurrency)
	}
}

func TestUnlockServiceTableIDsAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, svc := range unlockServices {
		if svc.ID == "" || seen[svc.ID] || svc.Check == nil {
			t.Fatalf("bad service entry %q", svc.ID)
		}
		seen[svc.ID] = true
	}
}

func TestUnlockExtModuleRunsOncePerRunID(t *testing.T) {
	m := newUnlockExtModule()
	var calls int32
	done := make(chan string, 4)
	m.run = func(ctx context.Context, family string) []unlockResult {
		atomic.AddInt32(&calls, 1)
		done <- family
		return []unlockResult{{Service: "netflix", Status: unlockStatusOK, Detail: "ok"}}
	}
	if m.Report(Config{}) != nil {
		t.Fatal("nothing to report before any run")
	}
	directive, _ := json.Marshal(unlockDirective{Runs: []unlockRunDirective{
		{RunID: "ul-1", Family: "ipv6"},
		{RunID: "ul-1", Family: "ipv6"},
		{RunID: "bad id!", Family: "auto"},
		{RunID: "ul-2", Family: "ipx"},
	}})
	m.Apply(Config{}, directive)
	m.Apply(Config{}, directive)
	select {
	case family := <-done:
		if family != "ipv6" {
			t.Fatalf("family = %s", family)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run did not start")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		report, _ := m.Report(Config{}).(unlockReport)
		if len(report.Runs) == 1 && report.Runs[0].Status == "done" {
			if report.Runs[0].RunID != "ul-1" || len(report.Runs[0].Results) != 1 || report.Runs[0].FinishedAt == 0 {
				t.Fatalf("unexpected report %+v", report)
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
}
