package main

// 扩展模块 "sitelatency"（2.2.237 起）：概览「出口质量」。面板那头见 server/ops/siteLatency.ts，
// 站点表和样本形状见 shared/siteLatency.ts。
//
// 面板下发站点（host:port）和间隔。每轮先解析、再握手：
//   · TCP 握手做 siteLatencyAttempts 次（间隔 siteLatencyAttemptGap），耗时取连上那几次的中位数，
//     没连上的次数算进丢失 —— 一次握手的抖动不再直接变成卡上的大字。
//   · 第一次连上之后在那条连接上做一次 TLS 握手（SNI = 站点域名），看对方证书是不是这个域名的。
//     DNS 被污染时解析到的是别人的地址，TCP 照样可能几毫秒就通（2.2.237 就因此在上海测出
//     Google 9 ms），只有证书对不上才说明连到的不是它：记 poisoned。TLS 握手被重置 / 没回应
//     （按 SNI 阻断的典型样子）记 blocked。这一轮就算没连上。
//   · 只校验叶证书的域名和有效期，不验证书链：精简系统常没装 CA 包，验链会把整台机器误判成被污染。
// 不发应用层请求。每个站点留最近 siteLatencyKeep 个样本。上报只交面板说它还没有的
// （directive.since 之后的）；面板重启后 since=0，整段两小时一次补齐。
//
// 面板不下发指令（老面板），这个模块什么都不做。

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	siteLatencyDefaultInterval = 2 * time.Minute
	siteLatencyMinInterval     = time.Minute
	siteLatencyKeep            = 60
	siteLatencyMaxTargets      = 8
	siteLatencyResolveTimeout  = 5 * time.Second
	siteLatencyDialTimeout     = 5 * time.Second
	siteLatencyTLSTimeout      = 5 * time.Second
	siteLatencyAttempts        = 3
	siteLatencyAttemptGap      = 200 * time.Millisecond
)

type siteLatencyTarget struct {
	Key  string `json:"key"`
	Host string `json:"host"`
	Port int    `json:"port"`
	// 要不要在 TCP 之后再做 TLS 校验证书；面板没说（老面板）就按端口：443 做。
	TLS *bool `json:"tls,omitempty"`
}

type siteLatencyDirective struct {
	IntervalSeconds int                 `json:"intervalSeconds"`
	Targets         []siteLatencyTarget `json:"targets"`
	// 面板手里最新一个样本的时刻（Unix 毫秒）；只上报比它新的。
	Since int64 `json:"since"`
}

type siteLatencySample struct {
	T  int64  `json:"t"`
	Ms int    `json:"ms"`
	F  string `json:"f,omitempty"`
	// 这一轮握了几次、连上几次（2.2.240 起）；老面板不认，照旧只看 ms。
	N int `json:"n,omitempty"`
	K int `json:"k,omitempty"`
}

type siteLatencyReportTarget struct {
	Key     string              `json:"key"`
	Samples []siteLatencySample `json:"samples"`
}

type siteLatencyExtModule struct {
	mu        sync.Mutex
	running   bool
	lastRunAt time.Time
	since     int64
	order     []string
	samples   map[string][]siteLatencySample

	// 测试里替换
	resolve  func(ctx context.Context, host string) (string, error)
	dial     func(ctx context.Context, network, addr string) (net.Conn, error)
	verify   func(ctx context.Context, conn net.Conn, host string) string
	now      func() time.Time
	sleep    func(time.Duration)
	async    bool
	attempts int
}

func newSiteLatencyExtModule() *siteLatencyExtModule {
	dialer := &net.Dialer{}
	return &siteLatencyExtModule{
		samples:  map[string][]siteLatencySample{},
		resolve:  siteLatencyResolve,
		dial:     dialer.DialContext,
		verify:   siteLatencyVerifyTLS,
		now:      time.Now,
		sleep:    time.Sleep,
		async:    true,
		attempts: siteLatencyAttempts,
	}
}

func init() {
	registerExtModule(newSiteLatencyExtModule())
}

func (m *siteLatencyExtModule) Name() string { return "sitelatency" }

// 字面 IP 直接用；域名优先 IPv4（和 net.Dial 的默认一致），没有再用第一个地址。
func siteLatencyResolve(ctx context.Context, host string) (string, error) {
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return ip.String(), nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return "", err
	}
	for _, addr := range addrs {
		if addr.IP.To4() != nil {
			return addr.IP.String(), nil
		}
	}
	if len(addrs) > 0 {
		return addrs[0].IP.String(), nil
	}
	return "", &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func (m *siteLatencyExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]siteLatencyReportTarget, 0, len(m.order))
	for _, key := range m.order {
		fresh := make([]siteLatencySample, 0)
		for _, sample := range m.samples[key] {
			if sample.T > m.since {
				fresh = append(fresh, sample)
			}
		}
		if len(fresh) > 0 {
			out = append(out, siteLatencyReportTarget{Key: key, Samples: fresh})
		}
	}
	if len(out) == 0 {
		return nil
	}
	return map[string]any{"targets": out}
}

func normalizeSiteLatencyTargets(targets []siteLatencyTarget) []siteLatencyTarget {
	out := make([]siteLatencyTarget, 0, len(targets))
	seen := map[string]bool{}
	for _, target := range targets {
		key := strings.TrimSpace(target.Key)
		host := strings.TrimSpace(target.Host)
		if key == "" || host == "" || seen[key] || target.Port <= 0 || target.Port > 65535 {
			continue
		}
		seen[key] = true
		out = append(out, siteLatencyTarget{Key: key, Host: host, Port: target.Port, TLS: target.TLS})
		if len(out) >= siteLatencyMaxTargets {
			break
		}
	}
	return out
}

func (m *siteLatencyExtModule) Apply(cfg Config, raw json.RawMessage) {
	var d siteLatencyDirective
	if err := json.Unmarshal(raw, &d); err != nil {
		return
	}
	targets := normalizeSiteLatencyTargets(d.Targets)
	interval := time.Duration(d.IntervalSeconds) * time.Second
	if interval <= 0 {
		interval = siteLatencyDefaultInterval
	}
	if interval < siteLatencyMinInterval {
		interval = siteLatencyMinInterval
	}
	now := m.now()
	m.mu.Lock()
	m.since = d.Since
	// 站点表换了：不在新表里的样本丢掉，顺序跟着面板。
	order := make([]string, 0, len(targets))
	keep := map[string][]siteLatencySample{}
	for _, target := range targets {
		order = append(order, target.Key)
		keep[target.Key] = m.samples[target.Key]
	}
	m.order = order
	m.samples = keep
	if m.running || len(targets) == 0 || (!m.lastRunAt.IsZero() && now.Sub(m.lastRunAt) < interval) {
		m.mu.Unlock()
		return
	}
	m.running = true
	m.lastRunAt = now
	m.mu.Unlock()

	run := func() {
		results := m.measure(targets)
		m.mu.Lock()
		for i, target := range targets {
			list, ok := m.samples[target.Key]
			if !ok && !containsString(m.order, target.Key) {
				continue // 测的时候站点表又换了
			}
			list = append(list, results[i])
			if len(list) > siteLatencyKeep {
				list = list[len(list)-siteLatencyKeep:]
			}
			m.samples[target.Key] = list
		}
		m.running = false
		m.mu.Unlock()
	}
	if m.async {
		go func() {
			defer func() {
				if r := recover(); r != nil {
					logf("sitelatency panic: %v", r)
					m.mu.Lock()
					m.running = false
					m.mu.Unlock()
				}
			}()
			run()
		}()
		return
	}
	run()
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// 各站点并行测；样本时刻取这一轮开始的时刻，同一轮几个站点对得齐。
func (m *siteLatencyExtModule) measure(targets []siteLatencyTarget) []siteLatencySample {
	at := m.now().UnixMilli()
	results := make([]siteLatencySample, len(targets))
	var wg sync.WaitGroup
	for i, target := range targets {
		wg.Add(1)
		go func(i int, target siteLatencyTarget) {
			defer wg.Done()
			results[i] = m.measureOne(target, at)
		}(i, target)
	}
	wg.Wait()
	return results
}

func (target siteLatencyTarget) wantsTLS() bool {
	if net.ParseIP(strings.Trim(target.Host, "[]")) != nil {
		return false // 字面 IP 没有域名可校验
	}
	if target.TLS != nil {
		return *target.TLS
	}
	return target.Port == 443
}

func (m *siteLatencyExtModule) measureOne(target siteLatencyTarget, at int64) siteLatencySample {
	attempts := m.attempts
	if attempts <= 0 {
		attempts = 1
	}
	resolveCtx, cancelResolve := context.WithTimeout(context.Background(), siteLatencyResolveTimeout)
	ip, err := m.resolve(resolveCtx, target.Host)
	cancelResolve()
	if err != nil {
		return siteLatencySample{T: at, Ms: -1, F: "dns", N: attempts}
	}
	address := net.JoinHostPort(ip, strconv.Itoa(target.Port))
	needTLS := target.wantsTLS()
	verified := !needTLS
	var times []int
	failure := ""
	for i := 0; i < attempts; i++ {
		if i > 0 && m.sleep != nil {
			m.sleep(siteLatencyAttemptGap)
		}
		dialCtx, cancelDial := context.WithTimeout(context.Background(), siteLatencyDialTimeout)
		started := time.Now()
		conn, err := m.dial(dialCtx, "tcp", address)
		elapsed := time.Since(started)
		cancelDial()
		if err != nil {
			failure = worseProbeFailure(failure, classifyProbeDialError(err))
			continue
		}
		if !verified {
			tlsCtx, cancelTLS := context.WithTimeout(context.Background(), siteLatencyTLSTimeout)
			kind := m.verify(tlsCtx, conn, target.Host)
			cancelTLS()
			if kind != "" {
				// 连到的不是它，或者被掐了：这一轮的握手耗时都没意义，整轮算没连上。
				_ = conn.Close()
				return siteLatencySample{T: at, Ms: -1, F: kind, N: attempts}
			}
			verified = true
		}
		_ = conn.Close()
		ms := int(elapsed.Round(time.Millisecond) / time.Millisecond)
		if ms < 1 {
			ms = 1
		}
		times = append(times, ms)
	}
	if len(times) == 0 {
		if failure == "" {
			failure = "error"
		}
		return siteLatencySample{T: at, Ms: -1, F: failure, N: attempts}
	}
	return siteLatencySample{T: at, Ms: siteLatencyMedian(times), N: attempts, K: len(times)}
}

func siteLatencyMedian(values []int) int {
	sorted := append([]int(nil), values...)
	sort.Ints(sorted)
	middle := len(sorted) / 2
	if len(sorted)%2 == 0 {
		return (sorted[middle-1] + sorted[middle] + 1) / 2
	}
	return sorted[middle]
}

// siteLatencyVerifyTLS 在已连上的 TCP 上做一次 TLS 握手，返回空串 = 对方确实是这个域名。
//   - 证书不是这个域名的 / 已过期 / 对方不是 TLS 服务或直接回告警 → "poisoned"：连到的不是它。
//   - 握手被重置、对方关连接、没回应 → "blocked"：按 SNI 阻断的典型样子。
func siteLatencyVerifyTLS(ctx context.Context, conn net.Conn, host string) string {
	client := tls.Client(conn, &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: true, // 链不验（见文件头），下面自己验域名和有效期
		MinVersion:         tls.VersionTLS12,
	})
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if err := client.HandshakeContext(ctx); err != nil {
		return classifySiteLatencyTLSError(err)
	}
	certs := client.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return "poisoned"
	}
	leaf := certs[0]
	if err := leaf.VerifyHostname(host); err != nil {
		return "poisoned"
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
		return "poisoned"
	}
	return ""
}

func classifySiteLatencyTLSError(err error) string {
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.EPIPE) {
		return "blocked"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "blocked"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "blocked"
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "connection reset") || strings.Contains(msg, "broken pipe") {
		return "blocked"
	}
	// 告警、不是 TLS 记录、协议版本对不上：对面是个别的服务，不是这个站点。
	return "poisoned"
}
