//go:build !linux

package main

import (
	"net"
	"time"
)

// setTCPUserTimeout：TCP_USER_TIMEOUT 只在 Linux 上设（见 tcp_user_timeout_linux.go），别的系统什么都不做。
func setTCPUserTimeout(net.Conn, time.Duration) {}

func clearTCPUserTimeout(net.Conn) {}

func tcpUserTimeoutOf(net.Conn) time.Duration { return -1 }
