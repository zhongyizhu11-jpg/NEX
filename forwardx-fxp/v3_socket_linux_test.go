//go:build linux

package main

import (
	"net"
	"syscall"
	"testing"
	"time"
)

func readTCPNotSentLowat(t *testing.T, conn net.Conn) int {
	t.Helper()
	raw, err := conn.(*net.TCPConn).SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var value int
	var getErr error
	if err := raw.Control(func(fd uintptr) {
		value, getErr = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, 25)
	}); err != nil {
		t.Fatal(err)
	}
	if getErr != nil {
		t.Fatal(getErr)
	}
	return value
}

// 复用会话的物理连接按连接设 TCP_NOTSENT_LOWAT（不靠 sysctl）；不是 TCP 的连接什么都不做。
func TestTuneV3SessionSocketSetsNotSentLowat(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	client, err := net.DialTimeout("tcp", ln.Addr().String(), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	defer server.Close()
	for _, conn := range []net.Conn{client, server} {
		tuneV3SessionSocket(conn)
		if got := readTCPNotSentLowat(t, conn); got != v3SessionNotSentLowat {
			t.Fatalf("TCP_NOTSENT_LOWAT = %d, want %d", got, v3SessionNotSentLowat)
		}
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	tuneV3SessionSocket(a)
}
