//go:build !linux

package main

import "net"

// Linux 以外没有 TCP_INFO 的重传计数：不自动微调，整形按起步速率走。
func tcpConnRetransStats(*net.TCPConn) (retrans, segsOut uint32, ok bool) {
	return 0, 0, false
}

func setTCPMaxPacingRate(*net.TCPConn, int64) {}
