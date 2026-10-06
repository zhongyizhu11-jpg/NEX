package main

import (
	"log"
	"net"
	"strings"
	"sync"
	"sync/atomic"
)

/*
逐连接的 TCP 拥塞控制。

安装脚本会把系统默认改成 BBR，但那只在装 Agent 的那一刻跑一次：Docker 里的面板
不改宿主 sysctl、内核当时还没装 tcp_bbr 模块、或者用户自己又把 sysctl 改了回去，
隧道连接就会跑回 cubic。跨境线路丢包一两个百分点，cubic 的窗口被砍得起不来，
现象就是「带宽跑不满、速度忽高忽低」——而 BBR 不把丢包当拥塞，这正是它在
这种线路上快得多的原因。

TCP_CONGESTION 是每个套接字自己的选项，不必改系统默认：FXP 给自己拨出和接受的
每一条 TCP 连接都设一次。进程是 root（CAP_NET_ADMIN）时内核会按需自动加载
tcp_bbr 模块。设不上（内核没有 bbr、容器里没权限）就保持系统默认，连接照常。

auto 模式只在系统默认是 cubic / reno 时才换成 bbr：用户自己选的算法（bbr2、
bbrplus、nanqinlang 之类）照用，不替他做主。
*/

// fxpTCPCongestionAuto 是配置里没写（或写 auto）时的策略。
const fxpTCPCongestionAuto = "auto"

// fxpTCPCongestionPreferred 是 auto 模式下替 cubic / reno 换上的算法。
const fxpTCPCongestionPreferred = "bbr"

// fxpTCPCongestionLeaveAlone 是 auto 模式下不去碰的系统默认算法之外的取值：
// 配置写 off / system / none 都表示「保持系统默认」。
func fxpTCPCongestionLeaveAlone(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "off", "system", "none", "default", "kernel":
		return true
	}
	return false
}

// normalizeTCPCongestion 把配置里的取值收敛成：""（auto）、"off"、或算法名。
func normalizeTCPCongestion(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || value == fxpTCPCongestionAuto {
		return ""
	}
	if fxpTCPCongestionLeaveAlone(value) {
		return "off"
	}
	return value
}

// resolveTCPCongestion 决定实际给套接字设的算法名，空表示不设。
// systemDefault 是 /proc/sys/net/ipv4/tcp_congestion_control 的当前值（读不到为空）。
func resolveTCPCongestion(configured, systemDefault string) string {
	configured = normalizeTCPCongestion(configured)
	if configured == "off" {
		return ""
	}
	if configured != "" {
		if configured == strings.ToLower(strings.TrimSpace(systemDefault)) {
			return "" // 已经是系统默认，没必要每条连接再设一次
		}
		return configured
	}
	switch strings.ToLower(strings.TrimSpace(systemDefault)) {
	case "cubic", "reno":
		return fxpTCPCongestionPreferred
	}
	return ""
}

// fxpTCPCongestionState 是进程级的决定：按配置算一次，之后每条连接直接用。
type fxpTCPCongestionState struct {
	mu       sync.Mutex
	name     atomic.Pointer[string]
	disabled atomic.Bool
	logged   atomic.Bool
}

var fxpTCPCongestion fxpTCPCongestionState

// applyTCPCongestionConfig 在启动和热更新时按配置重算。
func applyTCPCongestionConfig(cfg config) {
	name := resolveTCPCongestion(cfg.TCPCongestion, readSystemTCPCongestion())
	fxpTCPCongestion.mu.Lock()
	defer fxpTCPCongestion.mu.Unlock()
	previous := fxpTCPCongestion.name.Load()
	if previous != nil && *previous == name {
		return
	}
	fxpTCPCongestion.name.Store(&name)
	fxpTCPCongestion.disabled.Store(false)
	fxpTCPCongestion.logged.Store(false)
	if name != "" {
		log.Printf("fxp tcp congestion control per-connection=%s (system default %q)", name, readSystemTCPCongestion())
	}
}

// tuneTCPCongestion 给一条 TCP 连接设拥塞控制。设不上只报一次，之后不再尝试：
// 一个内核要么有这个算法，要么没有，每条连接都失败一次没有意义。
func tuneTCPCongestion(conn net.Conn) {
	name := fxpTCPCongestion.name.Load()
	if name == nil || *name == "" || fxpTCPCongestion.disabled.Load() {
		return
	}
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return
	}
	if err := setTCPCongestion(tcp, *name); err != nil {
		fxpTCPCongestion.disabled.Store(true)
		if fxpTCPCongestion.logged.CompareAndSwap(false, true) {
			log.Printf("fxp tcp congestion control %s unavailable, keeping the system default: %v", *name, err)
		}
	}
}
