package main

/*
初始窗口（2.2.276，网络调优的一项，和 tcpfit 学的）：每条 IPv4 默认路由的 initcwnd / initrwnd 抬到 32。

内核默认新连接第一个来回只发 10 个包（约 14 KB），再等确认翻倍；设到 32 后第一个来回约 46 KB，
网页首屏的 HTML、小图这类短响应一个来回就发完，跨境长往返线路上能少等一两个来回。
它挂在路由上：本机发起的连接（入口到出口、出口到目标）和本机接受的连接回包（发给客户端）都经默认路由，
都用得上；内核直接转发的（iptables DNAT 这类，不经过本机的 TCP）不受影响。

怎么改：沿用 `ip -4 route show default` 里那条路由的全部字段（网关、proto、src、metric……），只换窗口两项，
`ip -4 route replace` 回去（自己拼 via/dev 会丢掉服务商下发的属性；metric 是路由的键，换了会多出一条）。
多路径路由（第一行没有 dev）不碰；只出现在输出里的标志（linkdown 这类）不塞回去，不然内核报错。

为什么不写配置文件：DHCP 续租、网络服务重启、PPP 重拨都会重建默认路由，窗口跟着没了，各发行版的持久化办法
又各不相同（tcpfit 为此备了四套）。Agent 本来就常驻：一键调优时留一个标记（netTuneRouteStatePath，
同时记下每条路由调优前的窗口），之后每分钟看一眼，被冲掉了就补回（maybeMaintainRoutes）；开机后 Agent
一起来就补。还原时按记下的原值改回去并删掉标记，之后不再补。
*/

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	netTuneInitWindow        = 32
	netTuneKernelInitWindow  = 10
	netTuneKeyInitcwnd       = "route.initcwnd"
	netTuneKeyInitrwnd       = "route.initrwnd"
	netTuneRouteCheckEvery   = time.Minute
	netTuneRouteCommandLimit = 5 * time.Second
)

var (
	netTuneRouteStatePath = "/etc/forwardx-nettune/initcwnd.json"
	// netTuneIPRoute 跑 `ip ...`（测试里换成假的路由表）。
	netTuneIPRoute = func(args ...string) ([]byte, error) {
		return commandOutputWithTimeout(netTuneRouteCommandLimit, "ip", args...)
	}
)

// 只出现在 `ip route show` 输出里、不能作为 replace 参数的标志。
var netTuneRouteOutputFlags = map[string]bool{
	"linkdown": true, "dead": true, "offload": true, "trap": true, "offload_failed": true,
	"rt_offload": true, "rt_trap": true, "rt_offload_failed": true, "pervasive": true, "notify": true,
}

type netTuneDefaultRoute struct {
	dev string
	// base：原路由去掉窗口两项和输出标志后的全部字段，replace 时原样带上。
	base []string
	// 0 表示没设（内核默认）。
	cwnd, rwnd int
}

type netTuneRouteWindow struct {
	Cwnd int `json:"initcwnd,omitempty"`
	Rwnd int `json:"initrwnd,omitempty"`
}

type netTuneRouteState struct {
	SavedAt int64 `json:"savedAt"`
	Window  int   `json:"window"`
	// Original：第一次改某块网卡的默认路由之前，它上面的窗口（按网卡名记；0 表示没设）。
	Original map[string]netTuneRouteWindow `json:"original"`
}

func netTuneDefaultRoutes() ([]netTuneDefaultRoute, error) {
	out, err := netTuneIPRoute("-4", "route", "show", "default")
	if err != nil {
		return nil, fmt.Errorf("读不了默认路由：%v", strings.TrimSpace(string(out)+" "+err.Error()))
	}
	var routes []netTuneDefaultRoute
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" || line[0] == ' ' || line[0] == '\t' {
			continue // 多路径路由的 nexthop 行
		}
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "default" {
			continue
		}
		route := netTuneDefaultRoute{}
		for i := 0; i < len(fields); i++ {
			word := fields[i]
			switch {
			case (word == "initcwnd" || word == "initrwnd") && i+1 < len(fields):
				value, _ := strconv.Atoi(strings.TrimPrefix(fields[i+1], "lock "))
				if word == "initcwnd" {
					route.cwnd = value
				} else {
					route.rwnd = value
				}
				i++
				continue
			case netTuneRouteOutputFlags[word]:
				continue
			case word == "dev" && i+1 < len(fields):
				route.dev = fields[i+1]
			}
			route.base = append(route.base, word)
		}
		if route.dev == "" {
			continue // 多路径：第一行没有 dev，整条换掉会把它变成没有出口的路由
		}
		routes = append(routes, route)
	}
	return routes, nil
}

func netTuneReplaceRoute(route netTuneDefaultRoute, window netTuneRouteWindow) error {
	args := append([]string{"-4", "route", "replace"}, route.base...)
	if window.Cwnd > 0 {
		args = append(args, "initcwnd", strconv.Itoa(window.Cwnd))
	}
	if window.Rwnd > 0 {
		args = append(args, "initrwnd", strconv.Itoa(window.Rwnd))
	}
	if out, err := netTuneIPRoute(args...); err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(out)+" "+err.Error()))
	}
	// 读回来核对
	routes, err := netTuneDefaultRoutes()
	if err != nil {
		return err
	}
	for _, after := range routes {
		if after.dev == route.dev {
			if after.cwnd != window.Cwnd || after.rwnd != window.Rwnd {
				return fmt.Errorf("内核没有接受（读回来 initcwnd %d initrwnd %d）", after.cwnd, after.rwnd)
			}
			return nil
		}
	}
	return fmt.Errorf("改完找不到 %s 的默认路由了", route.dev)
}

func netTuneWindowText(value int) string {
	if value <= 0 {
		value = netTuneKernelInitWindow
	}
	return strconv.Itoa(value)
}

func netTuneLoadRouteState() (*netTuneRouteState, bool) {
	raw, err := os.ReadFile(netTuneRouteStatePath)
	if err != nil {
		return nil, false
	}
	var state netTuneRouteState
	if json.Unmarshal(raw, &state) != nil || state.Window < 0 {
		return nil, false
	}
	if state.Original == nil {
		state.Original = map[string]netTuneRouteWindow{}
	}
	return &state, true
}

func netTuneSaveRouteState(state *netTuneRouteState) error {
	raw, _ := json.Marshal(state)
	if err := os.MkdirAll(filepath.Dir(netTuneRouteStatePath), 0700); err != nil {
		return err
	}
	return writeFileAtomicDurable(netTuneRouteStatePath, raw, 0600)
}

// netTuneApplyInitWindow：把默认路由的窗口抬到 32（已经更大的不动）。fromPanel 为 true 时（一键调优）
// 没有标记就建一个；为 false 时（每分钟的检查）只在有标记时补。
func netTuneApplyInitWindow(result *netTuneResult, fromPanel bool) {
	state, ok := netTuneLoadRouteState()
	if !ok {
		if !fromPanel {
			return
		}
		state = &netTuneRouteState{SavedAt: time.Now().Unix(), Window: netTuneInitWindow, Original: map[string]netTuneRouteWindow{}}
	}
	if state.Window == 0 {
		// 恢复了一份没有初始窗口的存档：记着原值，但不再补；一键调优重新打开
		if !fromPanel {
			return
		}
		state.Window = netTuneInitWindow
	}
	routes, err := netTuneDefaultRoutes()
	if err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, err)
		return
	}
	// 先记原值、存下标记再动路由：改到一半 Agent 被杀，还原时也知道原来是多少
	for _, route := range routes {
		if route.cwnd >= state.Window && route.rwnd >= state.Window {
			continue
		}
		if _, known := state.Original[route.dev]; !known {
			state.Original[route.dev] = netTuneRouteWindow{Cwnd: route.cwnd, Rwnd: route.rwnd}
		}
	}
	if err := netTuneSaveRouteState(state); err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, fmt.Errorf("调优标记存不下来，没有改：%v", err))
		return
	}
	for _, route := range routes {
		want := netTuneRouteWindow{Cwnd: max(route.cwnd, state.Window), Rwnd: max(route.rwnd, state.Window)}
		if want.Cwnd == route.cwnd && want.Rwnd == route.rwnd {
			continue
		}
		if err := netTuneReplaceRoute(route, want); err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, fmt.Errorf("%s：%v", route.dev, err))
			continue
		}
		result.Changed = append(result.Changed, netTuneChange{Key: netTuneKeyInitcwnd, From: netTuneWindowText(route.cwnd), To: strconv.Itoa(want.Cwnd)})
	}
}

// netTuneRestoreInitWindow：按标记里记的原值改回去，删掉标记（之后不再补）。没有标记什么都不做。
func netTuneRestoreInitWindow(result *netTuneResult) {
	state, ok := netTuneLoadRouteState()
	if !ok {
		return
	}
	routes, err := netTuneDefaultRoutes()
	if err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, err)
		return
	}
	for _, route := range routes {
		original, known := state.Original[route.dev]
		if !known {
			// 调优之后才出现的网卡：是我们补的 32 才摘掉，别的不碰
			if route.cwnd != state.Window || route.rwnd != state.Window {
				continue
			}
			original = netTuneRouteWindow{}
		}
		if route.cwnd == original.Cwnd && route.rwnd == original.Rwnd {
			continue
		}
		if err := netTuneReplaceRoute(route, original); err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, fmt.Errorf("%s：%v", route.dev, err))
			continue
		}
		result.Changed = append(result.Changed, netTuneChange{Key: netTuneKeyInitcwnd, From: netTuneWindowText(route.cwnd), To: netTuneWindowText(original.Cwnd)})
	}
	if err := os.Remove(netTuneRouteStatePath); err != nil && !os.IsNotExist(err) {
		result.FileError = "删不掉 " + netTuneRouteStatePath + "：" + err.Error()
	}
}

// netTuneReportInitWindow：报几条默认路由里最小的窗口（没设按内核默认 10）；没有 IPv4 默认路由算「没有」。
func netTuneReportInitWindow(result *netTuneResult) {
	routes, err := netTuneDefaultRoutes()
	if err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, err)
		return
	}
	if len(routes) == 0 {
		result.Missing = append(result.Missing, netTuneKeyInitcwnd)
		return
	}
	cwnd, rwnd := 0, 0
	for i, route := range routes {
		c, r := max(route.cwnd, 0), max(route.rwnd, 0)
		if c == 0 {
			c = netTuneKernelInitWindow
		}
		if r == 0 {
			r = netTuneKernelInitWindow
		}
		if i == 0 || c < cwnd {
			cwnd = c
		}
		if i == 0 || r < rwnd {
			rwnd = r
		}
	}
	result.Values[netTuneKeyInitcwnd] = strconv.Itoa(cwnd)
	result.Values[netTuneKeyInitrwnd] = strconv.Itoa(rwnd)
}

// maybeMaintainRoutes：有调优标记时每分钟检查一次默认路由，窗口被冲掉了（DHCP 续租、网络重启、PPP 重拨）就补回。
// 和面板下发的检查 / 调优共用 busy，不交错。返回这次有没有去查。
func (m *netTuneExtModule) maybeMaintainRoutes(now time.Time) bool {
	if _, err := os.Stat(netTuneRouteStatePath); err != nil {
		return false
	}
	m.mu.Lock()
	if m.busy || (!m.lastRouteCheck.IsZero() && now.Sub(m.lastRouteCheck) < netTuneRouteCheckEvery) {
		m.mu.Unlock()
		return false
	}
	m.busy = true
	m.lastRouteCheck = now
	m.mu.Unlock()
	go func() {
		defer func() {
			m.mu.Lock()
			m.busy = false
			m.mu.Unlock()
		}()
		var result netTuneResult
		netTuneApplyInitWindow(&result, false)
		for _, change := range result.Changed {
			logf("nettune: 默认路由的初始窗口被重置了（网络重连 / DHCP 续租），已从 %s 改回 %s", change.From, change.To)
		}
		for _, failure := range result.Failed {
			logf("nettune: 补初始窗口失败：%s", failure.Error)
		}
	}()
	return true
}
