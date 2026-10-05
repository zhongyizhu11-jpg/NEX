//go:build linux

package main

import (
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// listenICMPDatagram 打开一个无特权的 ICMP 数据报套接字（Linux 的 "ping socket"）。
// 不需要 CAP_NET_RAW，只要进程的组在 net.ipv4.ping_group_range 里；不允许时返回
// EACCES，调用方回退到别的探测方式。内核会把回显请求的标识符改成套接字自己的编号、
// 自己算校验和，并且只把属于这个套接字的应答交上来（不带 IP 头）。
func listenICMPDatagram(ipv6 bool) (net.PacketConn, error) {
	family, proto := unix.AF_INET, unix.IPPROTO_ICMP
	var addr unix.Sockaddr = &unix.SockaddrInet4{}
	if ipv6 {
		family, proto = unix.AF_INET6, unix.IPPROTO_ICMPV6
		addr = &unix.SockaddrInet6{}
	}
	fd, err := unix.Socket(family, unix.SOCK_DGRAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, proto)
	if err != nil {
		return nil, os.NewSyscallError("socket", err)
	}
	if err := unix.Bind(fd, addr); err != nil {
		_ = unix.Close(fd)
		return nil, os.NewSyscallError("bind", err)
	}
	file := os.NewFile(uintptr(fd), "icmp-datagram")
	// FilePacketConn 复制一份描述符交给运行时网络轮询器，原来的这份随后关掉。
	conn, err := net.FilePacketConn(file)
	_ = file.Close()
	if err != nil {
		return nil, err
	}
	return conn, nil
}
