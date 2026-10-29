package main

// 扩展模块 "sitelatency"（2.2.237 起）：概览「出口质量」。面板那头见 server/ops/siteLatency.ts，
// 站点表和样本形状见 shared/siteLatency.ts。
//
// 面板下发站点（host:port）和间隔。每轮先解析、再单独计时 TCP 握手（DNS 不算进耗时），
// 只握手、不发应用层请求。每个站点留最近 siteLatencyKeep 个样本。上报只交面板说它还没有的
// （directive.since 之后的）；面板重启后 since=0，整段两小时一次补齐。
//
// 面板不下发指令（老面板），这个模块什么都不做。

import (
	"context"
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	siteLatencyDefaultInterval = 2 * time.Minute
	siteLatencyMinInterval     = time.Minute
	siteLatencyKeep            = 60
	siteLatencyMaxTargets      = 8
	siteLatencyResolveTimeout  = 5 * time.Second
	siteLatencyDialTimeout     = 5 * time.Second
)

type siteLatencyTarget struct {
	Key  string `json:"key"`
	Host string `json:"host"`
	Port int    `json:"port"`
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
	resolve func(ctx context.Context, host string) (string, error)
	dial    func(ctx context.Context, network, addr string) (net.Conn, error)
	now     func() time.Time
	async   bool
}

func newSiteLatencyExtModule() *siteLatencyExtModule {
	dialer := &net.Dialer{}
	return &siteLatencyExtModule{
		samples: map[string][]siteLatencySample{},
		resolve: siteLatencyResolve,
		dial:    dialer.DialContext,
		now:     time.Now,
		async:   true,
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
		out = append(out, siteLatencyTarget{Key: key, Host: host, Port: target.Port})
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

func (m *siteLatencyExtModule) measureOne(target siteLatencyTarget, at int64) siteLatencySample {
	resolveCtx, cancelResolve := context.WithTimeout(context.Background(), siteLatencyResolveTimeout)
	ip, err := m.resolve(resolveCtx, target.Host)
	cancelResolve()
	if err != nil {
		return siteLatencySample{T: at, Ms: -1, F: "dns"}
	}
	dialCtx, cancelDial := context.WithTimeout(context.Background(), siteLatencyDialTimeout)
	defer cancelDial()
	started := time.Now()
	conn, err := m.dial(dialCtx, "tcp", net.JoinHostPort(ip, strconv.Itoa(target.Port)))
	elapsed := time.Since(started)
	if err != nil {
		return siteLatencySample{T: at, Ms: -1, F: classifyProbeDialError(err)}
	}
	_ = conn.Close()
	ms := int(elapsed.Round(time.Millisecond) / time.Millisecond)
	if ms < 1 {
		ms = 1
	}
	return siteLatencySample{T: at, Ms: ms}
}
