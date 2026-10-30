package main

/*
扩展模块 "nodecheck"（2.2.241 起）：按需的「网速测试」和「经节点的出口检测」。面板那头见
server/ops/nodeCheck.ts。

指令（每轮重发，直到面板收到这个 runId 的 done / error）：
  runs [{runId, kind: "speed" | "exit", family, via: {outbound: <sing-box 出站 JSON>, singboxBin}?, targets: [...]}]
上报：
  runs [{runId, kind, status: running|done|error, startedAt, finishedAt, phase, error, speed: {...}, exit: {...}}]

  · speed：对 Cloudflare 测速（延迟 / 抖动 / 下载 / 上传 / 机房 / 出口 IP）。跑的时候每秒把
    进度曲线（samples）也报上去，面板那头画实时曲线。
  · exit：站点握手（和 sitelatency 一样的做法）+ 流媒体 / AI 解锁（和 unlock 一样的做法），
    只跑一轮、一次性上报，给粘贴进来、机器不是自己的那些节点看出口。
  · via：有的话先临时拉一个 sing-box（mixed 入站 127.0.0.1:随机端口 + 这个出站），检测都经它
    走；跑完就杀掉。sing-box 二进制就是面板给自建节点装的那一个（/usr/local/bin/forwardx-singbox）。

同一个 runId 只跑一次；几次排队一个一个跑（测速会把带宽吃满，并排跑互相干扰）。结果在内存
里留 15 分钟、每轮都报，面板自己去重。
*/

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

const (
	nodeCheckResultTTL   = 15 * time.Minute
	nodeCheckRunBudget   = 3 * time.Minute
	nodeCheckMaxRuns     = 8
	nodeCheckDefaultBin  = "/usr/local/bin/forwardx-singbox"
	nodeCheckSingboxWait = 8 * time.Second

	speedTestLatencyN  = 10
	speedTestStreams   = 4
	speedTestDownBytes = 100 << 20 // 每条流一次要 100 MB，10 秒内吃不完就算了
	speedTestUpBytes   = 50 << 20
)

// 测试里缩短。
var (
	speedTestDownDuration = 10 * time.Second
	speedTestUpDuration   = 8 * time.Second
	speedTestSampleEvery  = 500 * time.Millisecond
	speedTestWarmup       = 2 * time.Second
)

// 测试里换成本地 httptest 服务。
var speedTestBaseURL = "https://speed.cloudflare.com"

func speedTestURL(path string) string { return speedTestBaseURL + path }

type nodeCheckVia struct {
	Outbound json.RawMessage `json:"outbound"`
	// 主出站要经的前置代理等额外出站（原样写进配置；主出站的 detour 指向其中一个的 tag）。
	ExtraOutbounds []json.RawMessage `json:"extraOutbounds,omitempty"`
	SingboxBin     string            `json:"singboxBin,omitempty"`
}

type nodeCheckRunDirective struct {
	RunID   string              `json:"runId"`
	Kind    string              `json:"kind"`
	Family  string              `json:"family,omitempty"`
	Via     *nodeCheckVia       `json:"via,omitempty"`
	Targets []siteLatencyTarget `json:"targets,omitempty"`
}

type nodeCheckDirective struct {
	Runs []nodeCheckRunDirective `json:"runs"`
}

type speedSample struct {
	// 距开始的毫秒
	T int64 `json:"t"`
	// 这一刻的下载 / 上传速率（Mbit/s）；没在测的那一项为 0
	Down float64 `json:"down"`
	Up   float64 `json:"up"`
}

type speedTestResult struct {
	LatencyMs    float64       `json:"latencyMs"`
	JitterMs     float64       `json:"jitterMs"`
	DownloadMbps float64       `json:"downloadMbps"`
	UploadMbps   float64       `json:"uploadMbps"`
	Colo         string        `json:"colo,omitempty"`
	ClientIP     string        `json:"clientIp,omitempty"`
	ASN          string        `json:"asn,omitempty"`
	ASOrg        string        `json:"asOrg,omitempty"`
	Country      string        `json:"country,omitempty"`
	City         string        `json:"city,omitempty"`
	Samples      []speedSample `json:"samples"`
}

type exitCheckResult struct {
	Sites  []siteLatencyReportTarget `json:"sites"`
	Unlock []unlockResult            `json:"unlock"`
}

type nodeCheckRunReport struct {
	RunID      string           `json:"runId"`
	Kind       string           `json:"kind"`
	Status     string           `json:"status"`
	Phase      string           `json:"phase,omitempty"`
	StartedAt  int64            `json:"startedAt"`
	FinishedAt int64            `json:"finishedAt,omitempty"`
	Error      string           `json:"error,omitempty"`
	Speed      *speedTestResult `json:"speed,omitempty"`
	Exit       *exitCheckResult `json:"exit,omitempty"`
}

type nodeCheckReport struct {
	Runs []nodeCheckRunReport `json:"runs"`
}

type nodeCheckDialFunc func(ctx context.Context, network, address string) (net.Conn, error)

type nodeCheckExtModule struct {
	mu    sync.Mutex
	runs  map[string]*nodeCheckRunReport
	runMu sync.Mutex // 一次只跑一个
	// 测试里替换
	runSpeed func(ctx context.Context, dial nodeCheckDialFunc, progress func(speedSample)) (*speedTestResult, error)
	runExit  func(ctx context.Context, dial nodeCheckDialFunc, viaProxy bool, family string, targets []siteLatencyTarget) (*exitCheckResult, error)
	startVia func(ctx context.Context, via *nodeCheckVia) (nodeCheckDialFunc, func(), error)
	wake     func()
}

func newNodeCheckExtModule() *nodeCheckExtModule {
	return &nodeCheckExtModule{
		runs:     map[string]*nodeCheckRunReport{},
		runSpeed: runCloudflareSpeedTest,
		runExit:  runExitCheck,
		startVia: startNodeCheckSingbox,
		wake:     wakeAgentExt,
	}
}

func (m *nodeCheckExtModule) Name() string { return "nodecheck" }

func (m *nodeCheckExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-nodeCheckResultTTL).Unix()
	report := nodeCheckReport{}
	for id, r := range m.runs {
		if r.FinishedAt > 0 && r.FinishedAt < cutoff {
			delete(m.runs, id)
			continue
		}
		copied := *r
		if r.Speed != nil {
			speed := *r.Speed
			speed.Samples = append([]speedSample(nil), r.Speed.Samples...)
			copied.Speed = &speed
		}
		report.Runs = append(report.Runs, copied)
	}
	if len(report.Runs) == 0 {
		return nil
	}
	sort.Slice(report.Runs, func(i, j int) bool { return report.Runs[i].StartedAt < report.Runs[j].StartedAt })
	return report
}

func (m *nodeCheckExtModule) Apply(cfg Config, directive json.RawMessage) {
	var d nodeCheckDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		logf("nodecheck directive invalid: %v", err)
		return
	}
	for _, run := range d.Runs {
		if !opsValidID(run.RunID) || (run.Kind != "speed" && run.Kind != "exit") {
			continue
		}
		m.start(run)
	}
}

func (m *nodeCheckExtModule) start(d nodeCheckRunDirective) {
	m.mu.Lock()
	if _, exists := m.runs[d.RunID]; exists {
		m.mu.Unlock()
		return
	}
	if len(m.runs) >= nodeCheckMaxRuns {
		m.mu.Unlock()
		return
	}
	report := &nodeCheckRunReport{RunID: d.RunID, Kind: d.Kind, Status: "running", Phase: "queued", StartedAt: time.Now().Unix()}
	m.runs[d.RunID] = report
	m.mu.Unlock()
	go m.execute(d, report)
}

func (m *nodeCheckExtModule) setPhase(report *nodeCheckRunReport, phase string) {
	m.mu.Lock()
	report.Phase = phase
	m.mu.Unlock()
}

func (m *nodeCheckExtModule) finish(report *nodeCheckRunReport, err error) {
	m.mu.Lock()
	report.FinishedAt = time.Now().Unix()
	report.Phase = ""
	if err != nil {
		report.Status = "error"
		report.Error = err.Error()
	} else {
		report.Status = "done"
	}
	m.mu.Unlock()
	if m.wake != nil {
		m.wake()
	}
}

func (m *nodeCheckExtModule) execute(d nodeCheckRunDirective, report *nodeCheckRunReport) {
	m.runMu.Lock()
	defer m.runMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), nodeCheckRunBudget)
	defer cancel()
	err := func() (err error) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("panic: %v", r)
			}
		}()
		var dial nodeCheckDialFunc
		viaProxy := false
		if d.Via != nil && len(d.Via.Outbound) > 0 {
			m.setPhase(report, "singbox")
			viaDial, stop, viaErr := m.startVia(ctx, d.Via)
			if viaErr != nil {
				return viaErr
			}
			defer stop()
			dial = viaDial
			viaProxy = true
		} else {
			dialer := &net.Dialer{Timeout: 10 * time.Second}
			dial = dialer.DialContext
		}
		switch d.Kind {
		case "speed":
			m.setPhase(report, "latency")
			var lastWake time.Time
			result, speedErr := m.runSpeed(ctx, dial, func(sample speedSample) {
				m.mu.Lock()
				if report.Speed == nil {
					report.Speed = &speedTestResult{}
				}
				report.Speed.Samples = append(report.Speed.Samples, sample)
				if sample.Up > 0 {
					report.Phase = "upload"
				} else {
					report.Phase = "download"
				}
				m.mu.Unlock()
				// 曲线要实时：每秒让扩展通道多跑一轮把进度送上去（面板那头 1 秒一刷）。
				if m.wake != nil && time.Since(lastWake) >= time.Second {
					lastWake = time.Now()
					m.wake()
				}
			})
			if speedErr != nil {
				return speedErr
			}
			m.mu.Lock()
			report.Speed = result
			m.mu.Unlock()
		case "exit":
			m.setPhase(report, "probe")
			result, exitErr := m.runExit(ctx, dial, viaProxy, d.Family, d.Targets)
			if exitErr != nil {
				return exitErr
			}
			m.mu.Lock()
			report.Exit = result
			m.mu.Unlock()
		}
		return nil
	}()
	if err != nil {
		logf("nodecheck run=%s kind=%s failed: %v", d.RunID, d.Kind, err)
	} else {
		logf("nodecheck run=%s kind=%s done", d.RunID, d.Kind)
	}
	m.finish(report, err)
}

// ---------------------------------------------------------------- 临时 sing-box

func freeLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port, nil
}

// startNodeCheckSingbox 起一个只有一个 mixed 入站、一个出站的 sing-box，返回经它的拨号函数和停止函数。
func startNodeCheckSingbox(ctx context.Context, via *nodeCheckVia) (nodeCheckDialFunc, func(), error) {
	bin := strings.TrimSpace(via.SingboxBin)
	if bin == "" {
		bin = nodeCheckDefaultBin
	}
	if _, err := os.Stat(bin); err != nil {
		return nil, nil, fmt.Errorf("这台机器没有 sing-box（%s）：给它建一个自建节点就会装上，或者换一台机器检测", bin)
	}
	var outbound map[string]any
	if err := json.Unmarshal(via.Outbound, &outbound); err != nil || outbound == nil {
		return nil, nil, errors.New("出站配置不是合法的 JSON")
	}
	outbound["tag"] = "proxy"
	outbounds := []map[string]any{outbound}
	for _, raw := range via.ExtraOutbounds {
		var extra map[string]any
		if err := json.Unmarshal(raw, &extra); err != nil || extra == nil {
			return nil, nil, errors.New("前置出站配置不是合法的 JSON")
		}
		outbounds = append(outbounds, extra)
	}
	if len(via.ExtraOutbounds) == 0 {
		delete(outbound, "detour")
	}
	port, err := freeLoopbackPort()
	if err != nil {
		return nil, nil, err
	}
	config := map[string]any{
		"log": map[string]any{"level": "warn", "timestamp": false},
		"inbounds": []map[string]any{{
			"type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": port,
		}},
		"outbounds": append(outbounds, map[string]any{"type": "direct", "tag": "direct"}),
		"route":     map[string]any{"final": "proxy"},
	}
	data, err := json.Marshal(config)
	if err != nil {
		return nil, nil, err
	}
	dir, err := os.MkdirTemp("", "forwardx-nodecheck-")
	if err != nil {
		return nil, nil, err
	}
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return nil, nil, err
	}
	cmd := exec.Command(bin, "run", "-c", path)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	cmd.Stdout = io.Discard
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(dir)
		return nil, nil, fmt.Errorf("起不来 sing-box：%v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	stop := func() {
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
		}
		_ = os.RemoveAll(dir)
	}
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	deadline := time.Now().Add(nodeCheckSingboxWait)
	for {
		select {
		case err := <-done:
			_ = os.RemoveAll(dir)
			msg := strings.TrimSpace(stderr.String())
			if len(msg) > 400 {
				msg = msg[len(msg)-400:]
			}
			if msg == "" && err != nil {
				msg = err.Error()
			}
			return nil, nil, fmt.Errorf("sing-box 起来就退出了：%s", msg)
		default:
		}
		conn, err := net.DialTimeout("tcp", address, 300*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			break
		}
		if time.Now().After(deadline) {
			stop()
			return nil, nil, errors.New("sing-box 没在 8 秒内监听起来")
		}
		time.Sleep(150 * time.Millisecond)
	}
	socks, err := proxy.SOCKS5("tcp", address, nil, &net.Dialer{Timeout: 10 * time.Second})
	if err != nil {
		stop()
		return nil, nil, err
	}
	ctxDialer, ok := socks.(proxy.ContextDialer)
	if !ok {
		stop()
		return nil, nil, errors.New("socks dialer does not support context")
	}
	return ctxDialer.DialContext, stop, nil
}

// ---------------------------------------------------------------- 经节点的出口检测

func runExitCheck(ctx context.Context, dial nodeCheckDialFunc, viaProxy bool, family string, targets []siteLatencyTarget) (*exitCheckResult, error) {
	targets = normalizeSiteLatencyTargets(targets)
	result := &exitCheckResult{Sites: []siteLatencyReportTarget{}, Unlock: []unlockResult{}}
	if len(targets) > 0 {
		m := &siteLatencyExtModule{
			samples:  map[string][]siteLatencySample{},
			resolve:  siteLatencyResolve,
			dial:     dial,
			verify:   siteLatencyVerifyTLS,
			now:      time.Now,
			sleep:    time.Sleep,
			attempts: siteLatencyAttempts,
		}
		if viaProxy {
			// 经代理时域名交给节点那头解析：本机解析出来的地址可能和节点所在地看到的不一样。
			m.resolve = func(_ context.Context, host string) (string, error) { return host, nil }
		}
		samples := m.measure(targets)
		for i, target := range targets {
			result.Sites = append(result.Sites, siteLatencyReportTarget{Key: target.Key, Samples: []siteLatencySample{samples[i]}})
		}
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if !unlockValidFamily(family) {
		family = "auto"
	}
	var probe *unlockProbe
	if viaProxy {
		probe = newUnlockProbe("auto", unlockDialFunc(dial), nil)
	} else {
		probe = newUnlockProbe(family, nil, nil)
	}
	defer probe.close()
	result.Unlock = runUnlockChecks(ctx, probe, unlockServices)
	return result, nil
}

// ---------------------------------------------------------------- Cloudflare 测速

func speedTestClient(dial nodeCheckDialFunc) *http.Client {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           dial,
		ForceAttemptHTTP2:     false, // 几条并行流各走各的连接，才测得出带宽
		MaxIdleConns:          16,
		MaxConnsPerHost:       0,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		DisableCompression:    true,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
	return &http.Client{Transport: transport}
}

type speedMeta struct {
	ClientIP       string `json:"clientIp"`
	ASN            any    `json:"asn"`
	ASOrganization string `json:"asOrganization"`
	Colo           string `json:"colo"`
	Country        string `json:"country"`
	City           string `json:"city"`
}

// byteCounter 把几条流写进来的字节数累到一起（原子），采样协程按时间差算速率。
type byteCounter struct {
	mu    sync.Mutex
	total int64
}

func (c *byteCounter) add(n int64) {
	c.mu.Lock()
	c.total += n
	c.mu.Unlock()
}

func (c *byteCounter) get() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}

type countingWriter struct{ counter *byteCounter }

func (w countingWriter) Write(p []byte) (int, error) {
	w.counter.add(int64(len(p)))
	return len(p), nil
}

// zeroReader 产生 n 个零字节，边读边计数，给上传用。
type zeroReader struct {
	remaining int64
	counter   *byteCounter
}

func (r *zeroReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, io.EOF
	}
	n := len(p)
	if int64(n) > r.remaining {
		n = int(r.remaining)
	}
	for i := 0; i < n; i++ {
		p[i] = 0
	}
	r.remaining -= int64(n)
	r.counter.add(int64(n))
	return n, nil
}

func runCloudflareSpeedTest(ctx context.Context, dial nodeCheckDialFunc, progress func(speedSample)) (*speedTestResult, error) {
	client := speedTestClient(dial)
	defer client.CloseIdleConnections()
	result := &speedTestResult{Samples: []speedSample{}}

	// 元数据：出口 IP、ASN、机房。连不上就是整条路不通，直接报错。
	metaCtx, cancelMeta := context.WithTimeout(ctx, 15*time.Second)
	req, _ := http.NewRequestWithContext(metaCtx, http.MethodGet, speedTestURL("/meta"), nil)
	resp, err := client.Do(req)
	if err != nil {
		cancelMeta()
		return nil, fmt.Errorf("连不上 speed.cloudflare.com：%v", err)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	cancelMeta()
	var meta speedMeta
	if json.Unmarshal(body, &meta) == nil {
		result.ClientIP = meta.ClientIP
		result.ASN = normalizeSpeedASN(meta.ASN)
		result.ASOrg = meta.ASOrganization
		result.Colo = meta.Colo
		result.Country = meta.Country
		result.City = meta.City
	}

	// 延迟：十次极小的请求，取到首字节的时间；延迟 = 中位数，抖动 = 相邻两次差的平均。
	var latencies []float64
	for i := 0; i < speedTestLatencyN; i++ {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		started := time.Now()
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, speedTestURL("/__down?bytes=0"), nil)
		rs, err := client.Do(r)
		if err == nil {
			_, _ = io.Copy(io.Discard, rs.Body)
			_ = rs.Body.Close()
			latencies = append(latencies, float64(time.Since(started).Microseconds())/1000)
		}
		cancel()
	}
	if len(latencies) == 0 {
		return nil, errors.New("延迟测试全部失败")
	}
	result.LatencyMs, result.JitterMs = summarizeLatencies(latencies)

	start := time.Now()
	// 下载
	down := &byteCounter{}
	downMbps, err := runSpeedPhase(ctx, speedTestDownDuration, down, func(phaseCtx context.Context) error {
		r, _ := http.NewRequestWithContext(phaseCtx, http.MethodGet, speedTestURL(fmt.Sprintf("/__down?bytes=%d", speedTestDownBytes)), nil)
		rs, err := client.Do(r)
		if err != nil {
			return err
		}
		defer rs.Body.Close()
		_, err = io.Copy(countingWriter{down}, rs.Body)
		return err
	}, func(mbps float64) {
		sample := speedSample{T: time.Since(start).Milliseconds(), Down: mbps}
		result.Samples = append(result.Samples, sample)
		if progress != nil {
			progress(sample)
		}
	})
	if err != nil {
		return nil, err
	}
	result.DownloadMbps = downMbps

	// 上传
	up := &byteCounter{}
	upMbps, err := runSpeedPhase(ctx, speedTestUpDuration, up, func(phaseCtx context.Context) error {
		r, _ := http.NewRequestWithContext(phaseCtx, http.MethodPost, speedTestURL("/__up"), &zeroReader{remaining: speedTestUpBytes, counter: up})
		r.ContentLength = speedTestUpBytes
		r.Header.Set("Content-Type", "application/octet-stream")
		rs, err := client.Do(r)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, rs.Body)
		_ = rs.Body.Close()
		return nil
	}, func(mbps float64) {
		sample := speedSample{T: time.Since(start).Milliseconds(), Up: mbps}
		result.Samples = append(result.Samples, sample)
		if progress != nil {
			progress(sample)
		}
	})
	if err != nil {
		return nil, err
	}
	result.UploadMbps = upMbps
	return result, nil
}

// runSpeedPhase 起 speedTestStreams 条流各自反复跑 stream，跑满 duration 就停；每 speedTestSampleEvery
// 采一次这段时间的速率；返回去掉前 speedTestWarmup 的平均速率（Mbit/s）。
func runSpeedPhase(ctx context.Context, duration time.Duration, counter *byteCounter, stream func(ctx context.Context) error, sample func(mbps float64)) (float64, error) {
	phaseCtx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	var wg sync.WaitGroup
	var firstErr error
	var errMu sync.Mutex
	var okStreams int32
	for i := 0; i < speedTestStreams; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for phaseCtx.Err() == nil {
				err := stream(phaseCtx)
				if err == nil {
					errMu.Lock()
					okStreams++
					errMu.Unlock()
					continue
				}
				if phaseCtx.Err() != nil {
					// 到点被我们自己掐掉的，不算错。传了字节的也算成功。
					return
				}
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				errMu.Unlock()
				time.Sleep(300 * time.Millisecond)
			}
		}()
	}
	started := time.Now()
	ticker := time.NewTicker(speedTestSampleEvery)
	defer ticker.Stop()
	lastBytes := int64(0)
	lastAt := started
	var measured []float64
	for {
		select {
		case <-phaseCtx.Done():
			wg.Wait()
			if counter.get() == 0 {
				errMu.Lock()
				err := firstErr
				errMu.Unlock()
				if err == nil {
					err = errors.New("没有传输到任何数据")
				}
				return 0, fmt.Errorf("测速失败：%v", err)
			}
			if len(measured) == 0 {
				return 0, errors.New("测速时间太短")
			}
			sum := 0.0
			for _, v := range measured {
				sum += v
			}
			return math.Round(sum/float64(len(measured))*10) / 10, nil
		case now := <-ticker.C:
			total := counter.get()
			elapsed := now.Sub(lastAt).Seconds()
			if elapsed <= 0 {
				continue
			}
			mbps := float64(total-lastBytes) * 8 / elapsed / 1_000_000
			lastBytes = total
			lastAt = now
			mbps = math.Round(mbps*10) / 10
			if sample != nil {
				sample(mbps)
			}
			if now.Sub(started) >= speedTestWarmup {
				measured = append(measured, mbps)
			}
		}
	}
}

func summarizeLatencies(values []float64) (latency, jitter float64) {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 0 {
		latency = (sorted[mid-1] + sorted[mid]) / 2
	} else {
		latency = sorted[mid]
	}
	if len(values) > 1 {
		sum := 0.0
		for i := 1; i < len(values); i++ {
			sum += math.Abs(values[i] - values[i-1])
		}
		jitter = sum / float64(len(values)-1)
	}
	return math.Round(latency*10) / 10, math.Round(jitter*10) / 10
}

func normalizeSpeedASN(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case float64:
		if v <= 0 {
			return ""
		}
		return "AS" + strconv.FormatInt(int64(v), 10)
	case string:
		v = strings.TrimSpace(v)
		if v == "" || v == "0" {
			return ""
		}
		if strings.HasPrefix(strings.ToUpper(v), "AS") {
			return "AS" + strings.TrimSpace(v[2:])
		}
		return "AS" + v
	default:
		return ""
	}
}

func init() {
	registerExtModule(newNodeCheckExtModule())
}
