package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/*
F2：入口等出口回「连上目标没有」等多久、等不到算什么。

  - 出口解析目标域名也算在拨目标的时限里（以前解析在时限外面，冷 DNS 一慢，每台出口回结果都晚过入口的 6 秒）。
  - 入口的等待 = 出口拨目标的时限 + 余量 + 量到的握手往返（以前固定 6 秒，往返长的线路上结果晚到就被当成没回）。
  - 等不到算一次「可疑」（和探测失败一样要连着几次才判坏），不再当场判坏。
*/

// delayGate 在回程（下一跳 → 上一跳）上每块数据晚 delay 再转，模拟往返长的线路。去程不动。
type delayGate struct {
	listener net.Listener
	target   string
	delay    time.Duration
	mu       sync.Mutex
	conns    []net.Conn
}

func startDelayGate(t *testing.T, targetPort int, delay time.Duration) *delayGate {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gate := &delayGate{listener: listener, target: net.JoinHostPort("127.0.0.1", strconv.Itoa(targetPort)), delay: delay}
	t.Cleanup(func() {
		_ = listener.Close()
		gate.mu.Lock()
		defer gate.mu.Unlock()
		for _, conn := range gate.conns {
			_ = conn.Close()
		}
	})
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go gate.serve(client)
		}
	}()
	return gate
}

func (g *delayGate) track(conns ...net.Conn) {
	g.mu.Lock()
	g.conns = append(g.conns, conns...)
	g.mu.Unlock()
}

func (g *delayGate) serve(client net.Conn) {
	upstream, err := net.DialTimeout("tcp", g.target, 2*time.Second)
	if err != nil {
		_ = client.Close()
		return
	}
	g.track(client, upstream)
	go func() {
		defer upstream.Close()
		_, _ = io.Copy(upstream, client)
	}()
	type chunk struct {
		at   time.Time
		data []byte
	}
	queue := make(chan chunk, 1024)
	go func() {
		defer client.Close()
		for c := range queue {
			if wait := time.Until(c.at); wait > 0 {
				time.Sleep(wait)
			}
			if c.data == nil {
				return
			}
			if _, err := client.Write(c.data); err != nil {
				return
			}
		}
	}()
	buf := make([]byte, 32*1024)
	for {
		n, err := upstream.Read(buf)
		if n > 0 {
			queue <- chunk{at: time.Now().Add(g.delay), data: append([]byte(nil), buf[:n]...)}
		}
		if err != nil {
			queue <- chunk{at: time.Now().Add(g.delay)}
			close(queue)
			return
		}
	}
}

func (g *delayGate) port() int { return g.listener.Addr().(*net.TCPAddr).Port }

// 出口连目标花了 3.6 秒（在 4 秒的时限内），回程又要 2.5 秒：结果在 hello 发出后约 6.1 秒到。以前入口固定只等 6 秒，
// 把这台出口当场判坏、内容重放到另一台（目标那边多出一条连接）；现在等待里算上了量到的往返，等得到。
func TestTargetStatusWaitCoversTheMeasuredRoundTrip(t *testing.T) {
	if testing.Short() {
		t.Skip("要等十几秒")
	}
	resetFXPEndpointRegistry()
	targetPort := startEchoTCPTarget(t)
	key := "f2-key"
	ports := startRoadmapExits(t, 2, 221, 222, key, targetPort)
	gate := startDelayGate(t, ports[0], 2500*time.Millisecond)
	var dialsVia [2]atomic.Int32
	setExitTargetDialHook(func(listenPort int, hello helloFrame) error {
		if hello.TargetProbe {
			return nil
		}
		for i, port := range ports {
			if listenPort == port {
				dialsVia[i].Add(1)
			}
		}
		if listenPort == ports[0] {
			time.Sleep(3600 * time.Millisecond)
		}
		return nil
	})
	defer setExitTargetDialHook(nil)
	entryPort := freeTCPUDPPort(t)
	done := make(chan struct{})
	defer close(done)
	go func() {
		_ = runEntry(done, config{
			Role: "entry", TunnelID: 221, RuleID: 222, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: gate.port(), ExitStrategy: "fallback",
			Exits: []exitEndpoint{
				{Host: "127.0.0.1", Port: gate.port(), Key: key, TargetStatus: true},
				{Host: "127.0.0.1", Port: ports[1], Key: key, TargetStatus: true},
			},
			TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key,
		})
	}()
	waitForTCP(t, entryPort)
	// 等预热连接握完手（经过 2.5 秒的回程），入口量到这台出口的往返。
	time.Sleep(4 * time.Second)
	dialsVia[0].Store(0)
	dialsVia[1].Store(0)
	elapsed, err := roadmapEcho(t, entryPort, "", "hello-f2", 20*time.Second)
	if err != nil {
		t.Fatalf("回声失败：%v（%v）", err, elapsed.Round(time.Millisecond))
	}
	if n := dialsVia[1].Load(); n != 0 {
		t.Fatalf("主出口的结果在时限内会到（拨目标 3.6 秒 + 回程 2.5 秒），不该重放到备用出口去拨目标（拨了 %d 次）", n)
	}
	if !fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: gate.port(), Key: key}).isHealthy() {
		t.Fatal("结果只是晚到，主出口不该被判坏")
	}
}

// 出口解析目标域名算在拨目标的时限里：DNS 慢了，按时限报「连不上」，不让入口白等。
func TestExitTargetDialBudgetIncludesResolution(t *testing.T) {
	flushHopResolverCache()
	defer flushHopResolverCache()
	setHopLookupHook(func(ctx context.Context, host string) ([]net.IPAddr, error) {
		select {
		case <-time.After(3 * time.Second):
			return []net.IPAddr{{IP: net.IPv4(192, 0, 2, 1)}}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	defer setHopLookupHook(nil)
	started := time.Now()
	conn, err := dialExitTarget(helloFrame{TargetIP: "slow-dns.example", TargetPort: 443}, 1500*time.Millisecond)
	elapsed := time.Since(started)
	if conn != nil {
		_ = conn.Close()
	}
	if err == nil {
		t.Fatal("解析要 3 秒、时限 1.5 秒：应该报错")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("解析要 3 秒、时限 1.5 秒：花了 %v 才返回，解析没算在时限里", elapsed.Round(time.Millisecond))
	}
}

// 一次等不到出口的结果帧只算一次「可疑」，不当场判坏（结果帧可能只是晚到了）；这条连接照样换下一台重放。
func TestOneMissingTargetStatusIsOnlyASuspect(t *testing.T) {
	resetFXPEndpointRegistry()
	targetPort := startEchoTCPTarget(t)
	key := "f2c-key"
	ports := startRoadmapExits(t, 2, 231, 232, key, targetPort)
	release := make(chan struct{})
	defer close(release)
	setExitTargetDialHook(func(listenPort int, hello helloFrame) error {
		if listenPort == ports[0] && !hello.TargetProbe {
			select {
			case <-release:
			case <-time.After(25 * time.Second):
			}
		}
		return nil
	})
	defer setExitTargetDialHook(nil)
	exits := []exitEndpoint{
		{Host: "127.0.0.1", Port: ports[0], Key: key, TargetStatus: true},
		{Host: "127.0.0.1", Port: ports[1], Key: key, TargetStatus: true},
	}
	selector := newExitEndpointSelector(exits, exits[0], "fallback")
	cfg := config{Role: "entry", TunnelID: 231, RuleID: 232, Key: key, TargetIP: "127.0.0.1", TargetPort: targetPort}
	transport := newSelectedTransport(selector, cfg, "198.51.100.1")
	defer transport.closeTransport()
	if err := transport.connect(); err != nil {
		t.Fatal(err)
	}
	transport.requestTargetStatus()
	hello, _ := json.Marshal(helloFrame{Network: "tcp", TargetIP: "127.0.0.1", TargetPort: targetPort, TunnelID: 231, RuleID: 232, TargetStatus: true, TargetDialTimeoutMs: int(fxpTargetDialTimeoutDefault / time.Millisecond)})
	if err := transport.start(hello, []byte("ping-f2c")); err != nil {
		t.Fatal(err)
	}
	reply, err := transport.readFrame()
	if err != nil {
		t.Fatalf("第一台不回结果：应该换第二台重放，得到 %v", err)
	}
	if string(reply) != "ping-f2c" {
		t.Fatalf("回声不对：%q", reply)
	}
	state := selector.states[0]
	state.mu.Lock()
	healthy, suspect := !state.tcp.down, state.tcp.suspect
	state.mu.Unlock()
	if !healthy {
		t.Fatal("一次等不到结果就把出口判坏了：应该只记一次可疑")
	}
	if suspect != 1 {
		t.Fatalf("一次等不到结果应该记一次可疑，记了 %d 次", suspect)
	}
}
