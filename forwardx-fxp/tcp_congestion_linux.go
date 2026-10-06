//go:build linux

package main

import (
	"net"
	"os"
	"strings"
	"syscall"
)

// readSystemTCPCongestion 读系统默认的拥塞控制算法名，读不到返回空。
func readSystemTCPCongestion() string {
	raw, err := os.ReadFile("/proc/sys/net/ipv4/tcp_congestion_control")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// setTCPCongestion 对一条 TCP 连接设置 TCP_CONGESTION。
func setTCPCongestion(conn *net.TCPConn, name string) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var setErr error
	if err := raw.Control(func(fd uintptr) {
		setErr = syscall.SetsockoptString(int(fd), syscall.IPPROTO_TCP, syscall.TCP_CONGESTION, name)
	}); err != nil {
		return err
	}
	return setErr
}
