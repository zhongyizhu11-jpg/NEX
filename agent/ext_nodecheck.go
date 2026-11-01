package main

/*
扩展模块 "nodecheck"（2.2.241 起）：按需的「网速测试」和「经节点的出口检测」。面板那头见
server/ops/nodeCheck.ts。

指令（每轮重发，直到面板收到这个 runId 的 done / error）：
  runs [{runId, kind: "speed" | "exit", family, via: {outbound: <sing-box 出站 JSON>, singboxBin}?, targets: [...], panel: {token}?}]
上报：
  runs [{runId, kind, status: running|done|error, startedAt, finishedAt, phase, error, speed: {...}, exit: {...}}]

  · speed：对 Cloudflare 测速（延迟 / 抖动 / 下载 / 上传 / 机房 / 出口 IP）。跑的时候每秒把
    进度曲线（samples）也报上去，面板那头画实时曲线。连不上 Cloudflare（国内机器到国外 80 / 443
    常常不通）而面板给了 panel.token，就改测到面板自己（server/ops/nodeCheckSpeedRoute.ts）。
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
	nodeCheckRunBudget   = 6 * time.Minute
	nodeCheckInstallWait = 3 * time.Minute
	nodeCheckMaxRuns     = 8
	nodeCheckDefaultBin  = "/usr/local/bin/forwardx-singbox"
	nodeCheckSingboxWait = 8 * time.Second

	speedTestLatencyN = 10
	speedTestStreams  = 4
	// 每条流一次要 25 MB，吃完再要。Cloudflare 对非浏览器 / 机房出口的请求，一次要 100 MB 会回 403
	// （50 MB 还行），浏览器版测速最大一档也是 25 MB。上传每次送多大见 ext_speedtest.go（跟着速度调）。
	speedTestDownBytes = 25 << 20
)

// 测试里缩短。
var (
	speedTestDownDuration = 10 * time.Second
	speedTestUpDuration   = 8 * time.Second
	speedTestSampleEvery  = 500 * time.Millisecond
	speedTestWarmup       = 2 * time.Second
	// 链很长（经代理、几跳中转）时第一个字节来得晚：最多再多等这么久，让量的时间别被握手吃掉。
	speedTestMaxExtra = 8 * time.Second
	// 直接测（不经代理）时连 Cloudflare 等多久：国内机器常常连不上，早点改测到面板。
	speedTestDirectMetaTimeout = 8 * time.Second
)

// 测试里换成本地 httptest 服务。
var speedTestBaseURL = "https://speed.cloudflare.com"

// 面板自己也能当测速服务器（server/ops/nodeCheckSpeedRoute.ts）：国内机器到国外 80 / 443 常常不通，
// 连不上 Cloudflare 时改测到面板，面板是 Agent 一定连得上的那一个地址。
type nodeCheckPanelSpeed struct {
	Token string `json:"token"`
}

// speedTarget 一个测速服务器：就近的 Ookla 测速点（2.2.246 起，跑的时候才挑）、Cloudflare 或面板。
// Cloudflare 和面板的路径形状一样：meta、down?bytes=、up；Ookla 的见 ext_speedtest.go。
type speedTarget struct {
	name    string // "ookla" | "cloudflare" | "panel"
	label   string // 报错时用
	base    string
	meta    string
	trace   string // Cloudflare 的 /cdn-cgi/trace：/meta 对机房出口常回 403，拿不到就从这里补出口 IP / 机房
	down    string
	up      string
	headers map[string]string
	// 取 meta（Ookla 是取服务器列表）等多久；0 = 15 秒。
	metaTimeout time.Duration
	// Ookla：挑中的那台（pickOoklaServer 填）。
	ookla *ooklaServer
}

func ooklaSpeedTarget() speedTarget {
	return speedTarget{name: "ookla", label: "Ookla 测速点"}
}

func cloudflareSpeedTarget() speedTarget {
	return speedTarget{name: "cloudflare", label: "speed.cloudflare.com", base: speedTestBaseURL, meta: "/meta", trace: "/cdn-cgi/trace", down: "/__down", up: "/__up"}
}

func panelSpeedTarget(panelURL, token string) speedTarget {
	return speedTarget{
		name: "panel", label: "面板", base: strings.TrimRight(panelURL, "/"),
		meta: "/api/nodecheck/speed/meta", down: "/api/nodecheck/speed/down", up: "/api/nodecheck/speed/up",
		headers: map[string]string{"Authorization": "Bearer " + token},
	}
}

type nodeCheckVia struct {
	Outbound json.RawMessage `json:"outbound"`
	// 主出站要经的前置代理等额外出站（原样写进配置；主出站的 detour 指向其中一个的 tag）。
	ExtraOutbounds []json.RawMessage `json:"extraOutbounds,omitempty"`
	SingboxBin     string            `json:"singboxBin,omitempty"`
	// 这台机器没有 sing-box 时先跑它装一个（面板给的就是自建节点那套装机脚本，GitHub / 加速 / 面板转发三路试）。
	InstallCmd string `json:"installCmd,omitempty"`
}

type nodeCheckRunDirective struct {
	RunID   string               `json:"runId"`
	Kind    string               `json:"kind"`
	Family  string               `json:"family,omitempty"`
	Via     *nodeCheckVia        `json:"via,omitempty"`
	Targets []siteLatencyTarget  `json:"targets,omitempty"`
	Panel   *nodeCheckPanelSpeed `json:"panel,omitempty"`
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
	// 只给进度回调用、不上报：非空时这一条只是说「进到哪一段了」，不是曲线上的点。
	phase string
}

type speedTestResult struct {
	// 连接建好以后来回一趟的时间（中位数）和相邻两次的差；第一个要握手的请求不算（2.2.243 起）。
	LatencyMs float64 `json:"latencyMs"`
	JitterMs  float64 `json:"jitterMs"`
	// 第一个请求（取 meta）的耗时：经代理时含 sing-box → 节点 → 测速点的握手，像客户端的「延迟测试」。
	ConnectMs    float64 `json:"connectMs,omitempty"`
	DownloadMbps float64 `json:"downloadMbps"`
	UploadMbps   float64 `json:"uploadMbps"`
	Colo         string  `json:"colo,omitempty"`
	ClientIP     string  `json:"clientIp,omitempty"`
	ASN          string  `json:"asn,omitempty"`
	ASOrg        string  `json:"asOrg,omitempty"`
	Country      string  `json:"country,omitempty"`
	City         string  `json:"city,omitempty"`
	// 对谁测的："ookla" | "cloudflare" | "panel"；换了测速点时 note 说明前面的为什么没测成。
	Server string `json:"server,omitempty"`
	// Ookla 测速点（2.2.246 起）：「运营商 · 城市」、国家、离出口多远、主机名。
	ServerName       string  `json:"serverName,omitempty"`
	ServerCountry    string  `json:"serverCountry,omitempty"`
	ServerDistanceKm float64 `json:"serverDistanceKm,omitempty"`
	ServerHost       string  `json:"serverHost,omitempty"`
	// 这次测速用掉的流量（2.2.246 起）：下载收到的、上传送出去的（含没被确认的）。
	DownloadBytes int64         `json:"downloadBytes,omitempty"`
	UploadBytes   int64         `json:"uploadBytes,omitempty"`
	Note          string        `json:"note,omitempty"`
	Samples       []speedSample `json:"samples"`
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
	// 这台 Agent 连的面板地址（Apply 时从配置拿），面板当测速服务器用。
	panelURL string
	// 测试里替换
	runSpeed func(ctx context.Context, dial nodeCheckDialFunc, target speedTarget, progress func(speedSample)) (*speedTestResult, error)
	runExit  func(ctx context.Context, dial nodeCheckDialFunc, viaProxy bool, family string, targets []siteLatencyTarget) (*exitCheckResult, error)
	// startVia 返回：经 sing-box 的拨号函数、停止函数、取 sing-box 日志尾巴（出错时带回面板）。
	startVia func(ctx context.Context, via *nodeCheckVia) (nodeCheckDialFunc, func(), func() string, error)
	wake     func()
}

func newNodeCheckExtModule() *nodeCheckExtModule {
	return &nodeCheckExtModule{
		runs:     map[string]*nodeCheckRunReport{},
		runSpeed: runHTTPSpeedTest,
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
	if panelURL := currentPanelURL(cfg); panelURL != "" {
		m.mu.Lock()
		m.panelURL = panelURL
		m.mu.Unlock()
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
		var viaLogs func() string
		if d.Via != nil && len(d.Via.Outbound) > 0 {
			m.setPhase(report, "singbox")
			viaDial, stop, logs, viaErr := m.startVia(ctx, d.Via)
			if viaErr != nil {
				return viaErr
			}
			defer stop()
			dial = viaDial
			viaProxy = true
			viaLogs = logs
			// 经节点时失败多半是节点那头连不上：把 sing-box 的日志尾巴带回去，别只剩一句 SOCKS failure。
			defer func() {
				if err != nil && viaLogs != nil {
					if tail := strings.TrimSpace(viaLogs()); tail != "" {
						err = fmt.Errorf("%v\nsing-box：%s", err, tail)
					}
				}
			}()
		} else {
			dialer := &net.Dialer{Timeout: 10 * time.Second}
			dial = dialer.DialContext
		}
		switch d.Kind {
		case "speed":
			var lastWake time.Time
			progress := func(sample speedSample) {
				m.mu.Lock()
				if sample.phase == "reset" {
					// 换了一台测速点从头测：上一台画到一半的曲线不要了
					report.Speed = nil
					report.Phase = "latency"
					m.mu.Unlock()
					return
				}
				if sample.phase != "" {
					report.Phase = sample.phase
					m.mu.Unlock()
					return
				}
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
			}
			// 先就近的 Ookla 测速点（2.2.246 起）；测不了换 Cloudflare；都不行、面板给了 token 才测到面板
			// （那只量得出到面板这条路，上限是面板服务器的带宽）。直接测时少等一会儿：连不上的话早点换；
			// 经代理时出去的是落地，照常等。
			ookla := ooklaSpeedTarget()
			cloudflare := cloudflareSpeedTarget()
			if !viaProxy {
				ookla.metaTimeout = speedTestDirectMetaTimeout
				cloudflare.metaTimeout = speedTestDirectMetaTimeout
			}
			targets := []speedTarget{ookla, cloudflare}
			m.mu.Lock()
			panelURL := m.panelURL
			m.mu.Unlock()
			if d.Panel != nil && d.Panel.Token != "" && panelURL != "" {
				targets = append(targets, panelSpeedTarget(panelURL, d.Panel.Token))
			}
			var failures []string
			for i, target := range targets {
				m.mu.Lock()
				report.Speed = nil
				report.Phase = "latency"
				m.mu.Unlock()
				result, speedErr := m.runSpeed(ctx, dial, target, progress)
				if speedErr == nil {
					result.Server = target.name
					if i > 0 {
						fallback := speedFallbackNote(targets[:i], failures, target, viaProxy)
						if result.Note != "" {
							fallback += "；" + result.Note
						}
						result.Note = fallback
					}
					m.mu.Lock()
					report.Speed = result
					m.mu.Unlock()
					break
				}
				failures = append(failures, firstLine(speedErr.Error()))
				if ctx.Err() != nil || i == len(targets)-1 {
					if len(failures) > 1 {
						return errors.New(strings.Join(failures, "；"))
					}
					return speedErr
				}
				logf("nodecheck run=%s speed via %s failed, falling back to %s: %v", d.RunID, target.name, targets[i+1].name, speedErr)
			}
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
func startNodeCheckSingbox(ctx context.Context, via *nodeCheckVia) (nodeCheckDialFunc, func(), func() string, error) {
	bin := strings.TrimSpace(via.SingboxBin)
	if bin == "" {
		bin = nodeCheckDefaultBin
	}
	if _, err := os.Stat(bin); err != nil {
		if strings.TrimSpace(via.InstallCmd) == "" {
			return nil, nil, nil, fmt.Errorf("这台机器没有 sing-box（%s）：给它建一个自建节点就会装上，或者换一台机器检测", bin)
		}
		if err := installNodeCheckSingbox(ctx, via.InstallCmd); err != nil {
			return nil, nil, nil, err
		}
		if _, err := os.Stat(bin); err != nil {
			return nil, nil, nil, fmt.Errorf("装完还是没有 sing-box（%s）", bin)
		}
	}
	var outbound map[string]any
	if err := json.Unmarshal(via.Outbound, &outbound); err != nil || outbound == nil {
		return nil, nil, nil, errors.New("出站配置不是合法的 JSON")
	}
	outbound["tag"] = "proxy"
	outbounds := []map[string]any{outbound}
	for _, raw := range via.ExtraOutbounds {
		var extra map[string]any
		if err := json.Unmarshal(raw, &extra); err != nil || extra == nil {
			return nil, nil, nil, errors.New("前置出站配置不是合法的 JSON")
		}
		outbounds = append(outbounds, extra)
	}
	if len(via.ExtraOutbounds) == 0 {
		delete(outbound, "detour")
	}
	port, err := freeLoopbackPort()
	if err != nil {
		return nil, nil, nil, err
	}
	config := map[string]any{
		"log": map[string]any{"level": "info", "timestamp": false},
		"inbounds": []map[string]any{{
			"type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": port,
		}},
		"outbounds": append(outbounds, map[string]any{"type": "direct", "tag": "direct"}),
		"route":     map[string]any{"final": "proxy"},
	}
	data, err := json.Marshal(config)
	if err != nil {
		return nil, nil, nil, err
	}
	dir, err := os.MkdirTemp("", "forwardx-nodecheck-")
	if err != nil {
		return nil, nil, nil, err
	}
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return nil, nil, nil, err
	}
	cmd := exec.Command(bin, "run", "-c", path)
	stderr := &lockedTail{limit: 2000}
	cmd.Stderr = stderr
	cmd.Stdout = io.Discard
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(dir)
		return nil, nil, nil, fmt.Errorf("起不来 sing-box：%v", err)
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
			msg := stderr.tail(400)
			if msg == "" && err != nil {
				msg = err.Error()
			}
			return nil, nil, nil, fmt.Errorf("sing-box 起来就退出了：%s", msg)
		default:
		}
		conn, err := net.DialTimeout("tcp", address, 300*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			break
		}
		if time.Now().After(deadline) {
			stop()
			return nil, nil, nil, errors.New("sing-box 没在 8 秒内监听起来")
		}
		time.Sleep(150 * time.Millisecond)
	}
	socks, err := proxy.SOCKS5("tcp", address, nil, &net.Dialer{Timeout: 10 * time.Second})
	if err != nil {
		stop()
		return nil, nil, nil, err
	}
	ctxDialer, ok := socks.(proxy.ContextDialer)
	if !ok {
		stop()
		return nil, nil, nil, errors.New("socks dialer does not support context")
	}
	return ctxDialer.DialContext, stop, func() string { return stderr.tail(400) }, nil
}

// lockedTail 只留 stderr 的最后 limit 个字节（sing-box 的错误日志），并发安全。
type lockedTail struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (t *lockedTail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.limit {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-t.limit:]...)
	}
	return len(p), nil
}

// tail 取最后 n 个字节里只含错误 / 警告的行（info 行太吵），没有就取最后几行。
func (t *lockedTail) tail(n int) string {
	t.mu.Lock()
	text := string(t.buf)
	t.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(text), "\n")
	var picked []string
	for _, line := range lines {
		if strings.Contains(line, "ERROR") || strings.Contains(line, "WARN") || strings.Contains(line, "FATAL") {
			picked = append(picked, strings.TrimSpace(line))
		}
	}
	if len(picked) == 0 {
		if len(lines) > 3 {
			lines = lines[len(lines)-3:]
		}
		picked = lines
	}
	out := strings.Join(picked, " | ")
	if len(out) > n {
		out = out[len(out)-n:]
	}
	return strings.TrimSpace(out)
}

// installNodeCheckSingbox 跑面板给的装机脚本把 sing-box 装到 forwardx-singbox 那个位置（和自建节点用同一个）。
func installNodeCheckSingbox(ctx context.Context, installCmd string) error {
	installCtx, cancel := context.WithTimeout(ctx, nodeCheckInstallWait)
	defer cancel()
	c, cleanup, _, err := shellCommand(installCtx, installCmd)
	if err != nil {
		return fmt.Errorf("装 sing-box 的脚本起不来：%v", err)
	}
	defer cleanup()
	output, err := c.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(output))
		if len(msg) > 300 {
			msg = msg[len(msg)-300:]
		}
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("装 sing-box 没成功：%s", msg)
	}
	logf("nodecheck installed sing-box for on-demand checks")
	return nil
}

// ---------------------------------------------------------------- 经节点的出口检测

func runExitCheck(ctx context.Context, dial nodeCheckDialFunc, viaProxy bool, family string, targets []siteLatencyTarget) (*exitCheckResult, error) {
	targets = normalizeSiteLatencyTargets(targets)
	result := &exitCheckResult{Sites: []siteLatencyReportTarget{}, Unlock: []unlockResult{}}
	// 站点握手和解锁检测并排跑：两边都是等网络，串着跑经代理要一两分钟。
	var wg sync.WaitGroup
	if len(targets) > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
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
		}()
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
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return result, err
	}
	return result, nil
}

// ---------------------------------------------------------------- 测速（Cloudflare / 面板）

// speedFallbackNote 前面的测速点为什么没测成、现在测的是什么。
func speedFallbackNote(tried []speedTarget, failures []string, used speedTarget, viaProxy bool) string {
	names := make([]string, 0, len(tried))
	for _, target := range tried {
		switch target.name {
		case "ookla":
			names = append(names, "就近的 Ookla 测速点")
		case "cloudflare":
			names = append(names, "Cloudflare")
		default:
			names = append(names, target.label)
		}
	}
	why := strings.Join(failures, "；")
	who := strings.Join(names, "、")
	// 英文结尾（「…、Cloudflare」）和后面的中文之间空一格
	if last := who[len(who)-1]; (last >= 'a' && last <= 'z') || (last >= 'A' && last <= 'Z') {
		who += " "
	}
	switch used.name {
	case "panel":
		where := "这台机器"
		if viaProxy {
			where = "整条链出口"
		}
		return fmt.Sprintf("%s都测不了（%s），改测到面板：测的是%s到面板这条路，上限是面板服务器自己的带宽，不代表%s的带宽", who, why, where, where)
	case "cloudflare":
		return fmt.Sprintf("%s测不了（%s），改对 Cloudflare 测", who, why)
	default:
		return fmt.Sprintf("%s测不了（%s）", who, why)
	}
}

func firstLine(value string) string {
	value = strings.TrimSpace(value)
	if i := strings.IndexByte(value, '\n'); i >= 0 {
		value = value[:i]
	}
	if len(value) > 200 {
		value = value[:200] + "…"
	}
	return value
}

func speedTestClient(dial nodeCheckDialFunc) *http.Client {
	transport := &http.Transport{
		Proxy:             nil,
		DialContext:       dial,
		ForceAttemptHTTP2: false, // 几条并行流各走各的连接，才测得出带宽
		MaxIdleConns:      32,
		// 默认每台只留 2 条空闲连接：四到六条流轮着要，多出来的每次都重新握手、重新慢启动。
		MaxIdleConnsPerHost:   16,
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

// speedHTTPError 测速服务器回了非 2xx：没有重试的意义（403 是被拒、413 是反代限制了请求体），
// 整段直接停下来报出去，而不是像以前那样把 403 的一个字节也当下载、把没送出去的上传也当成功。
type speedHTTPError struct {
	Status int
	Where  string
	Label  string
}

func (e *speedHTTPError) Error() string {
	return fmt.Sprintf("%s 回了 HTTP %d（%s）", e.Label, e.Status, e.Where)
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

func (t speedTarget) url(path string) string { return t.base + path }

func (t speedTarget) request(ctx context.Context, method, path string, body io.Reader) *http.Request {
	req, _ := http.NewRequestWithContext(ctx, method, t.url(path), body)
	req.Header.Set("User-Agent", "NEX-Agent/"+Version)
	req.Header.Set("Cache-Control", "no-store")
	for key, value := range t.headers {
		req.Header.Set(key, value)
	}
	return req
}

func is2xx(resp *http.Response) bool { return resp.StatusCode >= 200 && resp.StatusCode < 300 }

// parseCloudflareTrace 解析 /cdn-cgi/trace 的 key=value 行：ip、colo、loc。
func parseCloudflareTrace(body string, result *speedTestResult) {
	for _, line := range strings.Split(body, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		switch key {
		case "ip":
			if result.ClientIP == "" {
				result.ClientIP = value
			}
		case "colo":
			if result.Colo == "" {
				result.Colo = value
			}
		case "loc":
			if result.Country == "" {
				result.Country = value
			}
		}
	}
}

// fetchSpeedMeta 出口 IP / ASN / 机房。连都连不上（拨号 / TLS 失败、超时）就是整条路不通，返回错误；
// 连得上但回非 2xx（Cloudflare 的 /meta 对机房出口常回 403）不算失败，传输照测，再从 /cdn-cgi/trace 补。
func fetchSpeedMeta(ctx context.Context, client *http.Client, target speedTarget, result *speedTestResult) error {
	timeout := target.metaTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	metaCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	started := time.Now()
	resp, err := client.Do(target.request(metaCtx, http.MethodGet, target.meta, nil))
	if err != nil {
		return fmt.Errorf("连不上 %s：%v", target.label, err)
	}
	// 新连接上的第一个请求：经代理时这一下包括全部握手，单独记成「建连」。
	result.ConnectMs = math.Round(float64(time.Since(started).Microseconds())/100) / 10
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	var meta speedMeta
	if is2xx(resp) && json.Unmarshal(body, &meta) == nil {
		result.ClientIP = meta.ClientIP
		result.ASN = normalizeSpeedASN(meta.ASN)
		result.ASOrg = meta.ASOrganization
		result.Colo = meta.Colo
		result.Country = meta.Country
		result.City = meta.City
	}
	if target.trace != "" && (result.ClientIP == "" || result.Colo == "") {
		traceCtx, cancelTrace := context.WithTimeout(ctx, 10*time.Second)
		defer cancelTrace()
		if tr, err := client.Do(target.request(traceCtx, http.MethodGet, target.trace, nil)); err == nil {
			traceBody, _ := io.ReadAll(io.LimitReader(tr.Body, 16<<10))
			_ = tr.Body.Close()
			if is2xx(tr) {
				parseCloudflareTrace(string(traceBody), result)
			}
		}
	}
	return nil
}

// runHTTPSpeedTest 对一个测速服务器跑完整一轮：元数据（Ookla 是挑测速点，测不成换下一台）→ 延迟 → 下载 → 上传。
func runHTTPSpeedTest(ctx context.Context, dial nodeCheckDialFunc, target speedTarget, progress func(speedSample)) (*speedTestResult, error) {
	client := speedTestClient(dial)
	defer client.CloseIdleConnections()
	if target.name == "ookla" {
		return runOoklaSpeedTest(ctx, client, target, progress)
	}
	result := &speedTestResult{Samples: []speedSample{}, Server: target.name}
	if err := fetchSpeedMeta(ctx, client, target, result); err != nil {
		return nil, err
	}
	if err := measureSpeed(ctx, client, target, result, progress); err != nil {
		return nil, err
	}
	return result, nil
}

// measureSpeed 对 target 量延迟、下载、上传，写进 result。
func measureSpeed(ctx context.Context, client *http.Client, target speedTarget, result *speedTestResult, progress func(speedSample)) error {
	// 延迟：十次极小的请求，取到首字节的时间；延迟 = 中位数，抖动 = 相邻两次差的平均。只算 2xx 的。
	// 先发一个不算的：meta 回非 2xx 时连接可能没留下，这一下把连接重新建好，后面十次都在建好的
	// 连接上，量的是来回一趟（以前握手那一下也算进去，抖动被它拉到几百毫秒）。
	warmCtx, cancelWarm := context.WithTimeout(ctx, 15*time.Second)
	if rs, err := client.Do(target.latencyRequest(warmCtx)); err == nil {
		_, _ = io.Copy(io.Discard, rs.Body)
		_ = rs.Body.Close()
	}
	cancelWarm()
	var latencies []float64
	var lastErr error
	for i := 0; i < speedTestLatencyN; i++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		started := time.Now()
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		rs, err := client.Do(target.latencyRequest(reqCtx))
		if err == nil {
			_, _ = io.Copy(io.Discard, rs.Body)
			_ = rs.Body.Close()
			if is2xx(rs) {
				latencies = append(latencies, float64(time.Since(started).Microseconds())/1000)
			} else {
				lastErr = speedStatusError(rs, target, target.downloadWhere())
			}
		} else {
			lastErr = err
		}
		cancel()
	}
	if len(latencies) == 0 {
		if lastErr != nil {
			return fmt.Errorf("延迟测试全部失败：%v", lastErr)
		}
		return errors.New("延迟测试全部失败")
	}
	result.LatencyMs, result.JitterMs = summarizeLatencies(latencies)

	start := time.Now()
	streams := target.streamCount()
	// 下载：收到的字节是真到了的，边收边算。
	if progress != nil {
		progress(speedSample{phase: "download"})
	}
	down := &byteCounter{}
	downMbps, err := runSpeedPhase(ctx, speedTestDownDuration, streams, down, func(phaseCtx context.Context) error {
		rs, err := client.Do(target.downloadRequest(phaseCtx))
		if err != nil {
			return err
		}
		defer rs.Body.Close()
		if !is2xx(rs) {
			_, _ = io.Copy(io.Discard, io.LimitReader(rs.Body, 4096))
			return speedStatusError(rs, target, target.downloadWhere())
		}
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
		return err
	}
	result.DownloadMbps = downMbps
	result.DownloadBytes = down.get()
	if downMbps < 0.1 {
		// 收到过字节、速度却是零：下行卡住了（限速、丢包或这条链下行有问题），别只给一个 0。
		result.Note = fmt.Sprintf("下载几乎没速度：一共只收到 %d KB", down.get()>>10)
	}

	// 上传：只算服务器说收下了的字节（见 ext_speedtest.go），每次送多大跟着速度调。
	if progress != nil {
		progress(speedSample{phase: "upload"})
	}
	sent := &countingTotal{}
	prefix := ""
	if target.ookla != nil {
		prefix = "content1="
	}
	upStart := time.Since(start)
	redirect := &uploadRedirect{}
	upMbps, _, err := runUploadPhase(ctx, speedTestUpDuration, streams, target.uploadMaxBytes(), func(phaseCtx context.Context, size int64) (int64, error) {
		req := target.uploadRequest(phaseCtx, &patternReader{remaining: size, prefix: prefix, sent: sent}, size)
		redirect.apply(req)
		// 测速点把上传 307 / 308 转到别处时，Go 要能重新拿到请求体才会跟过去（2.2.246 没给，Ookla 回 307 就整段失败）
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(&patternReader{remaining: size, prefix: prefix, sent: sent}), nil
		}
		rs, err := client.Do(req)
		if err != nil {
			return 0, err
		}
		body, _ := io.ReadAll(io.LimitReader(rs.Body, 4096))
		_ = rs.Body.Close()
		if !is2xx(rs) {
			return 0, speedStatusError(rs, target, target.uploadWhere())
		}
		redirect.remember(req, rs)
		return target.confirmedUpload(body, size), nil
	}, func(at time.Duration, mbps float64) {
		sample := speedSample{T: (upStart + at).Milliseconds(), Up: mbps}
		result.Samples = append(result.Samples, sample)
		if progress != nil {
			progress(sample)
		}
	})
	if err != nil {
		return err
	}
	result.UploadMbps = upMbps
	result.UploadBytes = sent.get()
	return nil
}

// runSpeedPhase 起 streams 条流各自反复跑 stream（下载用；上传见 runUploadPhase）；每 speedTestSampleEvery 采一次这段时间的速率。
// 从第一个字节到了才开始算：先丢掉 speedTestWarmup（TCP 慢启动），再量满 duration - warmup。经代理、
// 几跳中转时第一个字节来得晚，最多多等 speedTestMaxExtra —— 以前从开始就计时，握手吃掉大半，量到的
// 几乎都是零。返回量到的平均速率（Mbit/s）。
// 流回 speedHTTPError（被拒 / 被限）就整段停下来报错：再试也是一样的。
func runSpeedPhase(ctx context.Context, duration time.Duration, streams int, counter *byteCounter, stream func(ctx context.Context) error, sample func(mbps float64)) (float64, error) {
	phaseCtx, cancel := context.WithTimeout(ctx, duration+speedTestMaxExtra)
	defer cancel()
	var wg sync.WaitGroup
	var firstErr, fatalErr error
	var errMu sync.Mutex
	if streams <= 0 {
		streams = speedTestStreams
	}
	for i := 0; i < streams; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			retries := 0
			for phaseCtx.Err() == nil {
				err := stream(phaseCtx)
				if err == nil {
					continue
				}
				if phaseCtx.Err() != nil {
					// 到点被我们自己掐掉的，不算错。传了字节的也算成功。
					return
				}
				// 限流（429）说了几秒后再来：等一下接着测；说要等很久就整段停下来换测速点。
				var rateErr *speedRateLimitError
				if errors.As(err, &rateErr) && rateErr.RetryAfter <= speedTestRetryAfterMax && retries < speedTestRetryLimit {
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
				}
				var httpErr *speedHTTPError
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				if (errors.As(err, &httpErr) || errors.As(err, &rateErr)) && fatalErr == nil {
					fatalErr = err
				}
				fatal := fatalErr != nil
				errMu.Unlock()
				if fatal {
					cancel()
					return
				}
				time.Sleep(300 * time.Millisecond)
			}
		}()
	}
	started := time.Now()
	ticker := time.NewTicker(speedTestSampleEvery)
	defer ticker.Stop()
	lastBytes := int64(0)
	lastAt := started
	var firstByteAt time.Time
	var measured []float64
	for {
		select {
		case <-phaseCtx.Done():
			wg.Wait()
			errMu.Lock()
			fatal, first := fatalErr, firstErr
			errMu.Unlock()
			if fatal != nil {
				return 0, fmt.Errorf("测速失败：%v", fatal)
			}
			if ctx.Err() != nil {
				return 0, ctx.Err()
			}
			if counter.get() <= 0 {
				if first == nil {
					first = errors.New("没有传输到任何数据")
				}
				return 0, fmt.Errorf("测速失败：%v", first)
			}
			if len(measured) == 0 {
				return 0, errors.New("测速时间太短")
			}
			return speedSummary(measured), nil
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
			if mbps < 0 {
				mbps = 0
			}
			if sample != nil {
				sample(mbps)
			}
			if firstByteAt.IsZero() && total > 0 {
				// 字节是这一格里某个时候到的，按这一格开头算
				firstByteAt = now.Add(-speedTestSampleEvery)
			}
			if !firstByteAt.IsZero() && now.Sub(firstByteAt) >= speedTestWarmup {
				measured = append(measured, mbps)
			}
			// 量够了就停：跑满 duration，而且第一个字节以后也量满了 duration（含 warmup）。
			if now.Sub(started) >= duration && !firstByteAt.IsZero() && now.Sub(firstByteAt) >= duration {
				cancel()
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
