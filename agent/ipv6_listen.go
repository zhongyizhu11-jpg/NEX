package main

import (
	"errors"
	"net"
	"os"
	"sync"
	"syscall"
	"time"
)

/*
  这台机器能不能开 IPv6 套接字（2.2.256 起随心跳上报 ipv6Listen）。

  内核带 ipv6.disable=1 启动（或者没编 IPv6）的机器上 socket(AF_INET6) 直接 EAFNOSUPPORT：
  面板给 realm 写的 listen = "[::0]:端口"、给 socat 写的 TCP6-LISTEN、给 nginx 写的
  listen [::]:端口 全都起不来。面板拿到 ipv6Listen=false 就给这台机器改写成只听 IPv4
  （0.0.0.0 / TCP4-LISTEN / UDP4-LISTEN），有 IPv6 的机器保持双栈不变。

  只有「确实不支持这个地址族」才算 false：EMFILE、seccomp 拦了之类的偶发错误不能让面板
  把整台机器的配置改一遍，再在下一轮改回来。sysctl disable_ipv6=1 的机器 AF_INET6 照样能开、
  [::] 照样能绑（双栈套接字还能收 IPv4），算 true，配置不动。
*/

const ipv6ListenRecheckInterval = 10 * time.Minute

var (
	// 换成假的就能测：返回 nil 表示 [::]:0 绑得上。
	ipv6ListenProbe = probeIPv6Listen
	// /proc/net/if_inet6 在不在：内核关掉了 IPv6 时这个文件没有。
	ipv6ProcExists = func() bool {
		_, err := os.Stat("/proc/net/if_inet6")
		return err == nil
	}
	ipv6ListenNow = time.Now

	ipv6ListenMu        sync.Mutex
	ipv6ListenCheckedAt time.Time
	ipv6ListenValue     bool
)

func probeIPv6Listen() error {
	ln, err := net.ListenTCP("tcp6", &net.TCPAddr{IP: net.IPv6unspecified, Port: 0})
	if err != nil {
		return err
	}
	return ln.Close()
}

// classifyIPv6ListenProbe 把一次探测的结果换成「能不能用 IPv6 监听」。拿不准的一律当能用（老行为）。
func classifyIPv6ListenProbe(err error, procIfInet6Exists bool) bool {
	if err == nil {
		return true
	}
	if errors.Is(err, syscall.EAFNOSUPPORT) || errors.Is(err, syscall.EPROTONOSUPPORT) {
		return false
	}
	// 别的错误（句柄用完、权限）证明不了什么；只有内核连 IPv6 的地址表都没有时才信它。
	return procIfInet6Exists
}

// ipv6ListenAvailable 带缓存：IPv6 开关要重启内核才变，十分钟复查一次足够，也不让每次心跳都去绑端口。
func ipv6ListenAvailable() bool {
	ipv6ListenMu.Lock()
	defer ipv6ListenMu.Unlock()
	now := ipv6ListenNow()
	if !ipv6ListenCheckedAt.IsZero() && now.Sub(ipv6ListenCheckedAt) < ipv6ListenRecheckInterval {
		return ipv6ListenValue
	}
	ipv6ListenValue = classifyIPv6ListenProbe(ipv6ListenProbe(), ipv6ProcExists())
	ipv6ListenCheckedAt = now
	return ipv6ListenValue
}

func resetIPv6ListenCacheForTest() {
	ipv6ListenMu.Lock()
	ipv6ListenCheckedAt = time.Time{}
	ipv6ListenValue = false
	ipv6ListenMu.Unlock()
}
