//go:build linux

package main

import (
	"net"
	"syscall"
	"time"
)

// tcpUserTimeoutOption 是 TCP_USER_TIMEOUT（linux/tcp.h）。标准库的 syscall 包不是每个架构都导出它。
const tcpUserTimeoutOption = 0x12

/*
setTCPUserTimeout 给一条隧道连接设 TCP_USER_TIMEOUT：发出去的数据（包括保活探测）这么久没人确认，
内核就把连接判死、读写立刻报错（路线图 X11）。

不设的话，对端机器断电 / 路由黑洞之后，已经建好的连接要等内核把重传次数用完（默认十几分钟）才会报错：
预热池里那些连接看起来还活着（偷看一眼也读不到 FIN），被发给用户之后发出去的内容石沉大海。
30 秒比任何正常的重传恢复都长，又远短于默认值。

只在连接还没交给会话时有效：会话交出去就清掉（secureConn.commitSession）。Linux 5.11 起零窗口探测也算进
这个超时，访客停下来不读超过 30 秒，正在用的连接会被复位；正在跑的会话靠保活发现对端没了。
*/
func setTCPUserTimeout(conn net.Conn, timeout time.Duration) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok || timeout <= 0 {
		return
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return
	}
	_ = raw.Control(func(fd uintptr) {
		_ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeoutOption, int(timeout/time.Millisecond))
	})
}

// clearTCPUserTimeout 把 TCP_USER_TIMEOUT 改回 0（内核默认：按重传次数判死）。会话交出去之后调（secureConn.commitSession）。
func clearTCPUserTimeout(conn net.Conn) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return
	}
	_ = raw.Control(func(fd uintptr) {
		_ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeoutOption, 0)
	})
}

// tcpUserTimeoutOf 读回设的值（测试用）；读不到返回 -1。
func tcpUserTimeoutOf(conn net.Conn) time.Duration {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return -1
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return -1
	}
	value := -1
	_ = raw.Control(func(fd uintptr) {
		if got, err := syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeoutOption); err == nil {
			value = got
		}
	})
	if value < 0 {
		return -1
	}
	return time.Duration(value) * time.Millisecond
}
