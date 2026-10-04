//go:build !linux

package main

import (
	"errors"
	"net"
)

// 其他系统没有（或语义不同的）无特权 ICMP 数据报套接字，直接回退到外部 ping。
func listenICMPDatagram(ipv6 bool) (net.PacketConn, error) {
	return nil, errors.New("datagram icmp unsupported on this platform")
}
