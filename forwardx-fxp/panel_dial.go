package main

/*
经其他主机连面板（面板第五套主题 #8）在 FXP 这边的那一小块。

Agent 可以被设成「经由另一台主机连面板」：拨面板地址时改拨中转主机（见 agent/panel_dial.go）。
FXP 出口 / 入口自己也向面板报流量，走的是 trafficHTTPClient —— 不跟着改的话，Agent 经中转
在线，FXP 的流量上报却照旧直连、一直失败。

Agent 把「现在是否真的在用中转」写在 /var/lib/forwardx-agent/panel-relay.json（active）。
这里每 5 秒看一眼那个文件（只在修改时间变了才重读），active 时拨面板地址改拨中转；
中转拨不通就当场直拨一次 —— 判断中转好坏、退回直连是 Agent 的事，FXP 只跟随。
*/

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

var fxpPanelRelayStatePath = "/var/lib/forwardx-agent/panel-relay.json"

const fxpPanelRelayRecheck = 5 * time.Second

type fxpPanelRelayCache struct {
	mu        sync.Mutex
	checkedAt time.Time
	modTime   time.Time
	via       string
	panelAddr string
	active    bool
}

var fxpPanelRelay = &fxpPanelRelayCache{}

func fxpNormalizeDialAddr(addr string) string {
	host, port, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return strings.ToLower(strings.TrimSpace(addr))
	}
	return strings.ToLower(net.JoinHostPort(host, port))
}

// route 返回这次拨号该改拨的中转地址；不改拨返回空串。
func (c *fxpPanelRelayCache) route(addr string, now time.Time) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.checkedAt.IsZero() || now.Sub(c.checkedAt) >= fxpPanelRelayRecheck {
		c.checkedAt = now
		c.reloadLocked()
	}
	if !c.active || c.via == "" || c.panelAddr == "" || fxpNormalizeDialAddr(addr) != c.panelAddr {
		return ""
	}
	return c.via
}

func (c *fxpPanelRelayCache) reloadLocked() {
	info, err := os.Stat(fxpPanelRelayStatePath)
	if err != nil {
		c.via, c.panelAddr, c.active, c.modTime = "", "", false, time.Time{}
		return
	}
	if info.ModTime().Equal(c.modTime) {
		return
	}
	c.modTime = info.ModTime()
	raw, err := os.ReadFile(fxpPanelRelayStatePath)
	if err != nil {
		return
	}
	var saved struct {
		Via       string `json:"via"`
		PanelAddr string `json:"panelAddr"`
		Active    bool   `json:"active"`
	}
	if json.Unmarshal(raw, &saved) != nil {
		c.via, c.panelAddr, c.active = "", "", false
		return
	}
	c.via = strings.TrimSpace(saved.Via)
	c.panelAddr = fxpNormalizeDialAddr(saved.PanelAddr)
	c.active = saved.Active
}

func newFXPPanelTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if via := fxpPanelRelay.route(addr, time.Now()); via != "" {
			relayCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			conn, err := dialer.DialContext(relayCtx, "tcp", via)
			cancel()
			if err == nil {
				return conn, nil
			}
		}
		return dialer.DialContext(ctx, network, addr)
	}
	return transport
}
