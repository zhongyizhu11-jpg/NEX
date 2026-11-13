//go:build linux

package main

import (
	"net"
	"syscall"
)

// setTCPNotSentLowat 给一条 TCP 连接设 TCP_NOTSENT_LOWAT（内核发送队列里还没发出去的字节上限）。
func setTCPNotSentLowat(conn net.Conn, bytes int) error {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return nil
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return err
	}
	var setErr error
	if err := raw.Control(func(fd uintptr) {
		setErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, 25 /* TCP_NOTSENT_LOWAT */, bytes)
	}); err != nil {
		return err
	}
	return setErr
}
