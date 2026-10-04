package main

import (
	"context"
	"net"
	"strconv"
	"syscall"
)

const tcpFastOpenBacklog = 256

// tcpFastOpenConnect 是 Linux 的 TCP_FASTOPEN_CONNECT（4.11 起）。
const tcpFastOpenConnect = 30

/*
tcpFastOpenDialControl 给主动拨出的连接（入口 → 出口/中转、中转 → 下一跳、
连接池预热）打开 TCP Fast Open，面板上开了 TFO（cfg.TCPFastOpen）才开。

以前只有监听端开了 TFO，拨号端没开，监听端那半边从来用不上。打开
TCP_FASTOPEN_CONNECT 之后：手里有对端的 cookie 时，connect 立刻返回，第一次写
（流水线握手 + hello + 首包）跟着 SYN 一起出去，省掉一个往返；还没有 cookie 就
是普通的三次握手，顺带向对端要一个 cookie。对端没开 TFO、中间设备丢带数据的
SYN，内核自己退回普通握手。Go 的 connect 看到返回 0 就当作已连上，写的时候由
内核补发 SYN，和 Xray 等项目的用法一样。

设不上（内核太老、sysctl net.ipv4.tcp_fastopen 没开客户端位）就当没开，不影响拨号。
*/
func tcpFastOpenDialControl(enabled bool) func(network, address string, c syscall.RawConn) error {
	if !enabled {
		return nil
	}
	return func(network, address string, c syscall.RawConn) error {
		_ = c.Control(func(fd uintptr) {
			_ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpFastOpenConnect, 1)
		})
		return nil
	}
}

func listenTCP(host string, port int, fastOpen bool) (net.Listener, error) {
	address := net.JoinHostPort(host, strconv.Itoa(port))
	if !fastOpen {
		return net.Listen("tcp", address)
	}
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var controlErr error
			err := c.Control(func(fd uintptr) {
				controlErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, 23, tcpFastOpenBacklog)
			})
			if err != nil {
				return err
			}
			return controlErr
		},
	}
	ln, err := lc.Listen(context.Background(), "tcp", address)
	if err == nil {
		return ln, nil
	}
	return net.Listen("tcp", address)
}
