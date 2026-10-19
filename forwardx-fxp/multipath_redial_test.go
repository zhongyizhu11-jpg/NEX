package main

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// killableForwarder 站在一台中转前面：kill 掉现有连接、暂时拒绝新连接，revive 之后重新放行。
// 用来模拟「中转抖了一下又好了」。
type killableForwarder struct {
	port     int
	accepted atomic.Int64
	mu       sync.Mutex
	down     bool
	conns    []net.Conn
	listener net.Listener
}

func startKillableForwarder(t *testing.T, targetPort int) *killableForwarder {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &killableForwarder{port: listener.Addr().(*net.TCPAddr).Port, listener: listener}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			f.mu.Lock()
			if f.down {
				f.mu.Unlock()
				_ = conn.Close()
				continue
			}
			f.accepted.Add(1)
			upstream, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", targetPort))
			if err != nil {
				f.mu.Unlock()
				_ = conn.Close()
				continue
			}
			f.conns = append(f.conns, conn, upstream)
			f.mu.Unlock()
			go func() { _, _ = io.Copy(upstream, conn); _ = upstream.Close() }()
			go func() { _, _ = io.Copy(conn, upstream); _ = conn.Close() }()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); f.kill() })
	return f
}

func (f *killableForwarder) kill() {
	f.mu.Lock()
	f.down = true
	conns := f.conns
	f.conns = nil
	f.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

func (f *killableForwarder) revive() {
	f.mu.Lock()
	f.down = false
	f.mu.Unlock()
}

// 一路中途断了又好了：会话不断、数据一个字节不差，而且断的那一路被补拨回来。
func TestMultipathRedialsLostLegMidSession(t *testing.T) {
	multipathLegHealthMemory.reset()
	defer multipathLegHealthMemory.reset()
	targetPort, stopTarget := startEchoTarget(t)
	defer stopTarget()

	const tunnelID = 9200
	exitKey := "multipath-redial-exit-key"
	exitPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	defer close(exitDone)
	go func() {
		_ = runExit(exitDone, config{Role: "exit", TunnelID: tunnelID, ListenPort: exitPort, Protocol: "tcp", Key: exitKey, TargetIP: "127.0.0.1", TargetPort: targetPort})
	}()
	waitForTCPPort(t, exitPort)

	startRelay := func(key string) int {
		port := freeTCPPort(t)
		done := make(chan struct{})
		t.Cleanup(func() { close(done) })
		go func() {
			_ = runRelay(done, config{Role: "relay", TunnelID: tunnelID, ListenPort: port, Protocol: "tcp", Key: key, RelayExitHost: "127.0.0.1", RelayExitPort: exitPort, RelayKey: exitKey})
		}()
		waitForTCPPort(t, port)
		return port
	}
	relayA := startRelay("multipath-redial-relay-a")
	relayB := startRelay("multipath-redial-relay-b")
	flaky := startKillableForwarder(t, relayB)

	entryPort := freeTCPPort(t)
	entryDone := make(chan struct{})
	defer close(entryDone)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: tunnelID, RuleID: 9201, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: exitPort, Key: exitKey, TargetIP: "127.0.0.1", TargetPort: targetPort,
			MultipathEnabled: true,
			MultipathLegs: []multipathLeg{
				{Host: "127.0.0.1", Port: relayA, Key: "multipath-redial-relay-a", Via: "relay-a", CapacityMbps: 500},
				{Host: "127.0.0.1", Port: flaky.port, Key: "multipath-redial-relay-b", Via: "relay-b", CapacityMbps: 300},
			},
		})
	}()
	waitForTCPPort(t, entryPort)

	client, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", entryPort))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	var sent bytes.Buffer
	received := &lockedBuffer{}
	readDone := make(chan error, 1)
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, err := client.Read(buf)
			received.write(buf[:n])
			if err != nil {
				readDone <- err
				return
			}
		}
	}()
	send := func(size int) {
		chunk := make([]byte, size)
		_, _ = rand.Read(chunk)
		sent.Write(chunk)
		if _, err := client.Write(chunk); err != nil {
			t.Fatalf("写失败：%v", err)
		}
	}

	send(256 * 1024)
	// 等第一批原样回来、两路都入了会话，再掐断第二路（不然掐的时候另一路可能还没加入，会话就整个断了）。
	deadline := time.Now().Add(5 * time.Second)
	for (received.len() < sent.Len() || flaky.accepted.Load() < 1) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if flaky.accepted.Load() < 1 {
		t.Fatal("第二路一开始就没连上")
	}
	time.Sleep(500 * time.Millisecond)
	redialsBefore, redialedBefore := multipathRedialsTotal.Load(), multipathRedialedTotal.Load()
	flaky.kill()
	time.Sleep(300 * time.Millisecond)
	send(256 * 1024) // 只剩一路也照样走
	time.Sleep(700 * time.Millisecond)
	flaky.revive()

	if multipathRedialsTotal.Load() == redialsBefore {
		t.Fatal("一路断了却没安排补拨")
	}
	deadline = time.Now().Add(15 * time.Second)
	for multipathRedialedTotal.Load() == redialedBefore && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if multipathRedialedTotal.Load() == redialedBefore {
		t.Fatal("断掉的那一路没被补拨回来")
	}
	send(1024 * 1024) // 补回来之后两路一起走

	deadline = time.Now().Add(10 * time.Second)
	for received.len() < sent.Len() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	_ = client.Close()
	<-readDone
	if !bytes.Equal(received.bytes()[:min(received.len(), sent.Len())], sent.Bytes()) || received.len() != sent.Len() {
		t.Fatalf("回来的数据不对：发 %d 收 %d", sent.Len(), received.len())
	}
}

// lockedBuffer 是读协程和测试主协程共用的收数据缓冲。
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) write(p []byte) {
	b.mu.Lock()
	b.buf.Write(p)
	b.mu.Unlock()
}

func (b *lockedBuffer) len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Len()
}

func (b *lockedBuffer) bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}
