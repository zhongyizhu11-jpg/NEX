package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

/*
URL 连接检测（2.2.253 起）：探测服务的第三种方式，面板在 hostProbeServices 里带 method = "http"。
面板那头见 shared/hostProbeService.ts。

一次探测 = 对这个 http:// 或 https:// 地址发一次 GET：
  - 每次新建连接（不复用、不走连接池），所以量到的是「从这台机器新连上去要多久」；
  - 延迟 = 开始建 TCP 连接 → 收到响应的第一个字节（含 TLS 握手，不含 DNS 解析、不含下载响应体）；
  - 不跟随跳转：301 / 302 就是它的状态码，要不要算通由「预期状态码」决定；
  - 响应体一个字节都不读，拿到响应头就关连接；响应头最多收 64KB；
  - 证书不对算失败（tls），除非这条服务带了 insecureSkipVerify；
  - 状态码不在预期里算失败（http_status），和连不上、超时分开报 —— 前者是对端应用的事，后者才是链路的事。

安全上：URL 是管理员在面板填的，这里仍然只认 http / https、不认内嵌账号密码；请求用单独新建的 Transport，
不经过系统代理和管理流量代理，不带面板地址、Agent Token 或任何认证头，只有一个 User-Agent。
URL 可能带密钥，所以不写进日志，也不随结果报回面板（面板靠下发的 probeKey 认这条结果）。

为什么不和 Ping / TCPing 一起在 collectTCPing 那一轮里跑：那一轮要等所有任务做完才放下一轮
（tcpingCollectRunning），一条超时设成 30 秒的 URL 会把规则、隧道、转发组的健康探测一起拖 30 秒。
所以 URL 检测在自己的协程里跑、自己上报；什么时候该跑也自己记（每条服务按自己的间隔），
不像 Ping / TCPing 那样每一轮都测 —— 对一个 HTTP 服务每 5 秒发一次请求和发一个 SYN 不是一回事。
*/

const (
	urlProbeMaxURLLength          = 2048
	urlProbeDefaultTimeoutSeconds = 5
	urlProbeMaxTimeoutSeconds     = 30
	urlProbeDefaultExpectStatus   = "200-399"
	urlProbeMaxStatusRanges       = 16
	urlProbeMaxHeaderBytes        = 64 * 1024
	// 同时在跑的 URL 检测最多这么多条；一轮最多挑这么多条，剩下的下一轮接着挑（没跑过、最久没跑的优先）
	urlProbeMaxConcurrency = 8
	urlProbeMaxPerCycle    = 64
)

// urlProbeTask 是一条要跑的 URL 检测。全是可比较的字段：调度拿它判断「这条服务的配置变了没有」。
type urlProbeTask struct {
	ServiceID          int
	URL                string
	IntervalSeconds    int
	TimeoutSeconds     int
	ExpectStatus       string
	InsecureSkipVerify bool
	Family             string
	ProbeKey           string
}

func isURLProbeMethod(method string) bool {
	switch strings.ToLower(strings.TrimSpace(method)) {
	case "http", "https", "url":
		return true
	}
	return false
}

func buildURLProbeTasks(probes []hostProbeServiceProbe) []urlProbeTask {
	tasks := make([]urlProbeTask, 0)
	seen := map[int]bool{}
	for _, probe := range probes {
		if probe.ServiceID <= 0 || !isURLProbeMethod(probe.Method) || strings.TrimSpace(probe.TargetIP) == "" || seen[probe.ServiceID] {
			continue
		}
		seen[probe.ServiceID] = true
		tasks = append(tasks, urlProbeTask{
			ServiceID:          probe.ServiceID,
			URL:                strings.TrimSpace(probe.TargetIP),
			IntervalSeconds:    probe.IntervalSeconds,
			TimeoutSeconds:     probe.TimeoutSeconds,
			ExpectStatus:       strings.TrimSpace(probe.ExpectStatus),
			InsecureSkipVerify: probe.InsecureSkipVerify,
			Family:             normalizeProbeFamily(probe.Family),
			ProbeKey:           strings.TrimSpace(probe.ProbeKey),
		})
	}
	return tasks
}

// parseURLProbeTarget 只放行 http / https 的绝对地址：别的协议（file、ftp、gopher…）、内嵌账号密码、
// 带空白或控制字符的一律不测。
func parseURLProbeTarget(raw string) (*url.URL, bool) {
	if raw == "" || len(raw) > urlProbeMaxURLLength {
		return nil, false
	}
	if strings.ContainsRune(raw, '\\') || strings.IndexFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return nil, false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil {
		return nil, false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if (scheme != "http" && scheme != "https") || parsed.Hostname() == "" || parsed.User != nil || parsed.Opaque != "" {
		return nil, false
	}
	return parsed, true
}

type urlProbeStatusRange struct {
	from int
	to   int
}

// parseURLProbeStatusRanges 解析预期状态码：逗号或空白分开的单个状态码（200）或区间（200-399）。
// 空 = 默认的 200-399。写法不对返回 false —— 这条服务记不通，而不是悄悄按默认放行。
func parseURLProbeStatusRanges(spec string) ([]urlProbeStatusRange, bool) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		spec = urlProbeDefaultExpectStatus
	}
	tokens := strings.FieldsFunc(spec, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
	if len(tokens) == 0 || len(tokens) > urlProbeMaxStatusRanges {
		return nil, false
	}
	ranges := make([]urlProbeStatusRange, 0, len(tokens))
	for _, token := range tokens {
		fromText, toText, isRange := strings.Cut(token, "-")
		if !isRange {
			toText = fromText
		}
		from, errFrom := strconv.Atoi(fromText)
		to, errTo := strconv.Atoi(toText)
		if errFrom != nil || errTo != nil || from < 100 || to > 599 || from > to {
			return nil, false
		}
		ranges = append(ranges, urlProbeStatusRange{from: from, to: to})
	}
	return ranges, true
}

func urlProbeStatusExpected(ranges []urlProbeStatusRange, status int) bool {
	for _, item := range ranges {
		if status >= item.from && status <= item.to {
			return true
		}
	}
	return false
}

func urlProbeTimeout(seconds int) time.Duration {
	if seconds <= 0 {
		seconds = urlProbeDefaultTimeoutSeconds
	}
	if seconds > urlProbeMaxTimeoutSeconds {
		seconds = urlProbeMaxTimeoutSeconds
	}
	return time.Duration(seconds) * time.Second
}

// 指定了地址族就只用那一族去连（和探测服务的 family 同一个意思，见 probe_family.go）。
// 这里不能像 TCPing 那样先把域名换成 IP 再测：HTTPS 的证书校验和 Host 头都要原来的域名。
func urlProbeDialNetwork(family string) string {
	switch normalizeProbeFamily(family) {
	case "ipv4":
		return "tcp4"
	case "ipv6":
		return "tcp6"
	}
	return "tcp"
}

func isURLProbeTLSError(err error) bool {
	var verification *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var invalid x509.CertificateInvalidError
	var hostname x509.HostnameError
	var recordHeader tls.RecordHeaderError
	var alert tls.AlertError
	if errors.As(err, &verification) || errors.As(err, &unknownAuthority) || errors.As(err, &invalid) ||
		errors.As(err, &hostname) || errors.As(err, &recordHeader) || errors.As(err, &alert) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "x509:") || strings.Contains(message, "tls:") ||
		strings.Contains(message, "http response to https client")
}

// classifyURLProbeError 把一次请求的错误归成面板认识的失败种类。超时放最前：握手握到一半超时也是超时。
func classifyURLProbeError(err error) string {
	if err == nil {
		return ""
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return "timeout"
	}
	if isURLProbeTLSError(err) {
		return "tls"
	}
	return classifyProbeDialError(err)
}

// runURLProbe 跑一次 URL 连接检测。
func runURLProbe(task urlProbeTask) probeMeasurement {
	result := probeMeasurement{ProbeCount: 1}
	_, targetOK := parseURLProbeTarget(task.URL)
	ranges, rangesOK := parseURLProbeStatusRanges(task.ExpectStatus)
	if !targetOK || !rangesOK {
		result.Detail = "URL 连接检测的配置不对"
		result.Failure = "error"
		return result
	}
	timeout := urlProbeTimeout(task.TimeoutSeconds)
	// 整次探测（解析、建连、握手、等响应头）共用这一个期限
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	started := time.Now()
	// 都存「距 started 的纳秒数 + 1」，0 表示还没发生
	var connectStart, firstByte atomic.Int64
	mark := func(slot *atomic.Int64) { slot.CompareAndSwap(0, time.Since(started).Nanoseconds()+1) }

	dialer := &net.Dialer{Timeout: timeout}
	network := urlProbeDialNetwork(task.Family)
	transport := &http.Transport{
		// 不走 HTTP_PROXY 之类的环境代理，也不走管理流量代理：量的是这台机器自己的出口
		Proxy: nil,
		DialContext: func(ctx context.Context, _ string, addr string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, addr)
		},
		TLSClientConfig:        &tls.Config{InsecureSkipVerify: task.InsecureSkipVerify},
		DisableKeepAlives:      true,
		DisableCompression:     true,
		TLSHandshakeTimeout:    timeout,
		ResponseHeaderTimeout:  timeout,
		MaxResponseHeaderBytes: urlProbeMaxHeaderBytes,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		// 不跟随跳转：3xx 原样当作这次的状态码
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	trace := &httptrace.ClientTrace{
		// 双栈域名会同时试几个地址，取最早开始的那一次
		ConnectStart:         func(string, string) { mark(&connectStart) },
		GotFirstResponseByte: func() { mark(&firstByte) },
	}
	request, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodGet, task.URL, nil)
	if err != nil {
		result.Detail = "URL 连接检测的配置不对"
		result.Failure = "error"
		return result
	}
	request.Close = true
	request.Header.Set("User-Agent", "NEX-Agent/"+Version)
	request.Header.Set("Accept", "*/*")

	response, err := client.Do(request)
	if err != nil {
		// 错误文本里带着 URL（url.Error），不往 Detail / 日志里放
		result.Failure = classifyURLProbeError(err)
		result.Detail = "URL 连接失败"
		return result
	}
	// 响应体不读：要的只是「回了没有、回的什么状态码」
	_ = response.Body.Close()
	result.HTTPStatus = response.StatusCode
	if !urlProbeStatusExpected(ranges, response.StatusCode) {
		result.Failure = "http_status"
		result.Detail = fmt.Sprintf("HTTP 状态码 %d 不在预期里", response.StatusCode)
		return result
	}
	end := firstByte.Load()
	if end <= 0 {
		end = time.Since(started).Nanoseconds() + 1
	}
	begin := connectStart.Load()
	if begin <= 0 || begin > end {
		// 没拿到建连开始的时刻（不该发生）：退回从发起请求算
		begin = 1
	}
	result.LatencyMs = int(time.Duration(end - begin).Milliseconds())
	if result.LatencyMs < 1 {
		result.LatencyMs = 1
	}
	result.Reachable = true
	result.ProbeSuccesses = 1
	return result
}

// urlProbeResultPayload 是报给面板的一条结果（/api/agent/tcping 的 services 里的一项）。
// 不带 targetIp：URL 不回传，面板拿 probeKey 核对这是不是当前这份配置的结果。
func urlProbeResultPayload(task urlProbeTask, measurement probeMeasurement) map[string]any {
	payload := map[string]any{
		"serviceId":  task.ServiceID,
		"method":     "http",
		"probeCount": 1,
	}
	if task.ProbeKey != "" {
		payload["probeKey"] = task.ProbeKey
	}
	if measurement.HTTPStatus > 0 {
		payload["httpStatus"] = measurement.HTTPStatus
	}
	if measurement.Reachable && measurement.ProbeSuccesses > 0 {
		payload["probeSuccesses"] = 1
		payload["latencyMs"] = measurement.LatencyMs
		payload["isTimeout"] = false
		return payload
	}
	payload["probeSuccesses"] = 0
	payload["latencyMs"] = 0
	payload["isTimeout"] = true
	failure := measurement.Failure
	if failure == "" {
		failure = "error"
	}
	payload["failure"] = failure
	return payload
}

type urlProbeRun struct {
	task    urlProbeTask
	at      time.Time
	running bool
}

// urlProbeSchedule 记每条 URL 检测上次什么时候跑的、是不是还在跑。
type urlProbeSchedule struct {
	mu   sync.Mutex
	runs map[int]urlProbeRun
}

var (
	agentURLProbeSchedule = &urlProbeSchedule{}
	urlProbeSlots         = make(chan struct{}, urlProbeMaxConcurrency)
)

func urlProbeInterval(task urlProbeTask) time.Duration {
	seconds := task.IntervalSeconds
	if seconds <= 0 {
		seconds = 30
	}
	if seconds < 5 {
		seconds = 5
	}
	return time.Duration(seconds) * time.Second
}

// 探测那一轮的间隔带 ±10% 的抖动、还按 5 秒一格对齐，所以「到点」留 15% 的余量（至少 1 秒），
// 不然间隔 30 秒的服务赶上 29 秒那一轮会被跳过，实际变成 60 秒一次。
func urlProbeDue(run urlProbeRun, task urlProbeTask, now time.Time) bool {
	if run.task != task {
		// 配置变了（换了地址、超时、预期状态码…）：马上按新的测一次
		return true
	}
	interval := urlProbeInterval(task)
	slack := interval * 15 / 100
	if slack < time.Second {
		slack = time.Second
	}
	return now.Sub(run.at) >= interval-slack
}

// take 挑出这一轮该跑的：没跑过的、配置变了的、到点的；还在跑的不重复起。同时把它们记成「在跑」。
func (s *urlProbeSchedule) take(tasks []urlProbeTask, now time.Time) []urlProbeTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runs == nil {
		s.runs = map[int]urlProbeRun{}
	}
	active := make(map[int]bool, len(tasks))
	for _, task := range tasks {
		active[task.ServiceID] = true
	}
	// 删掉、停用的服务不留记录（还在跑的等它跑完，finish 之后下一轮清）
	for id, run := range s.runs {
		if !active[id] && !run.running {
			delete(s.runs, id)
		}
	}
	type candidate struct {
		task urlProbeTask
		last time.Time
	}
	candidates := make([]candidate, 0, len(tasks))
	for _, task := range tasks {
		run, found := s.runs[task.ServiceID]
		if found && run.running {
			continue
		}
		if !found {
			candidates = append(candidates, candidate{task: task})
			continue
		}
		if urlProbeDue(run, task, now) {
			candidates = append(candidates, candidate{task: task, last: run.at})
		}
	}
	// 一轮挑不完时，没跑过的、最久没跑的排前面，不让排在后面的服务一直轮不到
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].last.Before(candidates[j].last) })
	if len(candidates) > urlProbeMaxPerCycle {
		candidates = candidates[:urlProbeMaxPerCycle]
	}
	selected := make([]urlProbeTask, 0, len(candidates))
	for _, item := range candidates {
		s.runs[item.task.ServiceID] = urlProbeRun{task: item.task, at: now, running: true}
		selected = append(selected, item.task)
	}
	return selected
}

func (s *urlProbeSchedule) finish(serviceID int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run, found := s.runs[serviceID]; found {
		run.running = false
		s.runs[serviceID] = run
	}
}

// dispatchURLProbes 由每一轮探测调用：挑出该跑的 URL 检测，交给后台协程，自己马上返回。
func dispatchURLProbes(cfg Config, probes []hostProbeServiceProbe) {
	selected := agentURLProbeSchedule.take(buildURLProbeTasks(probes), time.Now())
	if len(selected) == 0 {
		return
	}
	go runURLProbeBatch(agentURLProbeSchedule, selected, runURLProbe, func(services []map[string]any) {
		reportURLProbeResults(cfg, services)
	})
}

// runURLProbeBatch 按 urlProbeMaxConcurrency 一组跑完、一组报一次：一条慢的最多拖住同组的几条，不拖后面的组。
func runURLProbeBatch(schedule *urlProbeSchedule, tasks []urlProbeTask, probe func(urlProbeTask) probeMeasurement, report func([]map[string]any)) {
	for start := 0; start < len(tasks); start += urlProbeMaxConcurrency {
		end := start + urlProbeMaxConcurrency
		if end > len(tasks) {
			end = len(tasks)
		}
		group := tasks[start:end]
		results := make([]map[string]any, len(group))
		var wg sync.WaitGroup
		for index, task := range group {
			wg.Add(1)
			go func(index int, task urlProbeTask) {
				defer wg.Done()
				defer schedule.finish(task.ServiceID)
				// 几批同时在跑时（上一批还没完下一轮又到了），总并发也不超过 urlProbeMaxConcurrency
				urlProbeSlots <- struct{}{}
				defer func() { <-urlProbeSlots }()
				results[index] = urlProbeResultPayload(task, safeURLProbe(probe, task))
			}(index, task)
		}
		wg.Wait()
		report(results)
	}
}

// 探测里 panic 不能带走整个 Agent：记成这一次不通。
func safeURLProbe(probe func(urlProbeTask) probeMeasurement, task urlProbeTask) (measurement probeMeasurement) {
	defer func() {
		if recovered := recover(); recovered != nil {
			logf("url probe panic service=%d: %v", task.ServiceID, recovered)
			measurement = probeMeasurement{ProbeCount: 1, Failure: "error"}
		}
	}()
	return probe(task)
}

func reportURLProbeResults(cfg Config, services []map[string]any) {
	if len(services) == 0 {
		return
	}
	// 和 collectTCPing 用同一个上报接口，只是这一份只有 services
	payload := map[string]any{
		"results":       []map[string]any{},
		"tunnels":       []map[string]any{},
		"forwardGroups": []map[string]any{},
		"services":      services,
		"force":         false,
	}
	if err := post(cfg, "/api/agent/tcping", payload, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("url-probe-report", err)
		} else if shouldLogAgentReport("url-probe-report-failed", agentReportLogInterval) {
			logf("url probe report failed services=%d: %v", len(services), err)
		}
	}
}
