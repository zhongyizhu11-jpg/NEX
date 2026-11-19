//go:build linux

package main

import (
	"errors"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

/*
F1：TCP_USER_TIMEOUT 只管「还没交出去 / 还在握手 / 还在等出口回结果」的隧道连接。

Linux 5.11 起零窗口探测也算进 TCP_USER_TIMEOUT：访客停下来不读（视频暂停、标签页切到后台）超过 30 秒，
入口不再读隧道、出口那一头的发送窗口是零，内核就把这条正在用的隧道连接判死、复位。正在用的会话靠保活发现
对端没了，不靠它。测试把超时缩到 1 秒，访客停 4 秒。
*/

func shortTunnelUserTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	fxpTunnelUserTimeoutOverride.Store(int64(d))
	t.Cleanup(func() { fxpTunnelUserTimeoutOverride.Store(0) })
}

// startTunnelPair 起一台出口、一台入口（单出口），返回入口端口。
func startTunnelPair(t *testing.T, tunnelID, ruleID, targetPort int) int {
	t.Helper()
	key := "f1-key"
	exitPort := freeTCPUDPPort(t)
	entryPort := freeTCPUDPPort(t)
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	go func() {
		_ = runExit(done, config{Role: "exit", TunnelID: tunnelID, ListenPort: exitPort, Protocol: "tcp", Key: key, StreamTargets: loopbackStreamTargets(ruleID, targetPort)})
	}()
	waitForTCP(t, exitPort)
	go func() {
		_ = runEntry(done, config{
			Role: "entry", TunnelID: tunnelID, RuleID: ruleID, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key,
		})
	}()
	waitForTCP(t, entryPort)
	return entryPort
}

// 下载方向：目标一直往回写，访客停 4 秒不读，然后读到底，字节一个不少、连接没被复位。
func TestCommittedTunnelSurvivesAPausedReader(t *testing.T) {
	resetFXPEndpointRegistry()
	shortTunnelUserTimeout(t, time.Second)
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	var written atomic.Int64
	// 只认带着访客那个「g」来的连接：waitForTCP 探入口时也会经隧道连一次目标。
	serveFirehose := func(c net.Conn) {
		defer c.Close()
		first := make([]byte, 1)
		if _, err := io.ReadFull(c, first); err != nil || first[0] != 'g' {
			return
		}
		chunk := make([]byte, 64<<10)
		_ = c.SetWriteDeadline(time.Now().Add(3 * time.Second))
		for {
			n, err := c.Write(chunk)
			written.Add(int64(n))
			if err != nil {
				break
			}
		}
		_ = c.(*net.TCPConn).CloseWrite()
		_, _ = io.Copy(io.Discard, c)
	}
	go func() {
		for {
			c, err := target.Accept()
			if err != nil {
				return
			}
			go serveFirehose(c)
		}
	}()
	entryPort := startTunnelPair(t, 611, 612, target.Addr().(*net.TCPAddr).Port)
	client, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("go")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(4 * time.Second)
	_ = client.SetReadDeadline(time.Now().Add(10 * time.Second))
	got, err := io.Copy(io.Discard, client)
	if err != nil {
		t.Fatalf("访客停下来不读 4 秒（TCP_USER_TIMEOUT 1 秒）之后接着读：连接断了（%v），读到 %d / %d 字节", err, got, written.Load())
	}
	if got != written.Load() {
		t.Fatalf("访客停下来不读之后接着读：读到 %d 字节，目标写了 %d 字节（隧道被判死、截断了）", got, written.Load())
	}
}

// 上传方向：访客一直往上写，目标停 4 秒不读，然后读到底。
func TestCommittedTunnelSurvivesAPausedTarget(t *testing.T) {
	resetFXPEndpointRegistry()
	shortTunnelUserTimeout(t, time.Second)
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	received := make(chan int64, 1)
	// 只认访客那条（第一个字节是「g」）：waitForTCP 探入口时也会经隧道连一次目标。
	serveSink := func(c net.Conn) {
		defer c.Close()
		first := make([]byte, 1)
		if _, err := io.ReadFull(c, first); err != nil || first[0] != 'g' {
			return
		}
		time.Sleep(4 * time.Second)
		n, _ := io.Copy(io.Discard, c)
		received <- n + 1
	}
	go func() {
		for {
			c, err := target.Accept()
			if err != nil {
				return
			}
			go serveSink(c)
		}
	}()
	entryPort := startTunnelPair(t, 613, 614, target.Addr().(*net.TCPAddr).Port)
	client, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var sent int64
	chunk := make([]byte, 64<<10)
	chunk[0] = 'g'
	_ = client.SetWriteDeadline(time.Now().Add(3 * time.Second))
	for {
		n, err := client.Write(chunk)
		sent += int64(n)
		if err != nil {
			break
		}
	}
	_ = client.(*net.TCPConn).CloseWrite()
	select {
	case got := <-received:
		if got != sent {
			t.Fatalf("目标停下来不读 4 秒（TCP_USER_TIMEOUT 1 秒）之后接着读：收到 %d 字节，访客发了 %d 字节（隧道被判死、截断了）", got, sent)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("目标一直没读完")
	}
}

// 还没交出去的连接（池里的、握手中的）照旧有 TCP_USER_TIMEOUT：对端不收（这里用不读造成的零窗口代替黑洞），
// 发出去的东西超时没人确认，内核把它判死。
func TestPooledTunnelConnectionToAStuckPeerStillDies(t *testing.T) {
	shortTunnelUserTimeout(t, time.Second)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	conn, err := dialTCP("127.0.0.1", ln.Addr().(*net.TCPAddr).Port, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	peer := <-accepted
	defer peer.Close()
	if got := tcpUserTimeoutOf(conn); got != time.Second {
		t.Fatalf("池里的连接 TCP_USER_TIMEOUT 应该是 1s，得到 %v", got)
	}
	failed := make(chan error, 1)
	go func() {
		chunk := make([]byte, 64<<10)
		for {
			if _, err := conn.Write(chunk); err != nil {
				failed <- err
				return
			}
		}
	}()
	select {
	case err := <-failed:
		if !errors.Is(err, syscall.ETIMEDOUT) {
			t.Logf("写失败：%v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("对端一直不收，池里的连接 15 秒都没被判死")
	}
}
