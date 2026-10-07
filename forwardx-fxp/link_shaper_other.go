//go:build !linux

package main

import "net"

type tcpLinkStats struct {
	retrans       uint32
	segsOut       uint32
	bytesAcked    uint64
	notsentBytes  uint32
	sndbufLimited uint64
}

// Linux 以外没有 TCP_INFO：不自动识别、不微调，手动模式按起步速率走。
func tcpConnLinkStats(*net.TCPConn) (tcpLinkStats, bool) {
	return tcpLinkStats{}, false
}

func setTCPMaxPacingRate(*net.TCPConn, int64) {}

func clearTCPMaxPacingRate(*net.TCPConn) {}
