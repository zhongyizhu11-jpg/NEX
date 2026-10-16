package main

// 扩展模块 "netprofile"（2.2.225 起）：主机网络画像。面板那头见 server/ops/netProfile.ts，
// 报告的形状和 DNSBL 应答的读法见 shared/netProfile.ts。
//
// 每 6 小时（或面板发来新的 runId 时）在后台测一轮：
//
//   - IPv4 / IPv6 出站：强制 tcp4 / tcp6 去 GET 一个「回显我的 IP」的地址，记下地址和耗时；
//     另外看本机网卡上有没有全局单播 IPv6。
//   - 25 端口出站：连几台大邮箱的 MX 的 25 端口（5 秒超时），读一行欢迎语就 QUIT，
//     不发任何邮件命令。
//   - DNSBL：用本机的系统解析器查公网 IPv4 反写后的名字。原始应答一起上报，面板会按
//     自己的规则重新解读（Spamhaus 对公共解析器回 127.255.255.254，那不是「被列入」）。
//
// 结果先留在内存里，每轮上报，直到指令里的回执（ackResultId，或 lastCheckedAt 追上它）说
// 面板存好了才丢掉，一次上报失败不会把结果弄丢。

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	netProfileDefaultInterval = 6 * time.Hour
	netProfileMinInterval     = 10 * time.Minute
	netProfileHTTPTimeout     = 8 * time.Second
	netProfileSMTPTimeout     = 5 * time.Second
	netProfileDNSBLTimeout    = 5 * time.Second
)

var (
	netProfileDefaultDNSBL       = []string{"zen.spamhaus.org", "bl.spamcop.net", "b.barracudacentral.org", "cbl.abuseat.org"}
	netProfileDefaultSMTPTargets = []string{"gmail-smtp-in.l.google.com:25", "mx1.mail.icloud.com:25", "alt1.aspmx.l.google.com:25"}
	netProfileDefaultIPv4URLs    = []string{"https://ipv4.icanhazip.com", "https://api.ipify.org"}
	netProfileDefaultIPv6URLs    = []string{"https://ipv6.icanhazip.com", "https://api6.ipify.org"}
)

type netProfileDirective struct {
	IntervalSeconds int      `json:"intervalSeconds"`
	LastCheckedAt   int64    `json:"lastCheckedAt"`
	AckResultID     string   `json:"ackResultId"`
	RunID           string   `json:"runId"`
	DNSBL           []string `json:"dnsbl"`
	SMTPTargets     []string `json:"smtpTargets"`
	IPv4URLs        []string `json:"ipv4Urls"`
	IPv6URLs        []string `json:"ipv6Urls"`
}

type netProfileFamily struct {
	OK         bool   `json:"ok"`
	Address    string `json:"address,omitempty"`
	LatencyMs  int64  `json:"latencyMs,omitempty"`
	Error      string `json:"error,omitempty"`
	Configured *bool  `json:"configured,omitempty"`
}

type netProfileSMTPTarget struct {
	Target string `json:"target"`
	Status string `json:"status"` // open / refused / timeout / error
	Detail string `json:"detail,omitempty"`
}

type netProfileSMTP struct {
	Status  string                 `json:"status"` // open / blocked / timeout
	Detail  string                 `json:"detail,omitempty"`
	Targets []netProfileSMTPTarget `json:"targets"`
}

type netProfileDNSBLEntry struct {
	List     string   `json:"list"`
	Listed   bool     `json:"listed"`
	Code     string   `json:"code,omitempty"`
	Error    string   `json:"error,omitempty"`
	Answers  []string `json:"answers"`
	NotFound bool     `json:"notFound"`
}

type netProfileResult struct {
	ResultID     string                 `json:"resultId"`
	CheckedAt    int64                  `json:"checkedAt"`
	DurationMs   int64                  `json:"durationMs"`
	IPv4         netProfileFamily       `json:"ipv4"`
	IPv6         netProfileFamily       `json:"ipv6"`
	SMTP25       netProfileSMTP         `json:"smtp25"`
	DNSBL        []netProfileDNSBLEntry `json:"dnsbl"`
	DNSBLAddress string                 `json:"dnsblAddress,omitempty"`
	RunID        string                 `json:"-"`
}

type netProfileExtModule struct {
	mu        sync.Mutex
	running   bool
	runningID string
	lastRunAt time.Time
	lastRunID string
	pending   *netProfileResult

	// 测试里替换
	httpGet       func(ctx context.Context, network, url string) (string, error)
	dial          func(ctx context.Context, network, addr string) (net.Conn, error)
	lookupHost    func(ctx context.Context, name string) ([]string, error)
	hasGlobalIPv6 func() bool
	fallbackIPv4  func() string
	now           func() time.Time
	async         bool
}

func newNetProfileExtModule() *netProfileExtModule {
	dialer := &net.Dialer{}
	return &netProfileExtModule{
		httpGet:       netProfileHTTPGet,
		dial:          dialer.DialContext,
		lookupHost:    net.DefaultResolver.LookupHost,
		hasGlobalIPv6: netProfileHasGlobalIPv6,
		fallbackIPv4: func() string {
			ipv4, _ := publicIPs()
			return ipv4
		},
		now:   time.Now,
		async: true,
	}
}

func init() {
	registerExtModule(newNetProfileExtModule())
}

func (m *netProfileExtModule) Name() string { return "netprofile" }

func (m *netProfileExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pending != nil {
		return map[string]any{"runId": m.pending.RunID, "result": m.pending}
	}
	if m.running {
		return map[string]any{"runId": m.runningID, "running": true}
	}
	return nil
}

func (m *netProfileExtModule) Apply(cfg Config, raw json.RawMessage) {
	var d netProfileDirective
	if err := json.Unmarshal(raw, &d); err != nil {
		return
	}
	interval := time.Duration(d.IntervalSeconds) * time.Second
	if interval <= 0 {
		interval = netProfileDefaultInterval
	}
	if interval < netProfileMinInterval {
		interval = netProfileMinInterval
	}
	now := m.now()
	m.mu.Lock()
	// 面板已经存下了（回执里是这份的 resultId，或者面板存的检测时间不早于它）：丢掉手里那份
	if m.pending != nil && ((d.AckResultID != "" && d.AckResultID == m.pending.ResultID) ||
		(d.LastCheckedAt > 0 && m.pending.CheckedAt <= d.LastCheckedAt)) {
		m.pending = nil
	}
	if m.running {
		m.mu.Unlock()
		return
	}
	base := m.lastRunAt
	if d.LastCheckedAt > 0 {
		if panelAt := time.Unix(d.LastCheckedAt, 0); panelAt.After(base) {
			base = panelAt
		}
	}
	requested := d.RunID != "" && d.RunID != m.lastRunID
	due := base.IsZero() || now.Sub(base) >= interval
	if !requested && !due {
		m.mu.Unlock()
		return
	}
	m.running = true
	m.runningID = d.RunID
	if d.RunID != "" {
		m.lastRunID = d.RunID
	}
	m.lastRunAt = now
	m.mu.Unlock()

	run := func() {
		result := m.runChecks(d)
		result.RunID = d.RunID
		m.mu.Lock()
		m.pending = result
		m.running = false
		m.runningID = ""
		m.mu.Unlock()
		if m.async {
			// 测完马上交，不等下一轮
			wakeAgentExt()
		}
	}
	if m.async {
		go func() {
			defer func() {
				if r := recover(); r != nil {
					logf("netprofile check panic: %v", r)
					m.mu.Lock()
					m.running = false
					m.runningID = ""
					m.mu.Unlock()
				}
			}()
			run()
		}()
		return
	}
	run()
}

func orDefault(values []string, fallback []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if v := strings.TrimSpace(value); v != "" {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return fallback
	}
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}

func (m *netProfileExtModule) runChecks(d netProfileDirective) *netProfileResult {
	started := m.now()
	result := &netProfileResult{}
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		result.IPv4 = m.checkFamily("tcp4", orDefault(d.IPv4URLs, netProfileDefaultIPv4URLs))
	}()
	go func() {
		defer wg.Done()
		result.IPv6 = m.checkFamily("tcp6", orDefault(d.IPv6URLs, netProfileDefaultIPv6URLs))
		configured := m.hasGlobalIPv6()
		result.IPv6.Configured = &configured
	}()
	go func() {
		defer wg.Done()
		result.SMTP25 = m.checkSMTP(orDefault(d.SMTPTargets, netProfileDefaultSMTPTargets))
	}()
	wg.Wait()

	address := ""
	if result.IPv4.OK {
		address = result.IPv4.Address
	} else if m.fallbackIPv4 != nil {
		address = strings.TrimSpace(m.fallbackIPv4())
	}
	if ip := net.ParseIP(address); ip != nil && ip.To4() != nil && !ip.IsPrivate() && !ip.IsLoopback() {
		result.DNSBLAddress = ip.To4().String()
		result.DNSBL = m.checkDNSBL(result.DNSBLAddress, orDefault(d.DNSBL, netProfileDefaultDNSBL))
	} else {
		result.DNSBL = []netProfileDNSBLEntry{}
	}
	finished := m.now()
	result.CheckedAt = finished.Unix()
	result.ResultID = fmt.Sprintf("%x", finished.UnixNano())
	result.DurationMs = finished.Sub(started).Milliseconds()
	return result
}

// ---------------------------------------------------------------- 双栈

func (m *netProfileExtModule) checkFamily(network string, urls []string) netProfileFamily {
	errs := []string{}
	for _, u := range urls {
		ctx, cancel := context.WithTimeout(context.Background(), netProfileHTTPTimeout)
		start := m.now()
		body, err := m.httpGet(ctx, network, u)
		elapsed := m.now().Sub(start)
		cancel()
		if err != nil {
			errs = append(errs, netProfileShortError(err))
			continue
		}
		ip := net.ParseIP(strings.TrimSpace(body))
		if ip == nil || (network == "tcp4") != (ip.To4() != nil) {
			errs = append(errs, fmt.Sprintf("%s 返回的不是 %s 地址", u, map[bool]string{true: "IPv4", false: "IPv6"}[network == "tcp4"]))
			continue
		}
		latency := elapsed.Milliseconds()
		if latency < 1 {
			latency = 1
		}
		return netProfileFamily{OK: true, Address: ip.String(), LatencyMs: latency}
	}
	return netProfileFamily{OK: false, Error: netProfileTruncate(strings.Join(errs, "；"), 300)}
}

// netProfileHTTPGet 强制用一种地址族（tcp4 / tcp6）发请求。不走 HTTP 代理：要测的是这台机器自己的出口。
func netProfileHTTPGet(ctx context.Context, network, url string) (string, error) {
	dialer := &net.Dialer{Timeout: netProfileHTTPTimeout}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, addr)
		},
		TLSHandshakeTimeout: netProfileHTTPTimeout,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
		DisableKeepAlives:   true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: netProfileHTTPTimeout}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "NEX-Agent/"+Version)
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 256))
	if res.StatusCode >= 300 {
		return "", fmt.Errorf("%s HTTP %d", url, res.StatusCode)
	}
	return string(body), nil
}

// netProfileHasGlobalIPv6 看网卡上有没有全局单播 IPv6（不算 fe80::/10 链路本地、fc00::/7 ULA）。
func netProfileHasGlobalIPv6() bool {
	ifaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch value := addr.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if netProfileIsGlobalIPv6(ip) {
				return true
			}
		}
	}
	return false
}

func netProfileIsGlobalIPv6(ip net.IP) bool {
	return ip != nil && ip.To4() == nil && ip.IsGlobalUnicast() && !ip.IsPrivate()
}

// ---------------------------------------------------------------- 25 端口

func (m *netProfileExtModule) checkSMTP(targets []string) netProfileSMTP {
	results := make([]netProfileSMTPTarget, len(targets))
	var wg sync.WaitGroup
	for i, target := range targets {
		wg.Add(1)
		go func(i int, target string) {
			defer wg.Done()
			results[i] = m.probeSMTP(target)
		}(i, target)
	}
	wg.Wait()
	return summarizeSMTP(results)
}

func summarizeSMTP(results []netProfileSMTPTarget) netProfileSMTP {
	out := netProfileSMTP{Targets: results}
	timeouts := 0
	for _, r := range results {
		if r.Status == "open" {
			out.Status = "open"
			out.Detail = netProfileTruncate(r.Target+" "+r.Detail, 300)
			return out
		}
		if r.Status == "timeout" {
			timeouts++
		}
	}
	if len(results) > 0 && timeouts == len(results) {
		out.Status = "timeout"
		out.Detail = fmt.Sprintf("连 %d 台邮件服务器的 25 端口都超时：多半是服务商在出口静默丢弃", len(results))
		return out
	}
	out.Status = "blocked"
	for _, r := range results {
		if r.Status != "timeout" {
			out.Detail = netProfileTruncate(r.Target+" "+r.Detail, 300)
			break
		}
	}
	return out
}

func (m *netProfileExtModule) probeSMTP(target string) netProfileSMTPTarget {
	out := netProfileSMTPTarget{Target: target}
	ctx, cancel := context.WithTimeout(context.Background(), netProfileSMTPTimeout)
	defer cancel()
	conn, err := m.dial(ctx, "tcp", target)
	if err != nil {
		out.Status = classifyDialError(err)
		out.Detail = netProfileShortError(err)
		return out
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(netProfileSMTPTimeout))
	reader := bufio.NewReaderSize(io.LimitReader(conn, 1024), 1024)
	line, readErr := reader.ReadString('\n')
	banner := strings.TrimSpace(line)
	// 只说再见：不发 EHLO / MAIL，不碰任何邮件命令
	_, _ = conn.Write([]byte("QUIT\r\n"))
	out.Status = "open"
	switch {
	case banner != "":
		out.Detail = netProfileTruncate(banner, 160)
	case readErr != nil:
		out.Detail = "已连上，但没读到欢迎语：" + netProfileShortError(readErr)
	default:
		out.Detail = "已连上"
	}
	return out
}

func classifyDialError(err error) string {
	if err == nil {
		return "open"
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return "timeout"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "refused") || strings.Contains(msg, "reset") {
		return "refused"
	}
	return "error"
}

// ---------------------------------------------------------------- DNSBL

func reverseIPv4ForDNSBL(address string) string {
	ip := net.ParseIP(strings.TrimSpace(address))
	if ip == nil || ip.To4() == nil {
		return ""
	}
	v4 := ip.To4()
	return fmt.Sprintf("%d.%d.%d.%d", v4[3], v4[2], v4[1], v4[0])
}

func (m *netProfileExtModule) checkDNSBL(address string, zones []string) []netProfileDNSBLEntry {
	reversed := reverseIPv4ForDNSBL(address)
	entries := make([]netProfileDNSBLEntry, len(zones))
	var wg sync.WaitGroup
	for i, zone := range zones {
		wg.Add(1)
		go func(i int, zone string) {
			defer wg.Done()
			entries[i] = m.queryDNSBL(reversed, strings.TrimSuffix(strings.ToLower(zone), "."))
		}(i, zone)
	}
	wg.Wait()
	return entries
}

func (m *netProfileExtModule) queryDNSBL(reversed, zone string) netProfileDNSBLEntry {
	entry := netProfileDNSBLEntry{List: zone, Answers: []string{}}
	if reversed == "" {
		entry.Error = "不是有效的 IPv4 地址"
		return entry
	}
	ctx, cancel := context.WithTimeout(context.Background(), netProfileDNSBLTimeout)
	defer cancel()
	// 末尾加点：绝对名字，不让系统解析器拼搜索域
	addrs, err := m.lookupHost(ctx, reversed+"."+zone+".")
	if err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			entry.NotFound = true
			return entry
		}
		entry.Error = netProfileShortError(err)
		return entry
	}
	for _, addr := range addrs {
		if len(entry.Answers) >= 16 {
			break
		}
		entry.Answers = append(entry.Answers, strings.TrimSpace(addr))
	}
	interpretDNSBLEntry(&entry)
	return entry
}

// interpretDNSBLEntry 和 shared/netProfile.ts 的 interpretDnsblAnswer 同一套规则（面板以那边为准）。
func interpretDNSBLEntry(entry *netProfileDNSBLEntry) {
	codes := []string{}
	for _, value := range entry.Answers {
		ip := net.ParseIP(value)
		if ip == nil || ip.To4() == nil {
			continue
		}
		v4 := ip.To4()
		if v4[0] == 127 && v4[1] == 255 && v4[2] == 255 {
			entry.Error = "无法查询（公共解析器被拒绝）"
			entry.Listed = false
			entry.Code = ""
			return
		}
		if v4[0] != 127 {
			entry.Error = "解析器返回了异常结果（可能被劫持）"
			entry.Listed = false
			entry.Code = ""
			return
		}
		codes = append(codes, v4.String())
	}
	if len(codes) > 0 {
		entry.Listed = true
		entry.Code = strings.Join(codes, ",")
	}
}

// ---------------------------------------------------------------- 小工具

func netProfileShortError(err error) string {
	if err == nil {
		return ""
	}
	return netProfileTruncate(err.Error(), 200)
}

func netProfileTruncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit > 0 && len(value) > limit {
		cut := value[:limit]
		// 别把一个 UTF-8 字符切成两半
		for len(cut) > 0 && cut[len(cut)-1]&0xC0 == 0x80 {
			cut = cut[:len(cut)-1]
		}
		if len(cut) > 0 && cut[len(cut)-1]&0xC0 == 0xC0 {
			cut = cut[:len(cut)-1]
		}
		return cut + "…"
	}
	return value
}
