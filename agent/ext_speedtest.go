package main

/*
测速做准（2.2.246）。2.2.245 以前三个毛病：

 1. 上传是在 Go 把字节读进本机 socket 那一刻就算「送出去了」。经 sing-box、几跳转发时，这些字节先
    被本机回环、sing-box、转发机的缓冲一口吞下：曲线开头冲到几百上千 Mbps，缓冲满了每条流都在等
    服务器回 200，曲线掉到 0；到点被掐掉的那一次还整份算进去。现在只算服务器回了 2xx、说收下了的
    字节（面板回 {bytes}，Ookla 回 size=N），按这一次请求从开始到收到回应的时间均摊到曲线上；
    每次送多大跟着速度调（一次大约 1 秒），慢的线路也有完整送完的请求可算。
 2. 测速点只有 Cloudflare 和面板：Cloudflare 对机房出口限流（HTTP 429）、国内机器常常连不上；
    改测到面板量的是面板服务器自己的带宽（几台机器都测出 40–48 Mbps 就是这个）。现在先就近找一个
    Ookla 测速点（speedtest.net 的服务器列表按出口 IP 给最近的几台，挑延迟最低的），这是 VPS 测带宽
    的通行做法，国内机器拿到的是电信 / 联通 / 移动的测速点；测不了再 Cloudflare，再不行才面板。
 3. Cloudflare 回 429 就整段放弃。现在按 Retry-After：几秒以内等一下接着测，太久就报「限流到几点」
    再换下一个测速点。

还有：每台主机只留 2 条空闲连接（Go 的默认），四条流轮着要，两条流每次都重新握手、重新慢启动 ——
连接池按流数开。
*/

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 测试里换成本地服务。
var (
	ooklaServersURL = "https://www.speedtest.net/api/js/servers?engine=js&https_functional=true&limit=10"
	ooklaConfigURL  = "https://www.speedtest.net/speedtest-config.php"
)

const (
	// Ookla 的测速点给得起并发，多开几条（Ookla 自己的客户端千兆以上也开到 8 条往上），经长链（握手慢、
	// 窗口小）也能把带宽吃满。
	speedTestOoklaStreams = 8
	// random4000x4000.jpg 约 30 MB。
	ooklaDownSize = 4000
	// 列表里最近的前几台各 ping 三次，按延迟排；挑中的那台测不成（2.2.247）就换下一台，最多试几台。
	ooklaPingCandidates = 6
	ooklaMaxTries       = 3
	// 上传每次送多大：从 256 KB 起，跟着速度调到一次大约 1 秒（Cloudflare 官方测速也是这么一级级加）。
	speedTestUpStartBytes = 256 << 10
	speedTestUpMinBytes   = 64 << 10
	speedTestUpMaxBytes   = 25 << 20
	ooklaUpMaxBytes       = 8 << 20
	speedTestUpPerRequest = time.Second
	// Retry-After 在这以内就等一下接着测；再久就算这个测速点限流了、换下一个。
	speedTestRetryAfterMax = 5 * time.Second
	speedTestRetryLimit    = 3
)

type ooklaServer struct {
	Base       string // http://host:8080/speedtest（upload.php 去掉）
	Name       string
	Sponsor    string
	CC         string
	Host       string
	DistanceKm float64
}

func (s ooklaServer) label() string {
	parts := []string{}
	if s.Sponsor != "" {
		parts = append(parts, s.Sponsor)
	}
	if s.Name != "" && s.Name != s.Sponsor {
		parts = append(parts, s.Name)
	}
	if len(parts) == 0 {
		return s.Host
	}
	return strings.Join(parts, " · ")
}

func anyText(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return ""
	}
}

func anyFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case string:
		n, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return n
	default:
		return 0
	}
}

// parseOoklaServers 读 speedtest.net 的服务器列表（/api/js/servers）。
func parseOoklaServers(body []byte) []ooklaServer {
	var raw []map[string]any
	if json.Unmarshal(body, &raw) != nil {
		return nil
	}
	servers := make([]ooklaServer, 0, len(raw))
	for _, item := range raw {
		url := anyText(item["url"])
		if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
			continue
		}
		base := url
		if i := strings.LastIndex(base, "/"); i > strings.Index(base, "://")+3 {
			base = base[:i]
		}
		servers = append(servers, ooklaServer{
			Base:       base,
			Name:       html.UnescapeString(anyText(item["name"])),
			Sponsor:    html.UnescapeString(anyText(item["sponsor"])),
			CC:         strings.ToUpper(anyText(item["cc"])),
			Host:       anyText(item["host"]),
			DistanceKm: anyFloat(item["distance"]),
		})
	}
	return servers
}

var ooklaClientTag = regexp.MustCompile(`<client\s+([^>]*?)/?>`)
var xmlAttr = regexp.MustCompile(`(\w+)="([^"]*)"`)

// parseOoklaClient 读 speedtest-config.php 里的 <client ip=".." isp=".." country=".."/>：出口 IP 和运营商。
func parseOoklaClient(body string, result *speedTestResult) {
	match := ooklaClientTag.FindStringSubmatch(body)
	if match == nil {
		return
	}
	for _, attr := range xmlAttr.FindAllStringSubmatch(match[1], -1) {
		// XML 里的 & 写成 &amp;（「AT&amp;T Internet」）
		value := strings.TrimSpace(html.UnescapeString(attr[2]))
		switch attr[1] {
		case "ip":
			result.ClientIP = value
		case "isp":
			result.ASOrg = value
		case "country":
			result.Country = strings.ToUpper(value)
		}
	}
}

func speedCacheBuster() string {
	return strconv.FormatInt(time.Now().UnixNano()+rand.Int63n(1000), 36)
}

// ooklaCandidate 一台 ping 得通的 Ookla 测速点：target 已经指向它（latency.txt 被 30x 转走的，指向转过去的地方）。
type ooklaCandidate struct {
	server    ooklaServer
	target    speedTarget
	best      float64
	connectMs float64
}

// pickOoklaServers 拿服务器列表（按出口 IP 给最近的；经节点时就是落地出口附近的），前几台各 ping 三次，
// 按延迟从低到高排好（至少两次 ping 得通的才算）。第一次要握手，记成那台的「建连」。出口 IP 和运营商
// 从 speedtest-config.php 拿，写进 info。
func pickOoklaServers(ctx context.Context, client *http.Client, target speedTarget, info *speedTestResult) ([]ooklaCandidate, error) {
	timeout := target.metaTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	listCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(listCtx, http.MethodGet, ooklaServersURL, nil)
	req.Header.Set("User-Agent", "NEX-Agent/"+Version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连不上 speedtest.net：%v", err)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	_ = resp.Body.Close()
	if !is2xx(resp) {
		return nil, &speedHTTPError{Status: resp.StatusCode, Where: "服务器列表", Label: "speedtest.net"}
	}
	servers := parseOoklaServers(body)
	if len(servers) == 0 {
		return nil, errors.New("speedtest.net 没给测速点")
	}
	if len(servers) > ooklaPingCandidates {
		servers = servers[:ooklaPingCandidates]
	}

	// 出口 IP 和运营商和 ping 一起拿（拿不到不要紧）：挑测速点时要看是不是同一家运营商。
	var configWG sync.WaitGroup
	configWG.Add(1)
	go func() {
		defer configWG.Done()
		configCtx, cancelConfig := context.WithTimeout(ctx, 6*time.Second)
		defer cancelConfig()
		creq, err := http.NewRequestWithContext(configCtx, http.MethodGet, ooklaConfigURL, nil)
		if err != nil {
			return
		}
		creq.Header.Set("User-Agent", "NEX-Agent/"+Version)
		cr, err := client.Do(creq)
		if err != nil {
			return
		}
		cbody, _ := io.ReadAll(io.LimitReader(cr.Body, 64<<10))
		_ = cr.Body.Close()
		if is2xx(cr) {
			parseOoklaClient(string(cbody), info)
		}
	}()

	type pinged struct {
		ooklaCandidate
		ok int
	}
	results := make([]pinged, len(servers))
	var wg sync.WaitGroup
	for i, server := range servers {
		wg.Add(1)
		go func(i int, server ooklaServer) {
			defer wg.Done()
			entry := pinged{ooklaCandidate: ooklaCandidate{server: server, best: math.Inf(1)}}
			base := server.Base
			moved := false
			// 量三次：第一次要握手，记成「建连」；后两次取低的当延迟。被 30x 转走那一次不算，多给一次机会。
			for try := 0; try < 4 && entry.ok < 3; try++ {
				probe := speedTarget{name: "ookla", label: "Ookla " + server.Host, base: base, ookla: &server}
				pingCtx, cancelPing := context.WithTimeout(ctx, 4*time.Second)
				started := time.Now()
				rs, err := client.Do(probe.latencyRequest(pingCtx))
				if err == nil {
					_, _ = io.Copy(io.Discard, io.LimitReader(rs.Body, 4096))
					_ = rs.Body.Close()
				}
				cancelPing()
				if err != nil || !is2xx(rs) {
					break
				}
				// 被 30x 转到别处（http 转 https、换了路径）：后面都直接连转过去的地方，延迟也不多算一趟
				if final := rs.Request.URL; final != nil && !moved {
					if path := strings.TrimSuffix(final.Path, "/latency.txt"); path != final.Path {
						if next := final.Scheme + "://" + final.Host + path; next != base {
							base = next
							moved = true
							continue
						}
					}
				}
				ms := float64(time.Since(started).Microseconds()) / 1000
				if entry.ok == 0 {
					entry.connectMs = ms
				} else if ms < entry.best {
					entry.best = ms
				}
				entry.ok++
			}
			entry.target = speedTarget{name: "ookla", label: "Ookla " + server.Host, base: base, ookla: &server}
			entry.target.ookla.Base = base
			results[i] = entry
		}(i, server)
	}
	wg.Wait()
	configWG.Wait()
	var candidates []ooklaCandidate
	for _, entry := range results {
		if entry.ok >= 2 {
			candidates = append(candidates, entry.ooklaCandidate)
		}
	}
	if len(candidates) == 0 {
		return nil, fmt.Errorf("附近 %d 个 Ookla 测速点都连不上", len(servers))
	}
	rankOoklaCandidates(candidates, carrierOf(info.ASOrg))
	return candidates, nil
}

// carrierOf 认运营商：国内三家（和它们在香港等地的分公司）。认不出返回空。
func carrierOf(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "telecom") || strings.Contains(n, "chinanet") || strings.Contains(n, "电信") || strings.Contains(n, "cn2"):
		return "telecom"
	case strings.Contains(n, "unicom") || strings.Contains(n, "联通") || strings.Contains(n, "china netcom"):
		return "unicom"
	case strings.Contains(n, "china mobile") || strings.Contains(n, "cmcc") || strings.Contains(n, "cmhk") || strings.Contains(n, "移动"):
		return "mobile"
	}
	return ""
}

// rankOoklaCandidates 按延迟排；和这台机器同一家运营商的（电信 / 联通 / 移动）只要延迟不比最快的差太多
// （两倍或多 20 ms 以内）就排前面：国内跨运营商的互联口常常是瓶颈，跨网测出来的不是这台机器的带宽。
// 融合怪这类脚本也是按运营商分开挑测速点的。
func rankOoklaCandidates(candidates []ooklaCandidate, clientCarrier string) {
	sort.SliceStable(candidates, func(a, b int) bool { return candidates[a].best < candidates[b].best })
	if clientCarrier == "" || len(candidates) < 2 {
		return
	}
	near := math.Max(candidates[0].best*2, candidates[0].best+20)
	rank := func(candidate ooklaCandidate) int {
		if candidate.best > near {
			return 2
		}
		if carrierOf(candidate.server.Sponsor+" "+candidate.server.Name) == clientCarrier {
			return 0
		}
		return 1
	}
	sort.SliceStable(candidates, func(a, b int) bool { return rank(candidates[a]) < rank(candidates[b]) })
}

// speedSummary 把测到的每格速率合成一个数：照 Ookla 的做法丢掉最慢的 30% 和最快的 10% 再平均 —— 慢启动、
// 偶尔掉速的那几格不把结果拉低，偶尔冲高的一格也不抬高；格子太少（不到 5 格）就直接平均。2.2.246 以前是
// 直接平均，起伏大的线路结果偏低，和 Stash、Speedtest 这类客户端对不上。
func speedSummary(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	if len(sorted) >= 5 {
		sorted = sorted[len(sorted)*3/10 : len(sorted)-len(sorted)/10]
	}
	sum := 0.0
	for _, value := range sorted {
		sum += value
	}
	return math.Round(sum/float64(len(sorted))*10) / 10
}

// runOoklaSpeedTest 就近挑 Ookla 测速点测。挑中的那台测不成（回 4xx / 5xx、延迟全失败、上传被拒……）就换
// 延迟次低的那台从头再测，最多试 ooklaMaxTries 台；2.2.246 一台测不成就整段放弃，改测 Cloudflare / 面板。
func runOoklaSpeedTest(ctx context.Context, client *http.Client, target speedTarget, progress func(speedSample)) (*speedTestResult, error) {
	info := &speedTestResult{}
	candidates, err := pickOoklaServers(ctx, client, target, info)
	if err != nil {
		return nil, err
	}
	var failures []string
	for i, candidate := range candidates {
		if i >= ooklaMaxTries || ctx.Err() != nil {
			break
		}
		if i > 0 && progress != nil {
			// 上一台的曲线不要了，从头画
			progress(speedSample{phase: "reset"})
		}
		result := &speedTestResult{
			Samples:          []speedSample{},
			Server:           "ookla",
			ClientIP:         info.ClientIP,
			ASOrg:            info.ASOrg,
			Country:          info.Country,
			ConnectMs:        math.Round(candidate.connectMs*10) / 10,
			ServerName:       candidate.server.label(),
			ServerCountry:    candidate.server.CC,
			ServerDistanceKm: math.Round(candidate.server.DistanceKm),
			ServerHost:       candidate.server.Host,
		}
		err := measureSpeed(ctx, client, candidate.target, result, progress)
		if err == nil {
			if len(failures) > 0 {
				note := fmt.Sprintf("最近的 Ookla 测速点测不成（%s），换了 %s", strings.Join(failures, "；"), candidate.server.label())
				if result.Note != "" {
					note += "；" + result.Note
				}
				result.Note = note
			}
			return result, nil
		}
		if ctx.Err() != nil {
			return nil, err
		}
		failures = append(failures, fmt.Sprintf("%s %s", candidate.server.label(), firstLine(err.Error())))
	}
	return nil, fmt.Errorf("附近的 Ookla 测速点都测不成（%s）", strings.Join(failures, "；"))
}

// uploadRedirect 上传被测速点 307 / 308 转到别处（比如 http 转 https）以后，后面的请求直接送过去，
// 不再每次先被转一趟。
type uploadRedirect struct{ to atomic.Pointer[url.URL] }

func (r *uploadRedirect) apply(req *http.Request) {
	moved := r.to.Load()
	if moved == nil {
		return
	}
	next := *moved
	next.RawQuery = req.URL.RawQuery
	req.URL = &next
	req.Host = next.Host
}

func (r *uploadRedirect) remember(sent *http.Request, resp *http.Response) {
	if resp == nil || resp.Request == nil || resp.Request.URL == nil || sent == nil || sent.URL == nil {
		return
	}
	final := resp.Request.URL
	if final.Scheme == sent.URL.Scheme && final.Host == sent.URL.Host && final.Path == sent.URL.Path {
		return
	}
	moved := *final
	moved.RawQuery = ""
	r.to.Store(&moved)
}

// ---------------------------------------------------------------- 各测速点的请求形状

func (t speedTarget) streamCount() int {
	if t.ookla != nil {
		return speedTestOoklaStreams
	}
	return speedTestStreams
}

func (t speedTarget) uploadMaxBytes() int64 {
	if t.ookla != nil {
		return ooklaUpMaxBytes
	}
	return speedTestUpMaxBytes
}

func (t speedTarget) latencyRequest(ctx context.Context) *http.Request {
	if t.ookla != nil {
		return t.request(ctx, http.MethodGet, "/latency.txt?x="+speedCacheBuster(), nil)
	}
	return t.request(ctx, http.MethodGet, t.down+"?bytes=0", nil)
}

func (t speedTarget) downloadRequest(ctx context.Context) *http.Request {
	if t.ookla != nil {
		return t.request(ctx, http.MethodGet, fmt.Sprintf("/random%dx%d.jpg?x=%s", ooklaDownSize, ooklaDownSize, speedCacheBuster()), nil)
	}
	return t.request(ctx, http.MethodGet, fmt.Sprintf("%s?bytes=%d", t.down, speedTestDownBytes), nil)
}

func (t speedTarget) downloadWhere() string {
	if t.ookla != nil {
		return "/random*.jpg"
	}
	return t.down
}

func (t speedTarget) uploadWhere() string {
	if t.ookla != nil {
		return "/upload.php"
	}
	return t.up
}

func (t speedTarget) uploadRequest(ctx context.Context, body io.Reader, size int64) *http.Request {
	var r *http.Request
	if t.ookla != nil {
		r = t.request(ctx, http.MethodPost, "/upload.php?x="+speedCacheBuster(), body)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		r = t.request(ctx, http.MethodPost, t.up, body)
		r.Header.Set("Content-Type", "application/octet-stream")
	}
	r.ContentLength = size
	return r
}

// confirmedUpload 服务器说收下了多少：Ookla 回 size=N，面板回 {"bytes":N}，Cloudflare 回 200 就是全收了。
// 比送的多（不该有）按送的算。
func (t speedTarget) confirmedUpload(body []byte, sent int64) int64 {
	text := strings.TrimSpace(string(body))
	switch {
	case t.ookla != nil:
		if value, ok := strings.CutPrefix(text, "size="); ok {
			if n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64); err == nil && n > 0 && n < sent {
				return n
			}
		}
	case t.name == "panel":
		var reply struct {
			Bytes int64 `json:"bytes"`
		}
		if json.Unmarshal(body, &reply) == nil && reply.Bytes > 0 && reply.Bytes < sent {
			return reply.Bytes
		}
	}
	return sent
}

// ---------------------------------------------------------------- 限流（HTTP 429）

type speedRateLimitError struct {
	Label      string
	Where      string
	RetryAfter time.Duration
}

func (e *speedRateLimitError) Error() string {
	if e.RetryAfter > speedTestRetryAfterMax {
		return fmt.Sprintf("%s 限流了（HTTP 429，%s），约 %s后才放开", e.Label, e.Where, humanWait(e.RetryAfter))
	}
	return fmt.Sprintf("%s 限流了（HTTP 429，%s）", e.Label, e.Where)
}

func humanWait(d time.Duration) string {
	if d >= time.Hour {
		return fmt.Sprintf("%.1f 小时", d.Hours())
	}
	if d >= time.Minute {
		return fmt.Sprintf("%d 分钟", int(math.Ceil(d.Minutes())))
	}
	return fmt.Sprintf("%d 秒", int(math.Ceil(d.Seconds())))
}

// parseRetryAfter 读 Retry-After：秒数或 HTTP 日期；没有按 2 秒。
func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 2 * time.Second
	}
	if n, err := strconv.Atoi(value); err == nil {
		if n < 0 {
			n = 0
		}
		return time.Duration(n) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		if d := at.Sub(now); d > 0 {
			return d
		}
		return 0
	}
	return 2 * time.Second
}

// speedStatusError 非 2xx 变成错误：429 带上 Retry-After，别的照旧（403 被拒、413 请求体太大……）。
func speedStatusError(resp *http.Response, target speedTarget, where string) error {
	if resp.StatusCode == http.StatusTooManyRequests {
		return &speedRateLimitError{Label: target.label, Where: where, RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())}
	}
	return &speedHTTPError{Status: resp.StatusCode, Where: where, Label: target.label}
}

// ---------------------------------------------------------------- 上传：只算服务器说收下了的

// patternReader 产生 n 个字节的请求体（Ookla 那头要表单的样子：content1=0123456789…）。
// sent 原子地记已经交给连接的字节：只用来算这次测速用了多少流量，不算速度。
type patternReader struct {
	remaining int64
	offset    int
	prefix    string
	sent      *countingTotal
}

type countingTotal struct {
	mu    sync.Mutex
	total int64
}

func (c *countingTotal) add(n int64) {
	c.mu.Lock()
	c.total += n
	c.mu.Unlock()
}

func (c *countingTotal) get() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}

const uploadDigits = "0123456789"

func (r *patternReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, io.EOF
	}
	n := len(p)
	if int64(n) > r.remaining {
		n = int(r.remaining)
	}
	for i := 0; i < n; i++ {
		if r.offset < len(r.prefix) {
			p[i] = r.prefix[r.offset]
		} else {
			p[i] = uploadDigits[(r.offset-len(r.prefix))%len(uploadDigits)]
		}
		r.offset++
	}
	r.remaining -= int64(n)
	if r.sent != nil {
		r.sent.add(int64(n))
	}
	return n, nil
}

type uploadSpan struct {
	from, to time.Duration // 距这一段开始
	bytes    int64
}

// uploadLedger 记每条流送完的请求（从开始送到收到回应、服务器说收下多少），和每条流手上那一次是哪会儿开始的。
// 一个时刻之前的字节都「定了」：每条流手上那一次都是在它之后才开始的。曲线只画定了的那几格。
type uploadLedger struct {
	mu        sync.Mutex
	spans     []uploadSpan
	inflight  []time.Duration // 每条流手上那一次从哪会儿开始；-1 = 手上没有
	confirmed int64
}

func newUploadLedger(streams int) *uploadLedger {
	l := &uploadLedger{inflight: make([]time.Duration, streams)}
	for i := range l.inflight {
		l.inflight[i] = -1
	}
	return l
}

func (l *uploadLedger) begin(stream int, at time.Duration) {
	l.mu.Lock()
	l.inflight[stream] = at
	l.mu.Unlock()
}

// done 一次请求有了结果：送成了就记下来；没送成（真失败）手上就空了。到点被掐掉的不调它：
// 那一次从开始那会儿起就没定，后面的格子都不算。
func (l *uploadLedger) done(stream int, span *uploadSpan) {
	l.mu.Lock()
	l.inflight[stream] = -1
	if span != nil {
		l.spans = append(l.spans, *span)
		l.confirmed += span.bytes
	}
	l.mu.Unlock()
}

func (l *uploadLedger) settled(now time.Duration) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	settled := now
	for _, at := range l.inflight {
		if at >= 0 && at < settled {
			settled = at
		}
	}
	return settled
}

// firstFrom 第一次送成的那一次是从哪会儿开始送的；还没有 = -1。
func (l *uploadLedger) firstFrom() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	first := time.Duration(-1)
	for _, span := range l.spans {
		if first < 0 || span.from < first {
			first = span.from
		}
	}
	return first
}

// bucketBytes [from, to) 这一格里的字节：每次请求的字节按它从开始到结束的时间均摊。
func (l *uploadLedger) bucketBytes(from, to time.Duration) float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	sum := 0.0
	for _, span := range l.spans {
		if span.to <= from || span.from >= to {
			continue
		}
		length := span.to - span.from
		if length <= 0 {
			sum += float64(span.bytes)
			continue
		}
		overlap := minDuration(span.to, to) - maxDuration(span.from, from)
		sum += float64(span.bytes) * float64(overlap) / float64(length)
	}
	return sum
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

// runUploadPhase 起 streams 条流反复上传；send 送 size 个字节，返回服务器说收下了多少。曲线每格
// speedTestSampleEvery，只画「定了」的格子（会晚一两秒）；先丢掉第一次送成之后的 speedTestWarmup，
// 再量满 duration - warmup。sample(t, mbps) 的 t 是距这一段开始。返回平均速率（Mbit/s）和收下的总字节。
func runUploadPhase(ctx context.Context, duration time.Duration, streams int, maxBytes int64, send func(ctx context.Context, size int64) (int64, error), sample func(at time.Duration, mbps float64)) (float64, int64, error) {
	phaseCtx, cancel := context.WithTimeout(ctx, duration+speedTestMaxExtra)
	defer cancel()
	started := time.Now()
	ledger := newUploadLedger(streams)
	var errMu sync.Mutex
	var firstErr, fatalErr error
	var limitMu sync.Mutex
	limit := maxBytes
	currentMax := func() int64 {
		limitMu.Lock()
		defer limitMu.Unlock()
		return limit
	}
	var wg sync.WaitGroup
	for i := 0; i < streams; i++ {
		wg.Add(1)
		go func(stream int) {
			defer wg.Done()
			size := int64(speedTestUpStartBytes)
			retries := 0
			for phaseCtx.Err() == nil {
				if ceiling := currentMax(); size > ceiling {
					size = ceiling
				}
				at := time.Since(started)
				ledger.begin(stream, at)
				confirmed, err := send(phaseCtx, size)
				end := time.Since(started)
				if err == nil {
					ledger.done(stream, &uploadSpan{from: at, to: end, bytes: confirmed})
					took := end - at
					switch {
					case took < speedTestUpPerRequest/2 && size < currentMax():
						size *= 2
					case took > speedTestUpPerRequest*3 && size > speedTestUpMinBytes:
						size /= 2
					}
					continue
				}
				if phaseCtx.Err() != nil {
					// 到点被我们自己掐掉的：这一次从 at 起就没定，留着 inflight，后面的格子不算。
					return
				}
				ledger.done(stream, nil)
				var rateErr *speedRateLimitError
				var httpErr *speedHTTPError
				switch {
				case errors.As(err, &rateErr) && rateErr.RetryAfter <= speedTestRetryAfterMax && retries < speedTestRetryLimit:
					retries++
					wait := rateErr.RetryAfter
					if wait <= 0 {
						wait = time.Second
					}
					select {
					case <-phaseCtx.Done():
						return
					case <-time.After(wait):
					}
					continue
				case errors.As(err, &httpErr) && httpErr.Status == http.StatusRequestEntityTooLarge:
					// 前面有反代限制了请求体：这一档和更大的都不送了。
					if size <= speedTestUpMinBytes {
						errMu.Lock()
						if fatalErr == nil {
							fatalErr = err
						}
						errMu.Unlock()
						cancel()
						return
					}
					limitMu.Lock()
					if limit >= size {
						limit = size / 2
					}
					limitMu.Unlock()
					size /= 2
					continue
				case errors.As(err, &rateErr) || errors.As(err, &httpErr):
					errMu.Lock()
					if fatalErr == nil {
						fatalErr = err
					}
					errMu.Unlock()
					cancel()
					return
				}
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				errMu.Unlock()
				select {
				case <-phaseCtx.Done():
					return
				case <-time.After(300 * time.Millisecond):
				}
			}
		}(i)
	}

	every := speedTestSampleEvery
	emitted := 0
	var measured []float64
	emit := func(settled time.Duration) {
		first := ledger.firstFrom()
		for {
			from := time.Duration(emitted) * every
			to := from + every
			if to > settled {
				return
			}
			mbps := ledger.bucketBytes(from, to) * 8 / every.Seconds() / 1_000_000
			mbps = math.Round(mbps*10) / 10
			if sample != nil && (first >= 0 && to > first) {
				sample(to, mbps)
			}
			if first >= 0 && from >= first+speedTestWarmup {
				measured = append(measured, mbps)
			}
			emitted++
		}
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-phaseCtx.Done():
			wg.Wait()
			emit(ledger.settled(time.Since(started)))
			errMu.Lock()
			fatal, first := fatalErr, firstErr
			errMu.Unlock()
			if fatal != nil {
				return 0, 0, fmt.Errorf("测速失败：%v", fatal)
			}
			if ctx.Err() != nil {
				return 0, 0, ctx.Err()
			}
			confirmed := ledger.confirmedTotal()
			if confirmed <= 0 {
				if first == nil {
					first = fmt.Errorf("%d 秒里一次 %d KB 都没送完", int((duration + speedTestMaxExtra).Seconds()), speedTestUpStartBytes>>10)
				}
				return 0, 0, fmt.Errorf("上传测不出来：%v", first)
			}
			if len(measured) == 0 {
				// 太慢，过了预热就没有定了的格子：拿送成的那几次整体算。
				return ledger.overallMbps(), confirmed, nil
			}
			return speedSummary(measured), confirmed, nil
		case now := <-ticker.C:
			elapsed := now.Sub(started)
			settled := ledger.settled(elapsed)
			emit(settled)
			first := ledger.firstFrom()
			// 量够了就停：开始满 duration，而且第一次送成以后「定了」的部分也满了 duration。
			if elapsed >= duration && first >= 0 && settled-first >= duration {
				cancel()
			}
		}
	}
}

func (l *uploadLedger) confirmedTotal() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.confirmed
}

// overallMbps 送成的那几次合起来：总字节 / 从第一次开始到最后一次结束。
func (l *uploadLedger) overallMbps() float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.spans) == 0 {
		return 0
	}
	from, to := l.spans[0].from, l.spans[0].to
	var total int64
	for _, span := range l.spans {
		if span.from < from {
			from = span.from
		}
		if span.to > to {
			to = span.to
		}
		total += span.bytes
	}
	if to <= from {
		return 0
	}
	return math.Round(float64(total)*8/(to-from).Seconds()/1_000_000*10) / 10
}
