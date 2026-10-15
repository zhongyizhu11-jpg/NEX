package main

/*
经其他主机连面板（第五套主题 #8）—— 被中转那一端。

有的机器到面板那段路很差（面板在国内、机器在海外），心跳一会儿通一会儿不通，面板上
就一直在「离线」和「在线」之间跳。办法是让它改连一台到面板路况好的主机，由那台机器上
的 Agent 原样把 TCP 转给面板（见 ext_relay.go 的 panelRelayListener）。

这里只改「拨号」这一步：面板地址（URL）一个字不动，TLS 的 SNI、Host 头、请求加密
全都照旧，只是拨 面板主机:端口 的那一下改成拨 中转主机:端口。所有和面板说话的
HTTP 客户端（心跳、在线信号、事件流、流量上报、扩展通道、升级下载……）都用
newAgentHTTPTransport 建的 Transport，它的 DialContext 就是 agentPanelDialContext，
所以一处改动全部生效；拨的不是面板地址（查公网 IP 之类）就原样直拨。

中转坏了绝不能把机器弄丢：
  - 连续 3 次经中转失败，或者从第一次失败起 2 分钟内一次都没成功，就退回直连；
  - 退回后按 30 秒、1 分钟、2 分钟、5 分钟、之后每 10 分钟，用一个单独的请求试一下
    中转，通了才切回去；
  - 刚收到「改走中转」时也先试一下，试通了才切，没通就先直连着、按上面的节奏再试。
「成功」的判定放在连接上：经中转的连接读到了面板回的第一个字节才算通；发出了请求、
一个字节都没收到就断了（中转连不上面板时就是这样）算失败。只拨通、没用过就被连接池
关掉的连接不算数。
中转接下连接就挂断时，Go 的 Transport 是读和写两个 goroutine：读那边可能先于写那边
拿到 EOF，这时连接上还一个字节都没写。所以 Read 里「一个字节没读到就断了」不要求已经
写过 —— 一条刚拨通、正要发请求的连接被中转挂断，同样算失败；
只有 Close 那条（可能是连接池收掉一条没用过的连接）才要求写过。

当前设置写在 /var/lib/forwardx-agent/panel-relay.json，Agent 重启后照样经中转；文件里
同时写着现在是否真的在用中转（active），FXP 进程上报流量时读的也是它。
*/

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	panelRelayFailThreshold = 3
	panelRelayFailWindow    = 2 * time.Minute
	panelRelayDialTimeout   = 10 * time.Second
	panelRelayProbeTimeout  = 12 * time.Second
)

// 退回直连之后试中转的间隔：先密后疏，最后每 10 分钟一次。
var panelRelayProbeBackoff = []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute}

var panelRelayStatePath = "/var/lib/forwardx-agent/panel-relay.json"

// panelRelayDirectDialer 和 http.DefaultTransport 用的拨号参数一致。
var panelRelayDirectDialer = &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}

type panelRelayPersisted struct {
	Via       string `json:"via"`
	PanelAddr string `json:"panelAddr"`
	Active    bool   `json:"active"`
	UpdatedAt int64  `json:"updatedAt"`
}

// panelRelayState 是纯状态机：时间从外面传进来，测试不用睡。
type panelRelayState struct {
	mu sync.Mutex

	via       string // 中转地址 host:port；空 = 直连
	panelAddr string // 这份设置针对的面板地址（小写 host:port）；面板地址变了就不再适用

	fallback            bool // 中转坏了，正退回直连
	fallbackSince       time.Time
	fallbackCount       int
	consecutiveFailures int
	firstFailureAt      time.Time
	probeAttempt        int
	nextProbeAt         time.Time
	probing             bool
	lastError           string
	lastErrorAt         time.Time
	lastSuccessAt       time.Time
}

// panelAddrFromURL 把面板 URL 变成拨号时 Transport 给的那种地址：host:port（端口按协议补全）。
func panelAddrFromURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return ""
	}
	host := parsed.Hostname()
	port := parsed.Port()
	if port == "" {
		switch strings.ToLower(parsed.Scheme) {
		case "https":
			port = "443"
		case "http":
			port = "80"
		default:
			return ""
		}
	}
	return strings.ToLower(net.JoinHostPort(host, port))
}

func normalizeDialAddr(addr string) string {
	host, port, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return strings.ToLower(strings.TrimSpace(addr))
	}
	return strings.ToLower(net.JoinHostPort(host, port))
}

// validRelayVia 只接受 IP:端口 或 域名:端口。
func validRelayVia(via string) bool {
	host, port, err := net.SplitHostPort(strings.TrimSpace(via))
	if err != nil || host == "" {
		return false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return false
	}
	if net.ParseIP(host) != nil {
		return true
	}
	for _, r := range host {
		if !(r == '.' || r == '-' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')) {
			return false
		}
	}
	return true
}

// configure 换一份设置。返回 true 表示设置真的变了（调用方据此清连接池、落盘、先试一次）。
// 新设置一律先当作「退回直连、马上试」：试通了才真的走中转。
func (s *panelRelayState) configure(via, panelAddr string, now time.Time) bool {
	via = strings.TrimSpace(via)
	panelAddr = normalizeDialAddr(panelAddr)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.via == via && s.panelAddr == panelAddr {
		return false
	}
	s.via = via
	s.panelAddr = panelAddr
	s.consecutiveFailures = 0
	s.firstFailureAt = time.Time{}
	s.probeAttempt = 0
	s.lastError = ""
	s.lastErrorAt = time.Time{}
	if via == "" {
		s.fallback = false
		s.fallbackSince = time.Time{}
		s.nextProbeAt = time.Time{}
		return true
	}
	s.fallback = true
	s.fallbackSince = now
	s.nextProbeAt = now
	return true
}

// restore 从磁盘恢复：上次在用中转就直接接着用（坏了按失败计数退回），没在用就等着试。
func (s *panelRelayState) restore(saved panelRelayPersisted, now time.Time) {
	if saved.Via == "" || !validRelayVia(saved.Via) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.via = saved.Via
	s.panelAddr = normalizeDialAddr(saved.PanelAddr)
	if saved.Active {
		s.fallback = false
	} else {
		s.fallback = true
		s.fallbackSince = now
		s.nextProbeAt = now
	}
}

// route 决定这一次拨号拨哪里。viaRelay=false 时 target 就是原地址。
func (s *panelRelayState) route(addr string) (target string, viaRelay bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.via == "" || s.fallback || s.panelAddr == "" || normalizeDialAddr(addr) != s.panelAddr {
		return addr, false
	}
	return s.via, true
}

// noteSuccess 记一次经中转成功。
func (s *panelRelayState) noteSuccess(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.consecutiveFailures = 0
	s.firstFailureAt = time.Time{}
	s.lastSuccessAt = now
}

// noteFailure 记一次经中转失败；返回 true 表示这次失败让它退回了直连。
func (s *panelRelayState) noteFailure(errText string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastError = errText
	s.lastErrorAt = now
	if s.via == "" || s.fallback {
		return false
	}
	if s.consecutiveFailures == 0 {
		s.firstFailureAt = now
	}
	s.consecutiveFailures++
	if s.consecutiveFailures >= panelRelayFailThreshold || now.Sub(s.firstFailureAt) >= panelRelayFailWindow {
		s.fallback = true
		s.fallbackSince = now
		s.fallbackCount++
		s.consecutiveFailures = 0
		s.firstFailureAt = time.Time{}
		s.probeAttempt = 0
		s.nextProbeAt = now.Add(panelRelayProbeBackoff[0])
		return true
	}
	return false
}

// claimProbe 到点了就领走这一次试探（同一时刻只有一个在跑）。
func (s *panelRelayState) claimProbe(now time.Time) (via string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.via == "" || !s.fallback || s.probing || now.Before(s.nextProbeAt) {
		return "", false
	}
	s.probing = true
	return s.via, true
}

// finishProbe 收试探结果；via 不是当前设置（中途换了）就作废。返回 true 表示切回了中转。
func (s *panelRelayState) finishProbe(via string, err error, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.probing = false
	if via != s.via || s.via == "" || !s.fallback {
		return false
	}
	if err == nil {
		s.fallback = false
		s.fallbackSince = time.Time{}
		s.probeAttempt = 0
		s.consecutiveFailures = 0
		s.firstFailureAt = time.Time{}
		s.lastSuccessAt = now
		return true
	}
	s.lastError = err.Error()
	s.lastErrorAt = now
	index := s.probeAttempt
	if index >= len(panelRelayProbeBackoff) {
		index = len(panelRelayProbeBackoff) - 1
	}
	s.nextProbeAt = now.Add(panelRelayProbeBackoff[index])
	s.probeAttempt++
	return false
}

type panelRelaySnapshot struct {
	Via           string
	PanelAddr     string
	Active        bool
	Fallback      bool
	FallbackSince time.Time
	FallbackCount int
	LastError     string
	LastErrorAt   time.Time
	LastSuccessAt time.Time
	NextProbeAt   time.Time
}

func (s *panelRelayState) snapshot() panelRelaySnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return panelRelaySnapshot{
		Via: s.via, PanelAddr: s.panelAddr, Active: s.via != "" && !s.fallback, Fallback: s.via != "" && s.fallback,
		FallbackSince: s.fallbackSince, FallbackCount: s.fallbackCount,
		LastError: s.lastError, LastErrorAt: s.lastErrorAt, LastSuccessAt: s.lastSuccessAt, NextProbeAt: s.nextProbeAt,
	}
}

var (
	panelRelay         = &panelRelayState{}
	panelRelayLoadOnce sync.Once
)

func ensurePanelRelayLoaded() {
	panelRelayLoadOnce.Do(func() {
		raw, err := os.ReadFile(panelRelayStatePath)
		if err != nil {
			return
		}
		var saved panelRelayPersisted
		if json.Unmarshal(raw, &saved) != nil {
			return
		}
		panelRelay.restore(saved, time.Now())
		if saved.Via != "" {
			logf("panel relay restored via=%s active=%v", saved.Via, saved.Active)
			go panelRelayProbeLoop()
		}
	})
}

func persistPanelRelayState() {
	snap := panelRelay.snapshot()
	if snap.Via == "" {
		if err := os.Remove(panelRelayStatePath); err != nil && !os.IsNotExist(err) {
			logf("panel relay state remove failed: %v", err)
		}
		return
	}
	raw, _ := json.Marshal(panelRelayPersisted{Via: snap.Via, PanelAddr: snap.PanelAddr, Active: snap.Active, UpdatedAt: time.Now().Unix()})
	_ = os.MkdirAll(filepath.Dir(panelRelayStatePath), 0755)
	if err := writeFileAtomicDurable(panelRelayStatePath, raw, 0600); err != nil {
		logf("panel relay state write failed: %v", err)
	}
}

// panelRelayIdleClients 在 init 里填（直接引用那几个客户端变量会形成包级变量初始化环）。
var panelRelayIdleClients func() []*http.Client

func init() {
	panelRelayIdleClients = func() []*http.Client {
		return []*http.Client{agentSyncHTTPClient, agentPresenceHTTPClient, agentEventHTTPClient}
	}
}

// closeAgentPanelIdleConnections 切换线路后把连接池里的旧连接放掉，下一次请求按新线路拨。
func closeAgentPanelIdleConnections() {
	if panelRelayIdleClients == nil {
		return
	}
	for _, client := range panelRelayIdleClients() {
		if client != nil {
			client.CloseIdleConnections()
		}
	}
}

// agentPanelDialContext 是所有面板 HTTP 客户端的拨号函数（见 newAgentHTTPTransport）。
func agentPanelDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	ensurePanelRelayLoaded()
	target, viaRelay := panelRelay.route(addr)
	if !viaRelay {
		return panelRelayDirectDialer.DialContext(ctx, network, addr)
	}
	dialCtx, cancel := context.WithTimeout(ctx, panelRelayDialTimeout)
	defer cancel()
	conn, err := panelRelayDirectDialer.DialContext(dialCtx, "tcp", target)
	if err != nil {
		// 调用方自己取消的（请求超时、Agent 退出）不算中转的错。
		if ctx.Err() == nil {
			notePanelRelayFailure(fmt.Sprintf("连不上中转 %s：%v", target, err))
		}
		return nil, err
	}
	return &panelRelayTrackedConn{Conn: conn}, nil
}

func notePanelRelayFailure(errText string) {
	if panelRelay.noteFailure(errText, time.Now()) {
		logf("panel relay failed %d times; falling back to direct: %s", panelRelayFailThreshold, errText)
		persistPanelRelayState()
		closeAgentPanelIdleConnections()
	}
}

// panelRelayTrackedConn 看一条经中转的连接到底通没通（见文件头）。
type panelRelayTrackedConn struct {
	net.Conn
	read     atomic.Int64
	written  atomic.Int64
	reported atomic.Bool
}

func (c *panelRelayTrackedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 && c.read.Add(int64(n)) == int64(n) && c.reported.CompareAndSwap(false, true) {
		panelRelay.noteSuccess(time.Now())
	}
	if err != nil && n == 0 && c.read.Load() == 0 && !errors.Is(err, net.ErrClosed) {
		if c.reported.CompareAndSwap(false, true) {
			if c.written.Load() > 0 {
				notePanelRelayFailure("中转没有转回面板的回应：" + err.Error())
			} else {
				notePanelRelayFailure("中转接下连接就断开了，请求还没发出：" + err.Error())
			}
		}
	}
	return n, err
}

func (c *panelRelayTrackedConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.written.Add(int64(n))
	}
	return n, err
}

func (c *panelRelayTrackedConn) Close() error {
	if c.read.Load() == 0 && c.written.Load() > 0 && c.reported.CompareAndSwap(false, true) {
		notePanelRelayFailure("经中转发出请求后一直没有回应")
	}
	return c.Conn.Close()
}

// probePanelViaRelayHook 让测试换掉真正的试探；nil 时走 probePanelViaRelay。
var probePanelViaRelayHook func(panelURL, via string) error

// probePanelViaRelay 经中转向面板发一个请求，收到任何 HTTP 回应都算通。
func probePanelViaRelay(panelURL, via string) error {
	if probePanelViaRelayHook != nil {
		return probePanelViaRelayHook(panelURL, via)
	}
	transport := newAgentHTTPTransport(false)
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialCtx, cancel := context.WithTimeout(ctx, panelRelayDialTimeout)
		defer cancel()
		return panelRelayDirectDialer.DialContext(dialCtx, "tcp", via)
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: panelRelayProbeTimeout, Transport: transport}
	req, err := http.NewRequest(http.MethodHead, strings.TrimRight(panelURL, "/")+"/", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Cache-Control", "no-store")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	_ = res.Body.Close()
	return nil
}

var panelRelayProbeLoopRunning atomic.Bool

// panelRelayProbeLoop 在有中转设置期间常驻，到点就试一次中转。
func panelRelayProbeLoop() {
	if !panelRelayProbeLoopRunning.CompareAndSwap(false, true) {
		return
	}
	defer panelRelayProbeLoopRunning.Store(false)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		runPanelRelayProbeIfDue()
		if panelRelay.snapshot().Via == "" {
			return
		}
		<-ticker.C
	}
}

func runPanelRelayProbeIfDue() {
	via, ok := panelRelay.claimProbe(time.Now())
	if !ok {
		return
	}
	err := probePanelViaRelay(currentPanelURL(Config{}), via)
	if panelRelay.finishProbe(via, err, time.Now()) {
		logf("panel relay via=%s reachable; now dialing the panel through it", via)
		persistPanelRelayState()
		closeAgentPanelIdleConnections()
	} else if err != nil && shouldLogAgentReport("panel-relay-probe", 10*time.Minute) {
		logf("panel relay probe via=%s failed; staying direct: %v", via, err)
	}
}

// setPanelRelayVia 收面板的「经由」设置（空 = 直连）。
func setPanelRelayVia(cfg Config, via string) {
	ensurePanelRelayLoaded()
	via = strings.TrimSpace(via)
	if via != "" && !validRelayVia(via) {
		logf("panel relay ignored invalid via=%q", via)
		via = ""
	}
	panelAddr := panelAddrFromURL(currentPanelURL(cfg))
	if via != "" && panelAddr == "" {
		via = ""
	}
	if !panelRelay.configure(via, panelAddr, time.Now()) {
		return
	}
	if via == "" {
		logf("panel relay cleared; dialing the panel directly")
	} else {
		logf("panel relay set via=%s panel=%s; probing before switching", via, panelAddr)
		go panelRelayProbeLoop()
	}
	persistPanelRelayState()
	closeAgentPanelIdleConnections()
}
