//go:build linux

package main

import (
	"math"
	"net"

	"golang.org/x/sys/unix"
)

// tcpConnRetransStats 读一条连接的累计重传段数和发出段数（TCP_INFO）。
// 连接已经关掉时 ok=false，调用方据此把它从成员里清掉。
func tcpConnRetransStats(tcp *net.TCPConn) (retrans, segsOut uint32, ok bool) {
	raw, err := tcp.SyscallConn()
	if err != nil {
		return 0, 0, false
	}
	var info *unix.TCPInfo
	var infoErr error
	if err := raw.Control(func(fd uintptr) {
		info, infoErr = unix.GetsockoptTCPInfo(int(fd), unix.IPPROTO_TCP, unix.TCP_INFO)
	}); err != nil || infoErr != nil || info == nil {
		return 0, 0, false
	}
	return info.Total_retrans, info.Segs_out, true
}

// setTCPMaxPacingRate 给一条连接设内核发包速率上限（SO_MAX_PACING_RATE，字节/秒）。
// fq 队列或 TCP 内部 pacing（BBR）都认它；设不上就算了，整形主体在用户态。
func setTCPMaxPacingRate(tcp *net.TCPConn, bytesPerSec int64) {
	if tcp == nil || bytesPerSec <= 0 || bytesPerSec > math.MaxUint32 {
		return
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return
	}
	_ = raw.Control(func(fd uintptr) {
		_ = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_MAX_PACING_RATE, int(bytesPerSec))
	})
}
