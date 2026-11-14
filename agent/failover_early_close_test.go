package main

import (
	"io"
	"net"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// 接住连接、收一点就关、一个字节都不回：gost 中转后面的落地挂了就是这样。
func failoverCloseBeforeReplyBackend(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				buf := make([]byte, 64)
				_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
				_, _ = conn.Read(buf)
				_ = conn.Close()
			}()
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

func failoverEchoBackend(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

func startEarlyCloseScenario(t *testing.T, ruleID int) (int, *failoverProxy) {
	t.Helper()
	oldDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldDir })
	deadPort := failoverCloseBeforeReplyBackend(t)
	livePort := failoverEchoBackend(t)
	listenPort := failoverTestPort(t)
	spec := failoverTestSpec(listenPort)
	spec.Strategy = "fallback"
	spec.FailureThreshold = 2
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: deadPort}, {TargetIP: "127.0.0.1", TargetPort: livePort}}
	sourcePort := 60000 + ruleID%1000
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("proxy did not start")
	}
	return listenPort, currentFailoverProxy(ruleID, sourcePort)
}

func earlyCloseEcho(t *testing.T, listenPort int, payload string) (string, time.Duration) {
	t.Helper()
	started := time.Now()
	client, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(listenPort)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(client, got); err != nil {
		t.Fatalf("client saw the dead path instead of being rerouted: %v", err)
	}
	return string(got), time.Since(started)
}

// 主路径「拨得通但回之前就关」：这条连接当场换到备用、把已经发出的数据重发过去，客户端照常拿到回应。
func TestFailoverEarlyCloseReroutesConnectionSeamlessly(t *testing.T) {
	listenPort, proxy := startEarlyCloseScenario(t, 971001)
	got, elapsed := earlyCloseEcho(t, listenPort, "hello through the line")
	if got != "hello through the line" {
		t.Fatalf("echo = %q", got)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("reroute took %v", elapsed)
	}
	proxy.mu.Lock()
	healthy := proxy.targetHealth[0]
	count := proxy.statsLocked(0).earlyClose.count
	proxy.mu.Unlock()
	if !healthy {
		t.Fatal("one early close from one visitor must not mark the path down (a bad client could do that)")
	}
	if count != 1 {
		t.Fatalf("early close count = %d", count)
	}
}

// 换路照常；同一个访客反复被关不算数，两个不同访客都被关、满次数才把路径判异常。
func TestFailoverEarlyCloseMarksPathOnlyForDistinctVisitors(t *testing.T) {
	_, proxy := startEarlyCloseScenario(t, 971002)
	proxy.markEarlyClose(0, "198.51.100.7")
	proxy.markEarlyClose(0, "198.51.100.7")
	proxy.mu.Lock()
	stillHealthy := proxy.targetHealth[0]
	proxy.mu.Unlock()
	if !stillHealthy {
		t.Fatal("the same visitor being closed repeatedly must not mark the path down")
	}
	proxy.markEarlyClose(0, "203.0.113.9")
	proxy.mu.Lock()
	down := !proxy.targetHealth[0]
	proxy.mu.Unlock()
	if !down {
		t.Fatal("closes from two distinct visitors reaching the threshold mark the path down")
	}
	proxy.markEarlyReply(0)
	proxy.mu.Lock()
	reset := proxy.statsLocked(0).earlyClose.count
	proxy.mu.Unlock()
	if reset != 0 {
		t.Fatal("a normal reply resets the early close count")
	}
}
