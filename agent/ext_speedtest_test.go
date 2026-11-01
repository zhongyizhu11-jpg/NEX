package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// swallowConn 模拟经 sing-box、几跳转发：写进来的字节先被一个很大的缓冲一口吞下（Write 立刻返回），
// 后台再按对端收的速度慢慢送过去。2.2.245 以前上传在这一步就算「送出去了」，曲线冲到几百上千 Mbps。
type swallowConn struct {
	net.Conn
	queue chan []byte
	done  chan struct{}
	once  sync.Once
}

func newSwallowConn(conn net.Conn) *swallowConn {
	c := &swallowConn{Conn: conn, queue: make(chan []byte, 1<<16), done: make(chan struct{})}
	go func() {
		for {
			select {
			case buf := <-c.queue:
				if _, err := conn.Write(buf); err != nil {
					return
				}
			case <-c.done:
				return
			}
		}
	}()
	return c
}

func (c *swallowConn) Write(p []byte) (int, error) {
	buf := append([]byte(nil), p...)
	select {
	case c.queue <- buf:
		return len(p), nil
	case <-c.done:
		return 0, net.ErrClosed
	}
}

func (c *swallowConn) Close() error {
	c.once.Do(func() { close(c.done) })
	return c.Conn.Close()
}

// throttle 几条连接一起只收这么快（字节 / 秒）。
type throttle struct {
	mu   sync.Mutex
	rate float64
	next time.Time
}

func (t *throttle) take(n int) {
	t.mu.Lock()
	now := time.Now()
	if t.next.Before(now) {
		t.next = now
	}
	t.next = t.next.Add(time.Duration(float64(n) / t.rate * float64(time.Second)))
	wait := time.Until(t.next)
	t.mu.Unlock()
	if wait > 0 {
		time.Sleep(wait)
	}
}

func withShortSpeedTest(t *testing.T, base string, down, up time.Duration) {
	t.Helper()
	oldBase, oldDown, oldUp, oldEvery, oldWarm, oldExtra := speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup, speedTestMaxExtra
	speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup, speedTestMaxExtra = base, down, up, 100*time.Millisecond, 300*time.Millisecond, 3*time.Second
	t.Cleanup(func() {
		speedTestBaseURL, speedTestDownDuration, speedTestUpDuration, speedTestSampleEvery, speedTestWarmup, speedTestMaxExtra = oldBase, oldDown, oldUp, oldEvery, oldWarm, oldExtra
	})
}

// 上传只算服务器说收下了的：中间的缓冲再大，量出来的也是对端真收的速度，不是本机写进缓冲的速度。
func TestUploadCountsOnlyConfirmedBytes(t *testing.T) {
	limit := &throttle{rate: 4 << 20} // 对端一共每秒收 4 MB ≈ 33.5 Mbps
	var received atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/meta":
			_, _ = w.Write([]byte(`{"colo":"HKG"}`))
		case "/__down":
			n, _ := atoiSafe(r.URL.Query().Get("bytes"))
			if n > 512<<10 {
				n = 512 << 10
			}
			_, _ = w.Write(make([]byte, n))
		case "/__up":
			buf := make([]byte, 32<<10)
			for {
				n, err := r.Body.Read(buf)
				if n > 0 {
					limit.take(n)
					received.Add(int64(n))
				}
				if err != nil {
					break
				}
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	withShortSpeedTest(t, server.URL, 400*time.Millisecond, 2500*time.Millisecond)
	dialer := &net.Dialer{}
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return newSwallowConn(conn), nil
	}
	result, err := runHTTPSpeedTest(context.Background(), dial, cloudflareSpeedTarget(), nil)
	if err != nil {
		t.Fatal(err)
	}
	trueMbps := 4.0 * (1 << 20) * 8 / 1_000_000
	if result.UploadMbps < trueMbps*0.6 || result.UploadMbps > trueMbps*1.35 {
		t.Fatalf("upload = %.1f Mbps, the far end only takes %.1f Mbps", result.UploadMbps, trueMbps)
	}
	for _, sample := range result.Samples {
		if sample.Up > trueMbps*2 {
			t.Fatalf("no spike above what the far end takes: sample %+v (true %.1f)", sample, trueMbps)
		}
	}
	if result.UploadBytes <= 0 || result.DownloadBytes <= 0 {
		t.Fatalf("traffic used should be reported: %+v", result)
	}
}

// 就近的 Ookla 测速点：列表里挑 ping 得通、延迟最低的那台；上传按服务器回的 size= 算；出口 IP / 运营商
// 从 speedtest-config.php 拿。
func TestOoklaSpeedTestPicksReachableServer(t *testing.T) {
	var badPrefix atomic.Int32
	speedServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/speedtest/latency.txt":
			_, _ = w.Write([]byte("test=test\n"))
		case "/speedtest/random4000x4000.jpg":
			chunk := make([]byte, 64<<10)
			for i := 0; i < 64; i++ {
				if _, err := w.Write(chunk); err != nil {
					return
				}
			}
		case "/speedtest/upload.php":
			head := make([]byte, 9)
			n, _ := io.ReadFull(r.Body, head)
			if string(head[:n]) != "content1=" {
				badPrefix.Add(1)
			}
			rest, _ := io.Copy(io.Discard, r.Body)
			// 只认一半：送的比认的多时按认的算
			_, _ = fmt.Fprintf(w, "size=%d", (int64(n)+rest)/2)
		default:
			http.NotFound(w, r)
		}
	}))
	defer speedServer.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/js/servers":
			_, _ = fmt.Fprintf(w, `[{"url":"http://127.0.0.1:1/speedtest/upload.php","name":"Nowhere","sponsor":"Dead ISP","cc":"HK","host":"127.0.0.1:1","distance":1},
				{"url":"%s/speedtest/upload.php","name":"Hong Kong","sponsor":"Test Telecom","cc":"HK","host":"%s","distance":"12.4"}]`, speedServer.URL, strings.TrimPrefix(speedServer.URL, "http://"))
		case "/speedtest-config.php":
			_, _ = w.Write([]byte(`<?xml version="1.0"?><settings><client ip="198.51.100.7" lat="22.3" lon="114.1" isp="Test ISP" country="hk" /></settings>`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	oldServers, oldConfig := ooklaServersURL, ooklaConfigURL
	ooklaServersURL, ooklaConfigURL = api.URL+"/api/js/servers", api.URL+"/speedtest-config.php"
	defer func() { ooklaServersURL, ooklaConfigURL = oldServers, oldConfig }()
	withShortSpeedTest(t, "http://unused.invalid", 600*time.Millisecond, 1200*time.Millisecond)

	dialer := &net.Dialer{}
	var markers []string
	result, err := runHTTPSpeedTest(context.Background(), dialer.DialContext, ooklaSpeedTarget(), func(sample speedSample) {
		if sample.phase != "" {
			markers = append(markers, sample.phase)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Server != "ookla" || result.ServerName != "Test Telecom · Hong Kong" || result.ServerCountry != "HK" || result.ServerDistanceKm != 12 {
		t.Fatalf("server info: %+v", result)
	}
	if result.ClientIP != "198.51.100.7" || result.ASOrg != "Test ISP" || result.Country != "HK" {
		t.Fatalf("client info from speedtest-config.php: %+v", result)
	}
	if result.DownloadMbps <= 0 || result.UploadMbps <= 0 || result.ConnectMs <= 0 {
		t.Fatalf("numbers: %+v", result)
	}
	if badPrefix.Load() > 0 {
		t.Fatalf("upload body should look like a form (content1=…): %d bad", badPrefix.Load())
	}
	if strings.Join(markers, ",") != "download,upload" {
		t.Fatalf("phase markers = %v", markers)
	}
}

func TestOoklaConfirmedSizeAndParsers(t *testing.T) {
	target := speedTarget{name: "ookla", ookla: &ooklaServer{Base: "http://x"}}
	if got := target.confirmedUpload([]byte("size=1000"), 4096); got != 1000 {
		t.Fatalf("size= less than sent: %d", got)
	}
	if got := target.confirmedUpload([]byte("size=9999"), 4096); got != 4096 {
		t.Fatalf("size= above sent is capped: %d", got)
	}
	if got := target.confirmedUpload([]byte("garbage"), 4096); got != 4096 {
		t.Fatalf("unparsable reply counts what was sent: %d", got)
	}
	panel := panelSpeedTarget("https://panel.example", "tok")
	if got := panel.confirmedUpload([]byte(`{"bytes":512}`), 4096); got != 512 {
		t.Fatalf("panel {bytes}: %d", got)
	}
	servers := parseOoklaServers([]byte(`[{"url":"http://a.example:8080/speedtest/upload.php","name":"Tokyo","sponsor":"X","cc":"jp","host":"a.example:8080","distance":3},{"url":"ftp://nope"}]`))
	if len(servers) != 1 || servers[0].Base != "http://a.example:8080/speedtest" || servers[0].CC != "JP" || servers[0].label() != "X · Tokyo" {
		t.Fatalf("servers = %+v", servers)
	}
	now := time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)
	if d := parseRetryAfter("120", now); d != 2*time.Minute {
		t.Fatalf("seconds: %v", d)
	}
	if d := parseRetryAfter(now.Add(90*time.Second).Format(http.TimeFormat), now); d != 90*time.Second {
		t.Fatalf("http date: %v", d)
	}
	if d := parseRetryAfter("", now); d != 2*time.Second {
		t.Fatalf("missing: %v", d)
	}
}

// Cloudflare 回 429：Retry-After 一两秒就等一下接着测；要等一小时就报出来（再换下一个测速点）。
func TestCloudflare429RetryAfter(t *testing.T) {
	var limited atomic.Int32
	var retryAfter atomic.Value
	retryAfter.Store("1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/meta":
			_, _ = w.Write([]byte(`{"colo":"HKG"}`))
		case "/__down":
			if r.URL.Query().Get("bytes") != "0" && limited.Add(1) <= 2 {
				w.Header().Set("Retry-After", retryAfter.Load().(string))
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			n, _ := atoiSafe(r.URL.Query().Get("bytes"))
			if n > 256<<10 {
				n = 256 << 10
			}
			_, _ = w.Write(make([]byte, n))
		case "/__up":
			_, _ = io.Copy(io.Discard, r.Body)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	withShortSpeedTest(t, server.URL, 1500*time.Millisecond, 700*time.Millisecond)
	dialer := &net.Dialer{}
	result, err := runHTTPSpeedTest(context.Background(), dialer.DialContext, cloudflareSpeedTarget(), nil)
	if err != nil {
		t.Fatalf("a short Retry-After should be waited out: %v", err)
	}
	if result.DownloadMbps <= 0 {
		t.Fatalf("download after the retry: %+v", result)
	}

	limited.Store(0)
	retryAfter.Store("3600")
	_, err = runHTTPSpeedTest(context.Background(), dialer.DialContext, cloudflareSpeedTarget(), nil)
	if err == nil || !strings.Contains(err.Error(), "限流") || !strings.Contains(err.Error(), "1.0 小时") {
		t.Fatalf("a long Retry-After should stop with the wait: %v", err)
	}
}

func TestSpeedFallbackNotes(t *testing.T) {
	note := speedFallbackNote([]speedTarget{ooklaSpeedTarget()}, []string{"连不上 speedtest.net"}, cloudflareSpeedTarget(), false)
	if !strings.Contains(note, "Ookla") || !strings.Contains(note, "改对 Cloudflare 测") {
		t.Fatalf("cloudflare note: %s", note)
	}
	note = speedFallbackNote([]speedTarget{ooklaSpeedTarget(), cloudflareSpeedTarget()}, []string{"a", "b"}, panelSpeedTarget("https://p", "t"), true)
	if !strings.Contains(note, "Cloudflare 都测不了") || !strings.Contains(note, "整条链出口到面板") || !strings.Contains(note, "上限是面板服务器自己的带宽") {
		t.Fatalf("panel note: %s", note)
	}
}

// Ookla 测速点把上传 307 转到别处（真机上 *.prod.hosts.ooklaserver.net 就这样）：跟过去照测，之后直接送到转过去的地方。
// 2.2.246 没给请求体的 GetBody，Go 不跟 POST 的 307，整段失败、退到 Cloudflare / 面板。
func TestOoklaUploadFollows307(t *testing.T) {
	var redirected, landed atomic.Int32
	speedServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/speedtest/latency.txt":
			_, _ = w.Write([]byte("test=test\n"))
		case "/speedtest/random4000x4000.jpg":
			_, _ = w.Write(make([]byte, 2<<20))
		case "/speedtest/upload.php":
			redirected.Add(1)
			http.Redirect(w, r, "/v2/upload?"+r.URL.RawQuery, http.StatusTemporaryRedirect)
		case "/v2/upload":
			landed.Add(1)
			n, _ := io.Copy(io.Discard, r.Body)
			_, _ = fmt.Fprintf(w, "size=%d", n)
		default:
			http.NotFound(w, r)
		}
	}))
	defer speedServer.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/js/servers" {
			_, _ = fmt.Fprintf(w, `[{"url":"%s/speedtest/upload.php","name":"Singapore","sponsor":"Campana","cc":"SG","host":"x","distance":3}]`, speedServer.URL)
			return
		}
		http.NotFound(w, r)
	}))
	defer api.Close()
	oldServers, oldConfig := ooklaServersURL, ooklaConfigURL
	ooklaServersURL, ooklaConfigURL = api.URL+"/api/js/servers", api.URL+"/none"
	defer func() { ooklaServersURL, ooklaConfigURL = oldServers, oldConfig }()
	withShortSpeedTest(t, "http://unused.invalid", 500*time.Millisecond, 1200*time.Millisecond)
	dialer := &net.Dialer{}
	result, err := runHTTPSpeedTest(context.Background(), dialer.DialContext, ooklaSpeedTarget(), nil)
	if err != nil {
		t.Fatalf("a 307 on upload.php should be followed: %v", err)
	}
	if result.UploadMbps <= 0 || result.Server != "ookla" {
		t.Fatalf("upload after the redirect: %+v", result)
	}
	if landed.Load() <= redirected.Load() || redirected.Load() > int32(speedTestOoklaStreams*2) {
		t.Fatalf("later uploads should go straight to the new place: redirected=%d landed=%d", redirected.Load(), landed.Load())
	}
}

// 挑中的 Ookla 测速点测不成（下载回 403）：换延迟次低的那台从头测，note 写明换过；不再整段退到 Cloudflare / 面板。
func TestOoklaFallsBackToNextServer(t *testing.T) {
	serve := func(name string, latency time.Duration, forbidDownload bool) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/speedtest/latency.txt":
				time.Sleep(latency)
				_, _ = w.Write([]byte("test=test\n"))
			case "/speedtest/random4000x4000.jpg":
				if forbidDownload {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				_, _ = w.Write(make([]byte, 2<<20))
			case "/speedtest/upload.php":
				n, _ := io.Copy(io.Discard, r.Body)
				_, _ = fmt.Fprintf(w, "size=%d", n)
			default:
				http.NotFound(w, r)
			}
		}))
	}
	near := serve("near", 0, true)
	defer near.Close()
	far := serve("far", 40*time.Millisecond, false)
	defer far.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/js/servers" {
			_, _ = fmt.Fprintf(w, `[{"url":"%s/speedtest/upload.php","name":"Near","sponsor":"Broken ISP","cc":"HK","host":"near","distance":1},
				{"url":"%s/speedtest/upload.php","name":"Far","sponsor":"Good ISP","cc":"HK","host":"far","distance":9}]`, near.URL, far.URL)
			return
		}
		http.NotFound(w, r)
	}))
	defer api.Close()
	oldServers, oldConfig := ooklaServersURL, ooklaConfigURL
	ooklaServersURL, ooklaConfigURL = api.URL+"/api/js/servers", api.URL+"/none"
	defer func() { ooklaServersURL, ooklaConfigURL = oldServers, oldConfig }()
	withShortSpeedTest(t, "http://unused.invalid", 500*time.Millisecond, 800*time.Millisecond)
	dialer := &net.Dialer{}
	var resets int
	result, err := runHTTPSpeedTest(context.Background(), dialer.DialContext, ooklaSpeedTarget(), func(sample speedSample) {
		if sample.phase == "reset" {
			resets++
		}
	})
	if err != nil {
		t.Fatalf("the next Ookla server should be tried: %v", err)
	}
	if result.ServerName != "Good ISP · Far" || !strings.Contains(result.Note, "Broken ISP · Near") || !strings.Contains(result.Note, "换了 Good ISP · Far") {
		t.Fatalf("server / note: %q / %q", result.ServerName, result.Note)
	}
	if resets != 1 || result.DownloadMbps <= 0 || result.UploadMbps <= 0 {
		t.Fatalf("resets=%d result=%+v", resets, result)
	}
}

func TestOoklaEntitiesAndWaitText(t *testing.T) {
	var result speedTestResult
	parseOoklaClient(`<client ip="104.191.143.202" isp="AT&amp;T Internet" country="US" />`, &result)
	if result.ASOrg != "AT&T Internet" {
		t.Fatalf("isp = %q", result.ASOrg)
	}
	servers := parseOoklaServers([]byte(`[{"url":"http://a:8080/speedtest/upload.php","name":"L.A.","sponsor":"Sonic &amp; Co","cc":"us","host":"a:8080"}]`))
	if len(servers) != 1 || servers[0].Sponsor != "Sonic & Co" {
		t.Fatalf("servers = %+v", servers)
	}
	text := (&speedRateLimitError{Label: "speed.cloudflare.com", Where: "/__down", RetryAfter: time.Hour}).Error()
	if !strings.Contains(text, "约 1.0 小时后才放开") {
		t.Fatalf("wait text: %s", text)
	}
}

func TestOoklaCarrierRankingAndSummary(t *testing.T) {
	if carrierOf("CHINANET Guangdong province network") != "telecom" || carrierOf("China Unicom 5G") != "unicom" || carrierOf("China Mobile Hong Kong limited") != "mobile" || carrierOf("CMHK Broadband") != "mobile" || carrierOf("Shenzhen Tencent Computer Systems") != "" {
		t.Fatal("carrier names")
	}
	candidate := func(sponsor string, ms float64) ooklaCandidate {
		return ooklaCandidate{server: ooklaServer{Sponsor: sponsor, Name: "Guangzhou"}, best: ms}
	}
	list := []ooklaCandidate{candidate("China Mobile GD", 4), candidate("China Telecom GD", 6), candidate("China Unicom GD", 5), candidate("China Telecom Far", 90)}
	rankOoklaCandidates(list, "telecom")
	if list[0].server.Sponsor != "China Telecom GD" || list[1].server.Sponsor != "China Mobile GD" || list[3].server.Sponsor != "China Telecom Far" {
		t.Fatalf("same carrier first when its ping is close, far ones last: %+v", list)
	}
	plain := []ooklaCandidate{candidate("B", 6), candidate("A", 4)}
	rankOoklaCandidates(plain, "")
	if plain[0].server.Sponsor != "A" {
		t.Fatalf("no carrier: by latency: %+v", plain)
	}
	// 十格里有慢启动和掉速：丢掉最慢 3 格、最快 1 格再平均
	if got := speedSummary([]float64{10, 20, 30, 300, 300, 300, 300, 300, 300, 900}); got != 300 {
		t.Fatalf("trimmed mean = %v", got)
	}
	if got := speedSummary([]float64{100, 200}); got != 150 {
		t.Fatalf("few samples: plain mean = %v", got)
	}
}
