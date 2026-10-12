package main

/*
经其他主机连面板（第五套主题 #8）—— 扩展模块 "relay"，两个角色共用一个模块：

  指令 {via?: "中转IP:端口", listen?: {port, target, allow[]}}
    via    这台机器自己连面板时改拨的地址（见 panel_dial.go）；没有 = 直连。
    listen 这台机器给别的机器当中转：在 port 上收 TCP，原样转给 target（面板的 host:port），
           只接受 allow 里那些 IP（就是挂在它上面的那几台主机）。
  上报 {role, viaActive, fallbackActive, lastError, relayedConnections, ...}

中转本身就是一个最朴素的 TCP 转发：两头 io.Copy，各带空闲超时。转发的是 Agent 和
面板之间已经加密过的 HTTP(S)，中转机看不到也改不了里面的内容。
*/

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	panelRelayListenIdleTimeout = 6 * time.Minute
	panelRelayListenMaxConns    = 512
	panelRelayListenRetryEvery  = 30 * time.Second
)

type relayListenDirective struct {
	Port   int      `json:"port"`
	Target string   `json:"target"`
	Allow  []string `json:"allow"`
}

type relayDirective struct {
	Via    string                `json:"via"`
	Listen *relayListenDirective `json:"listen"`
}

// panelRelayListener 是中转那一端。
type panelRelayListener struct {
	mu          sync.Mutex
	ln          net.Listener
	port        int
	target      string
	lastError   string
	lastAttempt time.Time

	allow    atomic.Value // map[string]bool，键是规范化后的 IP
	allowNet atomic.Value // []*net.IPNet
	targetV  atomic.Value // string

	relayed  atomic.Int64
	active   atomic.Int64
	rejected atomic.Int64
	failed   atomic.Int64
}

func newPanelRelayListener() *panelRelayListener {
	l := &panelRelayListener{}
	l.allow.Store(map[string]bool{})
	l.allowNet.Store([]*net.IPNet(nil))
	l.targetV.Store("")
	return l
}

func normalizeRelayIP(ip net.IP) string {
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

func (l *panelRelayListener) setAllow(entries []string) {
	allow := map[string]bool{}
	var nets []*net.IPNet
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			if _, network, err := net.ParseCIDR(entry); err == nil {
				nets = append(nets, network)
			}
			continue
		}
		if ip := net.ParseIP(strings.Trim(entry, "[]")); ip != nil {
			allow[normalizeRelayIP(ip)] = true
		}
	}
	l.allow.Store(allow)
	l.allowNet.Store(nets)
}

func (l *panelRelayListener) allowed(addr net.Addr) bool {
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if l.allow.Load().(map[string]bool)[normalizeRelayIP(ip)] {
		return true
	}
	for _, network := range l.allowNet.Load().([]*net.IPNet) {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// apply 按指令开 / 关 / 换端口；指令每轮都会重发，没变化时几乎不做事。
func (l *panelRelayListener) apply(d *relayListenDirective, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if d == nil || d.Port <= 0 || d.Port > 65535 || strings.TrimSpace(d.Target) == "" {
		l.stopLocked()
		l.port = 0
		l.target = ""
		l.lastError = ""
		return
	}
	target := strings.TrimSpace(d.Target)
	if _, _, err := net.SplitHostPort(target); err != nil {
		l.stopLocked()
		l.lastError = "中转目标地址不对：" + target
		return
	}
	l.setAllow(d.Allow)
	l.targetV.Store(target)
	l.target = target
	if l.ln != nil && l.port == d.Port {
		return
	}
	l.stopLocked()
	if !l.lastAttempt.IsZero() && now.Sub(l.lastAttempt) < panelRelayListenRetryEvery && l.port == d.Port {
		return
	}
	l.lastAttempt = now
	l.port = d.Port
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(d.Port))
	if err != nil {
		l.lastError = "端口 " + strconv.Itoa(d.Port) + " 监听失败：" + err.Error()
		logf("panel relay listen :%d failed: %v", d.Port, err)
		return
	}
	l.ln = ln
	l.lastError = ""
	logf("panel relay listening on :%d -> %s", d.Port, target)
	go l.serve(ln)
}

func (l *panelRelayListener) stopLocked() {
	if l.ln != nil {
		_ = l.ln.Close()
		logf("panel relay listener :%d stopped", l.port)
	}
	l.ln = nil
}

func (l *panelRelayListener) stop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.stopLocked()
	l.port = 0
}

func (l *panelRelayListener) addr() net.Addr {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ln == nil {
		return nil
	}
	return l.ln.Addr()
}

func (l *panelRelayListener) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				time.Sleep(50 * time.Millisecond)
				continue
			}
			logf("panel relay accept failed: %v", err)
			time.Sleep(time.Second)
			continue
		}
		if !l.allowed(conn.RemoteAddr()) {
			l.rejected.Add(1)
			_ = conn.Close()
			continue
		}
		if l.active.Load() >= panelRelayListenMaxConns {
			l.rejected.Add(1)
			_ = conn.Close()
			continue
		}
		go l.handle(conn)
	}
}

func (l *panelRelayListener) handle(client net.Conn) {
	l.active.Add(1)
	defer l.active.Add(-1)
	defer client.Close()
	target, _ := l.targetV.Load().(string)
	if target == "" {
		return
	}
	upstream, err := net.DialTimeout("tcp", target, panelRelayDialTimeout)
	if err != nil {
		l.failed.Add(1)
		l.mu.Lock()
		l.lastError = "连不上面板 " + target + "：" + err.Error()
		l.mu.Unlock()
		return
	}
	defer upstream.Close()
	l.relayed.Add(1)
	if tcp, ok := client.(*net.TCPConn); ok {
		_ = tcp.SetKeepAlive(true)
		_ = tcp.SetKeepAlivePeriod(30 * time.Second)
	}
	if tcp, ok := upstream.(*net.TCPConn); ok {
		_ = tcp.SetKeepAlive(true)
		_ = tcp.SetKeepAlivePeriod(30 * time.Second)
	}
	done := make(chan struct{}, 2)
	go func() {
		relayCopyWithIdle(upstream, client, panelRelayListenIdleTimeout)
		done <- struct{}{}
	}()
	go func() {
		relayCopyWithIdle(client, upstream, panelRelayListenIdleTimeout)
		done <- struct{}{}
	}()
	// 任何一头结束就两头都关：转的是 HTTP，不需要半关闭。
	<-done
	_ = client.Close()
	_ = upstream.Close()
	<-done
}

// relayCopyWithIdle 是带空闲超时的 io.Copy：每读到一次数据就把截止时间往后推。
func relayCopyWithIdle(dst, src net.Conn, idle time.Duration) {
	buf := make([]byte, 32*1024)
	for {
		_ = src.SetReadDeadline(time.Now().Add(idle))
		n, err := src.Read(buf)
		if n > 0 {
			_ = dst.SetWriteDeadline(time.Now().Add(idle))
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			// io.EOF 或超时、对端断开：这一个方向结束。
			return
		}
	}
}

type relayListenReport struct {
	Port      int    `json:"port"`
	Listening bool   `json:"listening"`
	Target    string `json:"target,omitempty"`
	Error     string `json:"error,omitempty"`
}

type relayReport struct {
	Role           string `json:"role"`
	Via            string `json:"via,omitempty"`
	ViaActive      bool   `json:"viaActive"`
	FallbackActive bool   `json:"fallbackActive"`
	FallbackSince  int64  `json:"fallbackSince,omitempty"`
	FallbackCount  int    `json:"fallbackCount,omitempty"`
	LastError      string `json:"lastError,omitempty"`
	LastErrorAt    int64  `json:"lastErrorAt,omitempty"`
	PanelAddr      string `json:"panelAddr,omitempty"`
	// 这台机器的公网出口 IP：面板拿它补中转的放行名单（主机地址可能是手填的入口域名）。
	PublicIPs          []string           `json:"publicIps,omitempty"`
	Listen             *relayListenReport `json:"listen,omitempty"`
	RelayedConnections int64              `json:"relayedConnections"`
	ActiveConnections  int64              `json:"activeConnections"`
	RejectedConns      int64              `json:"rejectedConnections"`
	FailedConns        int64              `json:"failedConnections"`
}

type relayExtModule struct {
	mu       sync.Mutex
	lastHash string
	listener *panelRelayListener
}

func (m *relayExtModule) Name() string { return "relay" }

func (m *relayExtModule) Report(cfg Config) any {
	ensurePanelRelayLoaded()
	snap := panelRelay.snapshot()
	report := relayReport{
		Via:            snap.Via,
		ViaActive:      snap.Active,
		FallbackActive: snap.Fallback,
		FallbackCount:  snap.FallbackCount,
		LastError:      snap.LastError,
		PanelAddr:      panelAddrFromURL(currentPanelURL(cfg)),
	}
	if ipv4, ipv6 := publicIPs(); ipv4 != "" || ipv6 != "" {
		for _, ip := range []string{ipv4, ipv6} {
			if ip != "" {
				report.PublicIPs = append(report.PublicIPs, ip)
			}
		}
	}
	if !snap.FallbackSince.IsZero() && snap.Fallback {
		report.FallbackSince = snap.FallbackSince.Unix()
	}
	if !snap.LastErrorAt.IsZero() {
		report.LastErrorAt = snap.LastErrorAt.Unix()
	}
	relayed := false
	l := m.listener
	if l != nil {
		l.mu.Lock()
		if l.port > 0 || l.lastError != "" {
			relayed = true
			report.Listen = &relayListenReport{Port: l.port, Listening: l.ln != nil, Target: l.target, Error: l.lastError}
		}
		l.mu.Unlock()
		report.RelayedConnections = l.relayed.Load()
		report.ActiveConnections = l.active.Load()
		report.RejectedConns = l.rejected.Load()
		report.FailedConns = l.failed.Load()
	}
	switch {
	case snap.Via != "" && relayed:
		report.Role = "both"
	case snap.Via != "":
		report.Role = "relayed"
	case relayed:
		report.Role = "relay"
	default:
		report.Role = "none"
	}
	return report
}

func (m *relayExtModule) Apply(cfg Config, directive json.RawMessage) {
	sum := sha256.Sum256(directive)
	hash := hex.EncodeToString(sum[:])
	m.mu.Lock()
	if m.listener == nil {
		m.listener = newPanelRelayListener()
	}
	listener := m.listener
	unchanged := hash == m.lastHash
	m.mu.Unlock()
	var d relayDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		logf("relay directive invalid: %v", err)
		return
	}
	// 指令没变时也要调一下 listener.apply：上次没监听成功（端口被占）的要按节奏重试。
	listener.apply(d.Listen, time.Now())
	if unchanged {
		return
	}
	setPanelRelayVia(cfg, d.Via)
	m.mu.Lock()
	m.lastHash = hash
	m.mu.Unlock()
}

func init() {
	registerExtModule(&relayExtModule{})
}
