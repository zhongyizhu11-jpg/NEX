package main

/*
扩展模块 "realitycheck"（2.2.253 起）：REALITY 伪装目标检查。面板那头见 server/ops/realityCheck.ts，
候选清单和结果形状见 shared/realityDestCheck.ts。

开 VLESS + REALITY 落地入站时，要偷的那个握手目标（dest）必须从这台落地机本身连得上、并且像一个正常的
大站：TLS 1.3、支持 X25519、能协商 h2、证书对得上这个域名。差一样，客户端握手时 REALITY 转发给目标的
那一段就会露馅或者干脆连不上 —— 而面板在自己那台机器上测没有意义（线路、DNS、封锁都不一样），所以让落地机的
Agent 去测。

指令（每轮重发，直到面板收到这个 runId 的 done 结果）：
  runs [{runId, targets: [{dest: "host:port", serverName}]}]
上报：
  runs [{runId, status: running|done, startedAt, finishedAt, results: [...]}]

和 Forwardplus 2.3.283 的「Reality 公网目标检查」同一个口径：每个目标先解析，解析到的地址必须全是公网地址
（不让租户借落地机去探内网 / 云厂商的元数据地址）；再按地址逐个握手，先 TLS 1.2~1.3 + h2/http1.1 看版本、ALPN、
证书，TLS 1.3 的再只给 X25519 握一次。证书用系统根证书验（验不过不算错，只是 certValid=false）。
一次最多 16 个目标、4 个并排，单个目标 8 秒，一轮 60 秒；同一时间只跑一轮。
*/

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	realityCheckResultTTL     = 15 * time.Minute
	realityCheckRunBudget     = 60 * time.Second
	realityCheckTargetTimeout = 8 * time.Second
	realityCheckMaxTargets    = 16
	realityCheckWorkers       = 4
	realityCheckMaxRuns       = 8
	realityCheckMaxAddrs      = 8
)

type realityCheckTarget struct {
	Dest       string `json:"dest"`
	ServerName string `json:"serverName"`
}

type realityCheckRunDirective struct {
	RunID   string               `json:"runId"`
	Targets []realityCheckTarget `json:"targets"`
}

type realityCheckDirective struct {
	Runs []realityCheckRunDirective `json:"runs"`
}

type realityCheckResult struct {
	Dest       string `json:"dest"`
	ServerName string `json:"serverName"`
	ResolvedIP string `json:"resolvedIp,omitempty"`
	Reachable  bool   `json:"reachable"`
	TLS13      bool   `json:"tls13"`
	X25519     bool   `json:"x25519"`
	H2         bool   `json:"h2"`
	CertValid  bool   `json:"certValid"`
	Feasible   bool   `json:"feasible"`
	LatencyMs  int    `json:"latencyMs"`
	// Error 是固定的几个词之一（invalid / blocked / resolve / dial / handshake / timeout），不带对方回的原文。
	Error string `json:"error,omitempty"`
}

type realityCheckRunReport struct {
	RunID      string               `json:"runId"`
	Status     string               `json:"status"`
	StartedAt  int64                `json:"startedAt"`
	FinishedAt int64                `json:"finishedAt,omitempty"`
	Results    []realityCheckResult `json:"results,omitempty"`
}

type realityCheckReport struct {
	Runs []realityCheckRunReport `json:"runs"`
}

type realityCheckExtModule struct {
	mu    sync.Mutex
	runs  map[string]*realityCheckRunReport
	runMu sync.Mutex

	// 测试里替换。
	lookup func(ctx context.Context, host string) ([]netip.Addr, error)
	dial   func(ctx context.Context, network, address string) (net.Conn, error)
	roots  *x509.CertPool
	now    func() time.Time
	wake   func()
}

func newRealityCheckExtModule() *realityCheckExtModule {
	dialer := &net.Dialer{}
	return &realityCheckExtModule{
		runs: map[string]*realityCheckRunReport{},
		lookup: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
		dial: dialer.DialContext,
		now:  time.Now,
		wake: wakeAgentExt,
	}
}

func init() {
	registerExtModule(newRealityCheckExtModule())
}

func (m *realityCheckExtModule) Name() string { return "realitycheck" }

func (m *realityCheckExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := m.now().Add(-realityCheckResultTTL).Unix()
	report := realityCheckReport{}
	for id, run := range m.runs {
		if run.FinishedAt > 0 && run.FinishedAt < cutoff {
			delete(m.runs, id)
			continue
		}
		report.Runs = append(report.Runs, *run)
	}
	if len(report.Runs) == 0 {
		return nil
	}
	sort.Slice(report.Runs, func(i, j int) bool { return report.Runs[i].RunID < report.Runs[j].RunID })
	return report
}

func (m *realityCheckExtModule) Apply(cfg Config, directive json.RawMessage) {
	var d realityCheckDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		logf("realitycheck directive invalid: %v", err)
		return
	}
	for _, run := range d.Runs {
		if opsValidID(run.RunID) && len(run.Targets) > 0 {
			m.start(run.RunID, run.Targets)
		}
	}
}

func (m *realityCheckExtModule) start(runID string, targets []realityCheckTarget) {
	if len(targets) > realityCheckMaxTargets {
		targets = targets[:realityCheckMaxTargets]
	}
	m.mu.Lock()
	if _, exists := m.runs[runID]; exists || len(m.runs) >= realityCheckMaxRuns {
		m.mu.Unlock()
		return
	}
	report := &realityCheckRunReport{RunID: runID, Status: "running", StartedAt: m.now().Unix()}
	m.runs[runID] = report
	m.mu.Unlock()
	go func() {
		results := m.runAll(targets)
		m.mu.Lock()
		report.Results = results
		report.Status = "done"
		report.FinishedAt = m.now().Unix()
		m.mu.Unlock()
		logf("reality check run=%s done targets=%d", runID, len(results))
		if m.wake != nil {
			m.wake()
		}
	}()
}

func (m *realityCheckExtModule) runAll(targets []realityCheckTarget) (results []realityCheckResult) {
	m.runMu.Lock()
	defer m.runMu.Unlock()
	results = make([]realityCheckResult, len(targets))
	defer func() {
		if r := recover(); r != nil {
			logf("reality check panic: %v", r)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), realityCheckRunBudget)
	defer cancel()
	jobs := make(chan int, len(targets))
	for index := range targets {
		jobs <- index
	}
	close(jobs)
	workers := realityCheckWorkers
	if workers > len(targets) {
		workers = len(targets)
	}
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				results[index] = m.checkTarget(ctx, targets[index])
			}
		}()
	}
	wg.Wait()
	return results
}

// realityCheckAddressAllowed：只测公网单播地址。内网、回环、链路本地、CGNAT、文档 / 测试网段、组播、
// 云厂商的元数据地址都不让测 —— 这个检查对能开落地节点的租户开放，不能变成探落地机内网的工具。
func realityCheckAddressAllowed(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || address.Zone() != "" || !address.IsGlobalUnicast() || address.IsPrivate() {
		return false
	}
	for _, prefix := range realityCheckBlockedPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	if address.Is6() && !netip.MustParsePrefix("2000::/3").Contains(address) {
		return false
	}
	return true
}

var realityCheckBlockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("64:ff9b::/96"),
}

// realityCheckHostnameValid：伪装目标必须是域名（REALITY 要拿它当 SNI），不收 IP。
func realityCheckHostnameValid(host string) bool {
	if host == "" || len(host) > 253 || strings.Contains(host, "..") {
		return false
	}
	if _, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, r := range label {
			if !(r == '-' || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')) {
				return false
			}
		}
	}
	return strings.Contains(host, ".")
}

func (m *realityCheckExtModule) checkTarget(parent context.Context, target realityCheckTarget) realityCheckResult {
	started := time.Now()
	dest := strings.ToLower(strings.TrimSpace(target.Dest))
	serverName := strings.ToLower(strings.TrimSpace(target.ServerName))
	result := realityCheckResult{Dest: dest, ServerName: serverName}
	host, rawPort, err := net.SplitHostPort(dest)
	port, portErr := strconv.Atoi(rawPort)
	if serverName == "" {
		serverName = host
		result.ServerName = host
	}
	if err != nil || portErr != nil || port < 1 || port > 65535 || !realityCheckHostnameValid(serverName) {
		result.Error = "invalid"
		return result
	}
	ctx, cancel := context.WithTimeout(parent, realityCheckTargetTimeout)
	defer cancel()
	var addresses []netip.Addr
	if literal, parseErr := netip.ParseAddr(strings.Trim(host, "[]")); parseErr == nil {
		addresses = []netip.Addr{literal}
	} else if realityCheckHostnameValid(host) {
		addresses, err = m.lookup(ctx, host)
		if err != nil || len(addresses) == 0 {
			result.Error = "resolve"
			return finishRealityCheck(result, started, ctx)
		}
	} else {
		result.Error = "invalid"
		return result
	}
	if len(addresses) > realityCheckMaxAddrs {
		addresses = addresses[:realityCheckMaxAddrs]
	}
	// 解析到的地址里只要有一个不是公网就整个不测：DNS 回一个公网一个内网，正是拿来绕检查的做法。
	for _, address := range addresses {
		if !realityCheckAddressAllowed(address) {
			result.Error = "blocked"
			return result
		}
	}
	sort.SliceStable(addresses, func(i, j int) bool { return addresses[i].Is4() && !addresses[j].Is4() })
	var best realityCheckResult
	for _, address := range addresses {
		item := m.probeAddress(ctx, result, address, port, serverName)
		if best.Dest == "" || realityCheckScore(item) > realityCheckScore(best) {
			best = item
		}
		if item.Feasible || ctx.Err() != nil {
			break
		}
	}
	return finishRealityCheck(best, started, ctx)
}

func finishRealityCheck(result realityCheckResult, started time.Time, ctx context.Context) realityCheckResult {
	result.LatencyMs = int(time.Since(started) / time.Millisecond)
	if result.Error == "" && !result.Feasible && ctx.Err() != nil && !result.Reachable {
		result.Error = "timeout"
	}
	return result
}

func realityCheckScore(item realityCheckResult) int {
	score := 0
	for _, ok := range []bool{item.Reachable, item.TLS13, item.X25519, item.H2, item.CertValid} {
		if ok {
			score++
		}
	}
	return score
}

func (m *realityCheckExtModule) handshake(ctx context.Context, address string, config *tls.Config) (tls.ConnectionState, bool, error) {
	conn, err := m.dial(ctx, "tcp", address)
	if err != nil {
		return tls.ConnectionState{}, false, err
	}
	client := tls.Client(conn, config)
	defer client.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if err := client.HandshakeContext(ctx); err != nil {
		return tls.ConnectionState{}, true, err
	}
	return client.ConnectionState(), true, nil
}

func (m *realityCheckExtModule) probeAddress(ctx context.Context, base realityCheckResult, address netip.Addr, port int, serverName string) realityCheckResult {
	item := base
	item.ResolvedIP = address.String()
	dialAddress := net.JoinHostPort(address.String(), strconv.Itoa(port))
	state, connected, err := m.handshake(ctx, dialAddress, &tls.Config{
		ServerName:         serverName,
		InsecureSkipVerify: true, // 证书在下面单独验：验不过只是 certValid=false，其余几项照样要测出来。
		MinVersion:         tls.VersionTLS12,
		MaxVersion:         tls.VersionTLS13,
		NextProtos:         []string{"h2", "http/1.1"},
	})
	item.Reachable = connected
	if err != nil {
		if connected {
			item.Error = "handshake"
		} else {
			item.Error = "dial"
		}
		return item
	}
	item.TLS13 = state.Version == tls.VersionTLS13
	item.H2 = state.NegotiatedProtocol == "h2"
	item.CertValid = m.verifyCertificate(state, serverName)
	if item.TLS13 {
		// REALITY 客户端（uTLS 的 Chrome 指纹）用 X25519 交换密钥：只给 X25519 再握一次，握得上才算支持。
		_, _, x25519Err := m.handshake(ctx, dialAddress, &tls.Config{
			ServerName:         serverName,
			InsecureSkipVerify: true,
			MinVersion:         tls.VersionTLS13,
			MaxVersion:         tls.VersionTLS13,
			CurvePreferences:   []tls.CurveID{tls.X25519},
			NextProtos:         []string{"h2", "http/1.1"},
		})
		item.X25519 = x25519Err == nil
	}
	item.Feasible = item.TLS13 && item.X25519 && item.H2 && item.CertValid
	return item
}

func (m *realityCheckExtModule) verifyCertificate(state tls.ConnectionState, serverName string) bool {
	if len(state.PeerCertificates) == 0 {
		return false
	}
	intermediates := x509.NewCertPool()
	for _, certificate := range state.PeerCertificates[1:] {
		intermediates.AddCert(certificate)
	}
	_, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{
		DNSName:       serverName,
		Intermediates: intermediates,
		Roots:         m.roots,
		CurrentTime:   m.now(),
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	return err == nil
}
