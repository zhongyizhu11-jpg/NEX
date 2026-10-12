package main

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/sockmap"
)

func TestRelayTCPFallsBackWithoutSockets(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	peerLeft, peerRight := net.Pipe()
	defer peerLeft.Close()
	done := make(chan struct{})
	go func() {
		relayTCP(right, peerRight, time.Second)
		close(done)
	}()
	_ = left.SetDeadline(time.Now().Add(3 * time.Second))
	_ = peerLeft.SetDeadline(time.Now().Add(3 * time.Second))
	go func() { _, _ = left.Write([]byte("ping")) }()
	got := make([]byte, 4)
	if _, err := io.ReadFull(peerLeft, got); err != nil || string(got) != "ping" {
		t.Fatalf("got %q err=%v", got, err)
	}
	_ = left.Close()
	_ = peerLeft.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("fallback relay did not finish")
	}
}

// 不管走不走 sockmap，relayTCP 对真实 TCP 连接的行为都一样：数据送到、半关闭传下去、
// 返回前两端关闭。sockmap 关掉时测一遍用户态那条。
func TestRelayTCPOverLoopbackBothPaths(t *testing.T) {
	for _, off := range []bool{false, true} {
		sockmap.SetForceOff(off)
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		client, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		accepted, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		dialed, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		server, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		_ = listener.Close()
		done := make(chan struct{})
		go func() {
			relayTCP(accepted, dialed, time.Second)
			close(done)
		}()
		_ = client.SetDeadline(time.Now().Add(5 * time.Second))
		_ = server.SetDeadline(time.Now().Add(5 * time.Second))
		if _, err := client.Write([]byte("hello")); err != nil {
			t.Fatal(err)
		}
		closeTCPWrite(client)
		got, err := io.ReadAll(server)
		if err != nil || string(got) != "hello" {
			t.Fatalf("forceOff=%v server got %q err=%v", off, got, err)
		}
		_, _ = server.Write([]byte("bye"))
		_ = server.Close()
		reply, err := io.ReadAll(client)
		if err != nil || string(reply) != "bye" {
			t.Fatalf("forceOff=%v client got %q err=%v", off, reply, err)
		}
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("forceOff=%v relay did not finish", off)
		}
		_ = client.Close()
	}
	sockmap.SetForceOff(false)
}
