package main

/*
流媒体 / AI 服务解锁检测（2.2.225 起），扩展模块见 ext_unlock.go，面板那头见 server/ops/unlockAgent.ts。

从这台机器自己的出口 IP 去请求各服务的公开页面，按页面里的标记猜「能不能用、在哪个地区」。
判断方法照着社区常用的检测脚本（lmc999/RegionRestrictionCheck、xykt/IPQuality 的 2025-2026 版本）：

  Netflix   两部非自制剧（81280792 乐高忍者、70143836 绝命毒师）+ 一部自制剧（80018499）。
            非自制剧有一部能看 → 全解锁；都是「Oh no!」但自制剧能看 → 仅自制剧；都不行 → 不支持。
            地区取跳转后的地区路径（/hk/title/…），没有就取页面里 "id":"XX","countryName"。
  Disney+   打开 www.disneyplus.com，跳到 /unavailable 或 preview 页 → 不支持；403 → IP 被拒；
            否则算支持，地区按跳转后的语言路径（/en-gb → GB）或页面里的 countryCode 推断。
            （社区脚本走 BAMGrid 设备注册 + GraphQL，需要内嵌一组客户端令牌，这里不带第三方凭据。）
  YouTube   www.youtube.com/premium：跳到 google.cn → 不支持（CN）；「Premium is not available in your
            country」→ 不支持；有「ad-free」→ 支持，地区取 INNERTUBE_CONTEXT_GL / contentRegion。
  ChatGPT   api.openai.com/compliance/cookie_requirements 有 unsupported_country → App 不可用；
            ios.chat.openai.com 页面里有「VPN」→ App 端拦截。两个都没有 → 支持；只有一个 → 仅 Web / 仅 App；
            都有 → 不支持。地区取 chatgpt.com/cdn-cgi/trace 的 loc。
  Claude    claude.ai 跳到 anthropic.com/app-unavailable-in-region → 不支持；停在 claude.ai → 支持。
  Gemini    gemini.google.com 页面里的开关 45631641（老页面 45631641,null,true，2026 年的页面是
            \"45631641\":true）为 true → 支持，false → 不支持，找不到 → 无法判断；
            地区取 ,2,1,200,"XXX" 三字母码。
  Grok / Perplexity  打开首页：地区封锁页 → 不支持；Cloudflare 人机验证 → 无法判断；正常打开 → 支持。
  TikTok    www.tiktok.com 页面里的 "region":"XX" → 支持；拿不到地区 → 无法判断。

这些都是猜：服务一改页面，标记就可能失效，所以每一项只给 ok / partial / blocked / unknown 四种结论
加一句说明，拿不准的一律 unknown，绝不 panic。每个请求 10 秒超时、最多跟 5 次跳转、桌面 Chrome UA，
不走系统代理（要测的就是这台机器自己的出口），同时最多跑 unlockConcurrency 个服务。

加一个服务 = 在 unlockServices 里加一行。
*/

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	unlockStatusOK      = "ok"
	unlockStatusPartial = "partial"
	unlockStatusBlocked = "blocked"
	unlockStatusUnknown = "unknown"

	unlockRequestTimeout = 10 * time.Second
	unlockMaxRedirects   = 5
	unlockConcurrency    = 4
	unlockMaxBodyBytes   = 3 << 20
	unlockUserAgent      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

type unlockResult struct {
	Service string `json:"service"`
	Status  string `json:"status"`
	Region  string `json:"region,omitempty"`
	Detail  string `json:"detail,omitempty"`
	Ms      int64  `json:"ms,omitempty"`
}

type unlockService struct {
	ID    string
	Check func(ctx context.Context, p *unlockProbe) unlockResult
}

// unlockServices：要检测的服务。ID 和面板 shared/unlockCheck.ts 的 UNLOCK_SERVICES 对应。
var unlockServices = []unlockService{
	{ID: "netflix", Check: unlockCheckNetflix},
	{ID: "disney", Check: unlockCheckDisney},
	{ID: "youtube_premium", Check: unlockCheckYouTubePremium},
	{ID: "chatgpt", Check: unlockCheckChatGPT},
	{ID: "claude", Check: unlockCheckClaude},
	{ID: "gemini", Check: unlockCheckGemini},
	{ID: "grok", Check: unlockCheckGrok},
	{ID: "perplexity", Check: unlockCheckPerplexity},
	{ID: "tiktok", Check: unlockCheckTikTok},
}

// ---------------------------------------------------------------- HTTP

type unlockProbe struct {
	client *http.Client
}

type unlockResponse struct {
	Status   int
	FinalURL *url.URL
	Header   http.Header
	Body     string
}

type unlockDialFunc func(ctx context.Context, network, address string) (net.Conn, error)

func unlockNetwork(family string) string {
	switch family {
	case "ipv4":
		return "tcp4"
	case "ipv6":
		return "tcp6"
	}
	return "tcp"
}

// newUnlockProbe 建一个只给解锁检测用的客户端：按 family 只拨 v4 / v6，不走代理，跳转最多 5 次。
// dial / tlsConfig 为空时用系统拨号和系统证书（测试会换成拨 httptest 服务）。
func newUnlockProbe(family string, dial unlockDialFunc, tlsConfig *tls.Config) *unlockProbe {
	network := unlockNetwork(family)
	dialer := &net.Dialer{Timeout: unlockRequestTimeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			if dial != nil {
				return dial(ctx, network, address)
			}
			return dialer.DialContext(ctx, network, address)
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   unlockRequestTimeout,
		ResponseHeaderTimeout: unlockRequestTimeout,
	}
	if tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	} else {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	client := &http.Client{
		Timeout:   unlockRequestTimeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > unlockMaxRedirects {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	return &unlockProbe{client: client}
}

func (p *unlockProbe) close() {
	if t, ok := p.client.Transport.(*http.Transport); ok {
		t.CloseIdleConnections()
	}
}

func (p *unlockProbe) do(ctx context.Context, method, rawURL string, headers map[string]string, body io.Reader) (*unlockResponse, error) {
	reqCtx, cancel := context.WithTimeout(ctx, unlockRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, method, rawURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", unlockUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Sec-Ch-Ua-Platform", `"Windows"`)
	req.Header.Set("Sec-Fetch-Dest", "document")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Sec-Fetch-Site", "none")
	req.Header.Set("Upgrade-Insecure-Requests", "1")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, unlockMaxBodyBytes))
	if err != nil && len(raw) == 0 {
		return nil, err
	}
	return &unlockResponse{Status: resp.StatusCode, FinalURL: resp.Request.URL, Header: resp.Header, Body: string(raw)}, nil
}

func (p *unlockProbe) get(ctx context.Context, rawURL string, headers map[string]string) (*unlockResponse, error) {
	return p.do(ctx, http.MethodGet, rawURL, headers, nil)
}

// unlockNetErrText 把网络错误翻成一句短话（界面上直接显示）。
func unlockNetErrText(err error) string {
	if err == nil {
		return ""
	}
	var netErr net.Error
	msg := strings.ToLower(err.Error())
	switch {
	case errors.As(err, &netErr) && netErr.Timeout(), strings.Contains(msg, "deadline exceeded"), strings.Contains(msg, "timeout"):
		return "请求超时"
	case strings.Contains(msg, "no such host"):
		return "域名解析失败"
	case strings.Contains(msg, "network is unreachable"), strings.Contains(msg, "no route to host"), strings.Contains(msg, "address family not supported"):
		return "网络不可达（这个协议栈可能没有出口）"
	case strings.Contains(msg, "connection refused"):
		return "连接被拒绝"
	case strings.Contains(msg, "connection reset"):
		return "连接被重置"
	case strings.Contains(msg, "tls"), strings.Contains(msg, "certificate"):
		return "TLS 握手失败"
	}
	return "网络请求失败"
}

func unlockFail(service string, err error) unlockResult {
	return unlockResult{Service: service, Status: unlockStatusUnknown, Detail: unlockNetErrText(err)}
}

// unlockIsCloudflareChallenge：Cloudflare 的人机验证页 —— 拦的是「像机器人」，不是地区，没法据此下结论。
func unlockIsCloudflareChallenge(r *unlockResponse) bool {
	if r == nil {
		return false
	}
	if strings.EqualFold(r.Header.Get("Cf-Mitigated"), "challenge") {
		return true
	}
	if r.Status != http.StatusForbidden && r.Status != http.StatusServiceUnavailable && r.Status != 429 {
		return false
	}
	return strings.Contains(r.Body, "challenge-platform") || strings.Contains(r.Body, "Just a moment") || strings.Contains(r.Body, "cf-chl-")
}

var (
	unlockTraceLocRe = regexp.MustCompile(`(?m)^loc=([A-Z]{2})\s*$`)
)

// unlockTraceRegion 取 Cloudflare /cdn-cgi/trace 里的 loc（出口 IP 被认成哪个国家）。拿不到就空。
func unlockTraceRegion(ctx context.Context, p *unlockProbe, traceURL string) string {
	r, err := p.get(ctx, traceURL, map[string]string{"Accept": "text/plain,*/*"})
	if err != nil || r.Status != http.StatusOK {
		return ""
	}
	if m := unlockTraceLocRe.FindStringSubmatch(r.Body); m != nil {
		return m[1]
	}
	return ""
}

func unlockCleanRegion(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) < 2 || len(code) > 3 {
		return ""
	}
	for _, c := range code {
		if c < 'A' || c > 'Z' {
			return ""
		}
	}
	return code
}

func unlockHostIs(u *url.URL, host string) bool {
	if u == nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == host || strings.HasSuffix(h, "."+host)
}

// ---------------------------------------------------------------- 各服务

var (
	unlockNetflixPathRegionRe = regexp.MustCompile(`^/([a-z]{2})(?:-[a-z]{2})?/title/`)
	unlockNetflixBodyRegionRe = regexp.MustCompile(`"id":"([A-Z]{2})","countryName"`)
)

func unlockNetflixRegion(r *unlockResponse) string {
	if r == nil {
		return ""
	}
	if r.FinalURL != nil {
		if m := unlockNetflixPathRegionRe.FindStringSubmatch(r.FinalURL.Path); m != nil {
			return strings.ToUpper(m[1])
		}
	}
	if m := unlockNetflixBodyRegionRe.FindStringSubmatch(r.Body); m != nil {
		return m[1]
	}
	return ""
}

// unlockNetflixTitleOK：这部片在这个地区能看（页面正常出来、不是「Oh no!」）。
func unlockNetflixTitleOK(r *unlockResponse) bool {
	return r != nil && r.Status == http.StatusOK && !strings.Contains(r.Body, "Oh no!")
}

func unlockCheckNetflix(ctx context.Context, p *unlockProbe) unlockResult {
	const id = "netflix"
	type fetched struct {
		r   *unlockResponse
		err error
	}
	urls := []string{
		"https://www.netflix.com/title/81280792", // 乐高忍者（非自制）
		"https://www.netflix.com/title/70143836", // 绝命毒师（非自制）
		"https://www.netflix.com/title/80018499", // 自制剧
	}
	results := make([]fetched, len(urls))
	var wg sync.WaitGroup
	for i, u := range urls {
		wg.Add(1)
		go func(i int, u string) {
			defer wg.Done()
			r, err := p.get(ctx, u, nil)
			results[i] = fetched{r, err}
		}(i, u)
	}
	wg.Wait()
	licensed1, licensed2, original := results[0], results[1], results[2]
	if licensed1.err != nil && licensed2.err != nil && original.err != nil {
		return unlockFail(id, licensed1.err)
	}
	region := ""
	for _, f := range results {
		if region == "" {
			region = unlockNetflixRegion(f.r)
		}
	}
	if unlockNetflixTitleOK(licensed1.r) || unlockNetflixTitleOK(licensed2.r) {
		return unlockResult{Service: id, Status: unlockStatusOK, Region: region, Detail: "全解锁（非自制剧可看）"}
	}
	if unlockNetflixTitleOK(original.r) {
		return unlockResult{Service: id, Status: unlockStatusPartial, Region: region, Detail: "仅自制剧"}
	}
	blockedPage := func(f fetched) bool {
		return f.r != nil && (f.r.Status == http.StatusForbidden || f.r.Status == http.StatusNotFound || strings.Contains(f.r.Body, "Oh no!"))
	}
	if blockedPage(original) && (blockedPage(licensed1) || blockedPage(licensed2)) {
		detail := "不支持（自制剧也打不开）"
		if original.r.Status == http.StatusForbidden {
			detail = "不支持（IP 被 Netflix 拒绝）"
		}
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: detail}
	}
	return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "页面和预期不一样，无法判断"}
}

var (
	unlockDisneyLocaleRe  = regexp.MustCompile(`^/[a-z]{2}-([a-z]{2})(?:/|$)`)
	unlockDisneyCountryRe = regexp.MustCompile(`"countryCode"\s*:\s*"([A-Z]{2})"`)
)

func unlockCheckDisney(ctx context.Context, p *unlockProbe) unlockResult {
	const id = "disney"
	r, err := p.get(ctx, "https://www.disneyplus.com/", nil)
	if err != nil {
		return unlockFail(id, err)
	}
	finalPath := ""
	if r.FinalURL != nil {
		finalPath = strings.ToLower(r.FinalURL.Path)
	}
	region := ""
	if m := unlockDisneyCountryRe.FindStringSubmatch(r.Body); m != nil {
		region = m[1]
	} else if m := unlockDisneyLocaleRe.FindStringSubmatch(finalPath); m != nil {
		region = strings.ToUpper(m[1])
	}
	if strings.Contains(finalPath, "unavailable") {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "不在服务地区"}
	}
	if strings.Contains(finalPath, "preview") {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "这个地区还没上线"}
	}
	if r.Status == http.StatusForbidden {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "IP 被 Disney+ 拒绝"}
	}
	if r.Status == http.StatusOK && unlockHostIs(r.FinalURL, "disneyplus.com") {
		return unlockResult{Service: id, Status: unlockStatusOK, Region: region, Detail: "首页可用（未验证播放）"}
	}
	return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "页面和预期不一样，无法判断"}
}

var (
	unlockYouTubeGLRe     = regexp.MustCompile(`"INNERTUBE_CONTEXT_GL"\s*:\s*"([A-Z]{2})"`)
	unlockYouTubeRegionRe = regexp.MustCompile(`"contentRegion"\s*:\s*"([A-Z]{2})"`)
)

func unlockCheckYouTubePremium(ctx context.Context, p *unlockProbe) unlockResult {
	const id = "youtube_premium"
	// 同意页会挡住正文（欧洲 IP），带上社区脚本同款的同意 Cookie。
	r, err := p.get(ctx, "https://www.youtube.com/premium", map[string]string{"Cookie": "CONSENT=YES+cb; SOCS=CAI"})
	if err != nil {
		return unlockFail(id, err)
	}
	if unlockHostIs(r.FinalURL, "google.cn") || strings.Contains(r.Body, "www.google.cn") {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: "CN", Detail: "跳转到 google.cn"}
	}
	region := ""
	if m := unlockYouTubeGLRe.FindStringSubmatch(r.Body); m != nil {
		region = m[1]
	} else if m := unlockYouTubeRegionRe.FindStringSubmatch(r.Body); m != nil {
		region = m[1]
	}
	if strings.Contains(strings.ToLower(r.Body), "premium is not available in your country") {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "这个地区没有 Premium"}
	}
	if r.Status == http.StatusOK && strings.Contains(strings.ToLower(r.Body), "ad-free") {
		return unlockResult{Service: id, Status: unlockStatusOK, Region: region, Detail: "可订阅 Premium"}
	}
	return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "页面和预期不一样，无法判断"}
}

func unlockCheckChatGPT(ctx context.Context, p *unlockProbe) unlockResult {
	const id = "chatgpt"
	var (
		wg            sync.WaitGroup
		api, ios, fav *unlockResponse
		apiErr, iosEr error
		region        string
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		api, apiErr = p.get(ctx, "https://api.openai.com/compliance/cookie_requirements", map[string]string{
			"Accept":        "*/*",
			"Authorization": "Bearer null",
			"Origin":        "https://platform.openai.com",
			"Referer":       "https://platform.openai.com/",
		})
	}()
	go func() {
		defer wg.Done()
		ios, iosEr = p.get(ctx, "https://ios.chat.openai.com/", nil)
	}()
	go func() {
		defer wg.Done()
		region = unlockTraceRegion(ctx, p, "https://chatgpt.com/cdn-cgi/trace")
	}()
	wg.Wait()
	if apiErr != nil && iosEr != nil {
		return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: unlockNetErrText(apiErr)}
	}
	if apiErr != nil || iosEr != nil {
		err := apiErr
		if err == nil {
			err = iosEr
		}
		return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "有一项请求失败：" + unlockNetErrText(err)}
	}
	appBlocked := strings.Contains(strings.ToLower(api.Body), "unsupported_country")
	if appBlocked {
		// IPQuality 的补充：chatgpt.com 自己没拦（不是 403）就当网页版能用，只是 API / App 不让。
		fav, _ = p.get(ctx, "https://chatgpt.com/favicon.ico", map[string]string{"Accept": "image/*"})
	}
	vpnBlocked := strings.Contains(ios.Body, "VPN")
	if unlockIsCloudflareChallenge(ios) && !vpnBlocked {
		// iOS 端被人机验证挡住时不算 App 被拦 —— 看不出来。
		if appBlocked {
			return unlockResult{Service: id, Status: unlockStatusPartial, Region: region, Detail: "API 不支持这个地区，App 端无法判断"}
		}
		return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "被 Cloudflare 人机验证拦下，无法判断"}
	}
	switch {
	case !appBlocked && !vpnBlocked:
		return unlockResult{Service: id, Status: unlockStatusOK, Region: region, Detail: "网页和 App 都可用"}
	case appBlocked && vpnBlocked:
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "不支持这个地区"}
	case vpnBlocked:
		return unlockResult{Service: id, Status: unlockStatusPartial, Region: region, Detail: "仅网页可用（App 认为是 VPN）"}
	default:
		if fav != nil && fav.Status == http.StatusForbidden {
			return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "不支持这个地区"}
		}
		return unlockResult{Service: id, Status: unlockStatusPartial, Region: region, Detail: "仅 App 可用（API 不支持这个地区）"}
	}
}

func unlockCheckClaude(ctx context.Context, p *unlockProbe) unlockResult {
	const id = "claude"
	var region string
	done := make(chan struct{})
	go func() {
		defer close(done)
		region = unlockTraceRegion(ctx, p, "https://claude.ai/cdn-cgi/trace")
	}()
	r, err := p.get(ctx, "https://claude.ai/", nil)
	<-done
	if err != nil {
		res := unlockFail(id, err)
		res.Region = region
		return res
	}
	if r.FinalURL != nil && strings.Contains(r.FinalURL.Path, "app-unavailable-in-region") {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "不支持这个地区"}
	}
	if unlockIsCloudflareChallenge(r) {
		return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "被 Cloudflare 人机验证拦下，无法判断"}
	}
	if unlockHostIs(r.FinalURL, "claude.ai") && r.Status < 400 {
		return unlockResult{Service: id, Status: unlockStatusOK, Region: region, Detail: "可用"}
	}
	if r.Status == http.StatusForbidden {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "IP 被拒绝（403）"}
	}
	return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "页面和预期不一样，无法判断"}
}

var (
	unlockGeminiRegionRe = regexp.MustCompile(`,2,1,200,"([A-Z]{3})"`)
	// 可用标记 45631641：老页面是数组 45631641,null,true，2026 年的页面是转义过的 JSON \"45631641\":true。
	unlockGeminiFlagRe = regexp.MustCompile(`45631641(?:,null,|\\?":)(true|false)`)
)

func unlockCheckGemini(ctx context.Context, p *unlockProbe) unlockResult {
	const id = "gemini"
	r, err := p.get(ctx, "https://gemini.google.com/", nil)
	if err != nil {
		return unlockFail(id, err)
	}
	region := ""
	if m := unlockGeminiRegionRe.FindStringSubmatch(r.Body); m != nil {
		region = m[1]
	}
	if r.Status != http.StatusOK {
		return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "页面打不开（HTTP " + strconv.Itoa(r.Status) + "）"}
	}
	m := unlockGeminiFlagRe.FindStringSubmatch(r.Body)
	switch {
	case m != nil && m[1] == "true":
		return unlockResult{Service: id, Status: unlockStatusOK, Region: region, Detail: "可用"}
	case m != nil:
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "不支持这个地区"}
	}
	return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "页面里找不到可用标记（Google 可能改了页面）"}
}

var unlockRegionBlockedMarkers = []string{
	"not available in your region",
	"not available in your country",
	"isn't available in your region",
	"isn't available in your country",
	"not supported in your region",
	"unavailable in your region",
	"is not available in your location",
}

// unlockCheckCloudflarePage：Grok、Perplexity 这类前面挡着 Cloudflare 的站，看首页是正常打开、
// 地区封锁页，还是人机验证页。地区取同站的 /cdn-cgi/trace。
func unlockCheckCloudflarePage(ctx context.Context, p *unlockProbe, id, pageURL, host string) unlockResult {
	var region string
	done := make(chan struct{})
	go func() {
		defer close(done)
		region = unlockTraceRegion(ctx, p, "https://"+host+"/cdn-cgi/trace")
	}()
	r, err := p.get(ctx, pageURL, nil)
	<-done
	if err != nil {
		res := unlockFail(id, err)
		res.Region = region
		return res
	}
	lower := strings.ToLower(r.Body)
	finalPath := ""
	if r.FinalURL != nil {
		finalPath = strings.ToLower(r.FinalURL.Path)
	}
	if r.Status == 451 || strings.Contains(finalPath, "unavailable") || strings.Contains(finalPath, "restricted") {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "不支持这个地区"}
	}
	for _, marker := range unlockRegionBlockedMarkers {
		if strings.Contains(lower, marker) {
			return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "不支持这个地区"}
		}
	}
	if unlockIsCloudflareChallenge(r) {
		return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "被 Cloudflare 人机验证拦下，无法判断"}
	}
	if r.Status == http.StatusOK && unlockHostIs(r.FinalURL, strings.TrimPrefix(host, "www.")) {
		return unlockResult{Service: id, Status: unlockStatusOK, Region: region, Detail: "可用"}
	}
	if r.Status == http.StatusForbidden {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Region: region, Detail: "IP 被拒绝（403）"}
	}
	return unlockResult{Service: id, Status: unlockStatusUnknown, Region: region, Detail: "页面打不开（HTTP " + strconv.Itoa(r.Status) + "）"}
}

func unlockCheckGrok(ctx context.Context, p *unlockProbe) unlockResult {
	return unlockCheckCloudflarePage(ctx, p, "grok", "https://grok.com/", "grok.com")
}

func unlockCheckPerplexity(ctx context.Context, p *unlockProbe) unlockResult {
	return unlockCheckCloudflarePage(ctx, p, "perplexity", "https://www.perplexity.ai/", "www.perplexity.ai")
}

var unlockTikTokRegionRe = regexp.MustCompile(`"region"\s*:\s*"([A-Z]{2})"`)

func unlockCheckTikTok(ctx context.Context, p *unlockProbe) unlockResult {
	const id = "tiktok"
	r, err := p.get(ctx, "https://www.tiktok.com/", nil)
	if err != nil {
		return unlockFail(id, err)
	}
	if strings.Contains(r.Body, "Please wait...") {
		if again, err2 := p.get(ctx, "https://www.tiktok.com/explore", nil); err2 == nil {
			r = again
		}
	}
	if r.Status == 451 || strings.Contains(strings.ToLower(r.Body), "not available in your region") {
		return unlockResult{Service: id, Status: unlockStatusBlocked, Detail: "不支持这个地区"}
	}
	if m := unlockTikTokRegionRe.FindStringSubmatch(r.Body); m != nil {
		return unlockResult{Service: id, Status: unlockStatusOK, Region: m[1], Detail: "可用"}
	}
	return unlockResult{Service: id, Status: unlockStatusUnknown, Detail: "页面里没有地区信息，无法判断"}
}

// ---------------------------------------------------------------- 跑一轮

// runUnlockChecks 并发（最多 unlockConcurrency 个）跑完 services，结果按 services 的顺序返回。
// 单个服务 panic 只把那一项记成 unknown。
func runUnlockChecks(ctx context.Context, p *unlockProbe, services []unlockService) []unlockResult {
	results := make([]unlockResult, len(services))
	sem := make(chan struct{}, unlockConcurrency)
	var wg sync.WaitGroup
	for i, svc := range services {
		wg.Add(1)
		go func(i int, svc unlockService) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			started := time.Now()
			res := func() (res unlockResult) {
				defer func() {
					if r := recover(); r != nil {
						logf("unlock check %s panic: %v", svc.ID, r)
						res = unlockResult{Service: svc.ID, Status: unlockStatusUnknown, Detail: "检测出错"}
					}
				}()
				return svc.Check(ctx, p)
			}()
			res.Service = svc.ID
			res.Region = unlockCleanRegion(res.Region)
			switch res.Status {
			case unlockStatusOK, unlockStatusPartial, unlockStatusBlocked, unlockStatusUnknown:
			default:
				res.Status = unlockStatusUnknown
			}
			if runes := []rune(res.Detail); len(runes) > 120 {
				res.Detail = string(runes[:120])
			}
			res.Ms = time.Since(started).Milliseconds()
			results[i] = res
		}(i, svc)
	}
	wg.Wait()
	return results
}
