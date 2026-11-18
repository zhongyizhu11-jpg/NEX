package main

import (
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 负载均衡整治路线图 E1（「上游没回就断开时换路重发」）的回归测试。

// E1：上游已经回了「HTTP/1.1 401…」并关了连接、客户端还在上传 —— 客户端恰好收到一次 401，
// 第二条路径一个字节都不该看到。以前写上游失败时把那次挂着的读扔掉、当成「回之前就关」重发，300 次里近 200 次出错。
func TestFailoverEarlyCloseNeverReplaysAfterUpstreamReplied(t *testing.T) {
	oldDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldDir })
	const reply = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

	// 第一条路径：读到请求头就回 401、关连接（请求体还在路上）。
	rejecting, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rejecting.Close() })
	go func() {
		for {
			conn, err := rejecting.Accept()
			if err != nil {
				return
			}
			go func() {
				buf := make([]byte, 256)
				_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
				if n, _ := conn.Read(buf); n > 0 {
					_, _ = conn.Write([]byte(reply))
				}
				_ = conn.Close()
			}()
		}
	}()
	// 第二条路径：数它收到了几条连接、多少字节。一条都不该有。
	var secondConns, secondBytes atomic.Int64
	second, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	go func() {
		for {
			conn, err := second.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				buf := make([]byte, 4096)
				counted := false
				for {
					n, err := conn.Read(buf)
					if n > 0 {
						// 探测只连不发；收到了数据才算「这条路径看到了请求」。
						if !counted {
							counted = true
							secondConns.Add(1)
						}
						secondBytes.Add(int64(n))
						_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"))
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()

	const ruleID, sourcePort = 973001, 63001
	listenPort := failoverTestPort(t)
	spec := failoverTestSpec(listenPort)
	spec.Strategy = "fallback"
	spec.FailureThreshold = 3
	spec.Targets = []failoverTarget{
		{TargetIP: "127.0.0.1", TargetPort: rejecting.Addr().(*net.TCPAddr).Port},
		{TargetIP: "127.0.0.1", TargetPort: second.Addr().(*net.TCPAddr).Port},
	}
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("proxy did not start")
	}
	proxy := currentFailoverProxy(ruleID, sourcePort)

	wrong := 0
	firstWrong := ""
	body := make([]byte, 4096)
	for iteration := 0; iteration < 300; iteration++ {
		client, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(listenPort)), 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.Write([]byte("POST /upload HTTP/1.1\r\nHost: example.test\r\nContent-Length: 1048576\r\n\r\n")); err != nil {
			t.Fatal(err)
		}
		// 接着上传请求体，不管对面回了什么（写失败就停）
		uploaded := make(chan struct{})
		go func() {
			defer close(uploaded)
			for i := 0; i < 64; i++ {
				if _, err := client.Write(body); err != nil {
					return
				}
				time.Sleep(200 * time.Microsecond)
			}
		}()
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		got, _ := io.ReadAll(client)
		<-uploaded
		_ = client.Close()
		if string(got) != reply {
			wrong++
			if firstWrong == "" {
				firstWrong = fmt.Sprintf("第 %d 次客户端收到 %q", iteration, string(got))
			}
		}
	}
	if wrong > 0 {
		t.Fatalf("300 次里 %d 次客户端没有恰好收到一次 401：%s", wrong, firstWrong)
	}
	if secondConns.Load() != 0 || secondBytes.Load() != 0 {
		t.Fatalf("上游回过东西以后不能把请求重发给别的路径：第二条路径收到 %d 条连接、%d 字节", secondConns.Load(), secondBytes.Load())
	}
	proxy.mu.Lock()
	healthy, closes := proxy.targetHealth[0], proxy.stats[0].earlyClose.count
	proxy.mu.Unlock()
	if !healthy || closes != 0 {
		t.Fatalf("回了 401 是正常回复，不算「回之前就关」：healthy=%v closes=%d", healthy, closes)
	}
}

// E1：访客地址不知道（看到的全是 127.0.0.1）时不靠「回之前就关」判坏；从 PROXY 头里读得到访客时照旧。
func TestFailoverEarlyCloseDoesNotBlameWithoutVisitorAddress(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: routeTargets(2), FailureThreshold: 2})
	for i := 0; i < 50; i++ {
		proxy.markEarlyClose(0, "127.0.0.1")
		proxy.markEarlyClose(0, "::1")
		proxy.markEarlyClose(0, "")
	}
	proxy.mu.RLock()
	healthy := proxy.targetHealth[0]
	proxy.mu.RUnlock()
	if !healthy {
		t.Fatal("访客全是本机地址（没读到 PROXY 头）时凑不出两个不同访客，不该判坏")
	}
	proxy.markEarlyClose(0, "198.51.100.7")
	proxy.markEarlyClose(0, "203.0.113.9")
	proxy.mu.RLock()
	healthy = proxy.targetHealth[0]
	proxy.mu.RUnlock()
	if healthy {
		t.Fatal("两个真实访客都被关、次数也够了：应当判坏")
	}
}

// E1：规则带 PROXY 头时不管什么策略都从头里读访客（以前只有整组「按访客固定」才读）。
func TestFailoverEarlyCloseReadsVisitorFromProxyHeaderForAnyStrategy(t *testing.T) {
	for _, strategy := range []string{"fallback", "weighted", "ip_hash"} {
		proxy := routeTestProxy(failoverSpec{Strategy: strategy, Targets: routeTargets(2), ProxyProtocolReceive: true})
		client, server := net.Pipe()
		go func() {
			_, _ = client.Write([]byte("PROXY TCP4 198.51.100.7 203.0.113.1 40000 443\r\nhello"))
		}()
		visitor, prefix := proxy.readVisitor(server)
		_ = client.Close()
		_ = server.Close()
		if visitor != "198.51.100.7" {
			t.Fatalf("%s：访客应当从 PROXY 头里读，拿到 %q", strategy, visitor)
		}
		if !strings.HasPrefix(string(prefix), "PROXY TCP4 198.51.100.7") {
			t.Fatalf("%s：头是给落地的，要原样转过去：%q", strategy, string(prefix))
		}
	}
}
