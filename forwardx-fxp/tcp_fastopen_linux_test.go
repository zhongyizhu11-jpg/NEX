package main

import (
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// tcpFastOpenConnectOption 读出一条已经拨好的连接上 TCP_FASTOPEN_CONNECT 的值。
func tcpFastOpenConnectOption(t *testing.T, conn net.Conn) int {
	t.Helper()
	raw, err := conn.(*net.TCPConn).SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	value := -1
	var optErr error
	if err := raw.Control(func(fd uintptr) {
		value, optErr = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpFastOpenConnect)
	}); err != nil {
		t.Fatal(err)
	}
	if optErr != nil {
		t.Skipf("内核不支持读 TCP_FASTOPEN_CONNECT：%v", optErr)
	}
	return value
}

// 拨号端的 TFO 只跟着面板开关走：开了才设 TCP_FASTOPEN_CONNECT，没开一点不碰；
// 开了之后连接照常收发。
func TestDialTCPAppliesFastOpenOnlyWhenConfigured(t *testing.T) {
	if tcpFastOpenDialControl(false) != nil {
		t.Fatal("没开 TFO 时不该给拨号器挂 Control")
	}
	if tcpFastOpenDialControl(true) == nil {
		t.Fatal("开了 TFO 却没给拨号器挂 Control")
	}
	sysctl, err := os.ReadFile("/proc/sys/net/ipv4/tcp_fastopen")
	if err != nil {
		t.Skipf("读不到 net.ipv4.tcp_fastopen：%v", err)
	}
	mode, err := strconv.Atoi(strings.TrimSpace(string(sysctl)))
	if err != nil || mode&1 == 0 {
		t.Skipf("这台机器没开客户端 TFO（net.ipv4.tcp_fastopen=%q），设不上是预期的", strings.TrimSpace(string(sysctl)))
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			c, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port

	for _, fastOpen := range []bool{false, true} {
		conn, err := dialTCP("127.0.0.1", port, 2*time.Second, fastOpen)
		if err != nil {
			t.Fatalf("fastOpen=%v 拨号失败：%v", fastOpen, err)
		}
		want := 0
		if fastOpen {
			want = 1
		}
		if got := tcpFastOpenConnectOption(t, conn); got != want {
			_ = conn.Close()
			t.Fatalf("fastOpen=%v 时 TCP_FASTOPEN_CONNECT=%d, want %d", fastOpen, got, want)
		}
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := conn.Write([]byte("ping")); err != nil {
			t.Fatalf("fastOpen=%v 写失败：%v", fastOpen, err)
		}
		reply := make([]byte, 4)
		if _, err := io.ReadFull(conn, reply); err != nil || string(reply) != "ping" {
			t.Fatalf("fastOpen=%v 收发不通：reply=%q err=%v", fastOpen, reply, err)
		}
		_ = conn.Close()
	}
}

// 两端都开 TFO 时整条隧道照常工作：流水线握手、hello 和首包跟着（可能带数据的）
// SYN 出去，出口照常认。
func TestTunnelWorksWithFastOpenOnBothSides(t *testing.T) {
	resetFXPEndpointRegistry()
	key := "tfo-tunnel-key"
	targetPort := startLatencyEchoTarget(t)
	exitPort := freeTCPUDPPort(t)
	exitDone := make(chan struct{})
	defer close(exitDone)
	go func() {
		_ = runExit(exitDone, config{Role: "exit", TunnelID: 95, ListenPort: exitPort, Protocol: "tcp", Key: key,
			TCPFastOpen: true, StreamTargets: loopbackStreamTargets(96, targetPort)})
	}()
	waitForTCP(t, exitPort)
	entryPort := freeTCPUDPPort(t)
	entryDone := make(chan struct{})
	defer close(entryDone)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: 95, RuleID: 96, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: exitPort, Key: key, TCPFastOpen: true,
			TargetIP: "127.0.0.1", TargetPort: targetPort,
		})
	}()
	waitForTCP(t, entryPort)
	for i := 0; i < 5; i++ {
		c, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)))
		if err != nil {
			t.Fatal(err)
		}
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		payload := "tfo-" + strconv.Itoa(i)
		if _, err := c.Write([]byte(payload)); err != nil {
			t.Fatal(err)
		}
		reply := make([]byte, len(payload))
		if _, err := io.ReadFull(c, reply); err != nil || string(reply) != payload {
			t.Fatalf("第 %d 条连接收发不通：reply=%q err=%v", i, reply, err)
		}
		_ = c.Close()
	}
}
