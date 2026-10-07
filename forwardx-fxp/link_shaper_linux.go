//go:build linux

package main

import (
	"math"
	"net"

	"golang.org/x/sys/unix"
)

// tcpLinkStats 是一条连接的 TCP_INFO 里整形用得到的几项（都是累计值）。
type tcpLinkStats struct {
	retrans       uint32 // 重传段数
	segsOut       uint32 // 发出段数
	bytesAcked    uint64 // 被确认的字节数
	notsentBytes  uint32 // 写进去了还没发出去的字节（被拥塞窗口 / pacing 卡着）
	sndbufLimited uint64 // 被发送缓冲卡住的时间（微秒）：应用比链路快
}

// tcpConnLinkStats 读一条连接的 TCP_INFO。连接已经关掉时 ok=false，调用方据此把它从成员里清掉。
func tcpConnLinkStats(tcp *net.TCPConn) (stats tcpLinkStats, ok bool) {
	raw, err := tcp.SyscallConn()
	if err != nil {
		return stats, false
	}
	var info *unix.TCPInfo
	var infoErr error
	if err := raw.Control(func(fd uintptr) {
		info, infoErr = unix.GetsockoptTCPInfo(int(fd), unix.IPPROTO_TCP, unix.TCP_INFO)
	}); err != nil || infoErr != nil || info == nil {
		return stats, false
	}
	return tcpLinkStats{
		retrans:       info.Total_retrans,
		segsOut:       info.Segs_out,
		bytesAcked:    info.Bytes_acked,
		notsentBytes:  info.Notsent_bytes,
		sndbufLimited: info.Sndbuf_limited,
	}, true
}

// clearTCPMaxPacingRate 把内核发包速率上限恢复成不限（内核默认值 ~0）。
func clearTCPMaxPacingRate(tcp *net.TCPConn) {
	if tcp == nil {
		return
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return
	}
	_ = raw.Control(func(fd uintptr) {
		_ = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_MAX_PACING_RATE, int(uint32(math.MaxUint32)))
	})
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
