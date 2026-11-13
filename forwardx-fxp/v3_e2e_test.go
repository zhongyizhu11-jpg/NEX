package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	v3 "github.com/zhongyizhu11-jpg/NEX/forwardx-fxp/internal/v3"
)

/*
NEX V3 接入层的测试：真起 runExit / runRelay / runEntry，从入口的明文端口进、到回声目标，
三种外层 × 复用开 / 关都走一遍。上游的 internal/v3 包自带记录层、会话、外层的单元测试。
*/

func v3TestBool(value bool) *bool { return &value }

func v3TestConfig(mode string, mux bool) config {
	return config{TransportVersion: "v3", V3Transport: mode, V3Path: "/nex-v3", V3Host: "cdn.example.test", V3Multiplex: v3TestBool(mux)}
}

func startTCPEchoTarget(t *testing.T) int {
	t.Helper()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = target.Close() })
	go func() {
		for {
			c, err := target.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return target.Addr().(*net.TCPAddr).Port
}

func v3EchoThrough(t *testing.T, port int, payload []byte) error {
	t.Helper()
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 5*time.Second)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(15 * time.Second))
	writeErr := make(chan error, 1)
	go func() {
		_, err := c.Write(payload)
		writeErr <- err
	}()
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(c, got); err != nil {
		return fmt.Errorf("read: %w", err)
	}
	if err := <-writeErr; err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if !bytes.Equal(got, payload) {
		return fmt.Errorf("echo mismatch (%d bytes)", len(payload))
	}
	return nil
}

type v3TestRoute struct {
	entryPort int
	exitPort  int
	cfg       config
}

// startV3Route 起一对出口 + 入口（都是 V3），返回入口的明文端口。
func startV3Route(t *testing.T, base config, tunnelID, ruleID int, exitKey, entryKey string) v3TestRoute {
	t.Helper()
	targetPort := startTCPEchoTarget(t)
	exitPort := freeTCPUDPPort(t)
	entryPort := freeTCPUDPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	t.Cleanup(func() { close(entryDone); close(exitDone) })
	exitCfg := base
	exitCfg.Role, exitCfg.TunnelID, exitCfg.ListenPort, exitCfg.Protocol, exitCfg.Key = "exit", tunnelID, exitPort, "tcp", exitKey
	exitCfg.StreamTargets = loopbackStreamTargets(ruleID, targetPort)
	go func() { _ = runExit(exitDone, exitCfg) }()
	waitForTCP(t, exitPort)
	entryCfg := base
	entryCfg.Role, entryCfg.TunnelID, entryCfg.RuleID, entryCfg.ListenPort, entryCfg.Protocol = "entry", tunnelID, ruleID, entryPort, "tcp"
	entryCfg.ExitHost, entryCfg.ExitPort, entryCfg.TargetIP, entryCfg.TargetPort, entryCfg.Key = "127.0.0.1", exitPort, "127.0.0.1", targetPort, entryKey
	go func() { _ = runEntry(entryDone, entryCfg) }()
	waitForTCP(t, entryPort)
	return v3TestRoute{entryPort: entryPort, exitPort: exitPort, cfg: entryCfg}
}

func TestV3EndToEndOnEveryOuterTransport(t *testing.T) {
	big := make([]byte, 3<<20)
	_, _ = rand.Read(big)
	tunnelID := 3100
	for _, mode := range []string{"http", "ws", "tls"} {
		for _, mux := range []bool{false, true} {
			tunnelID++
			id := tunnelID
			t.Run(fmt.Sprintf("%s/mux=%v", mode, mux), func(t *testing.T) {
				resetFXPEndpointRegistry()
				route := startV3Route(t, v3TestConfig(mode, mux), id, id*10, "v3-e2e-key", "v3-e2e-key")
				if err := v3EchoThrough(t, route.entryPort, []byte("hello v3")); err != nil {
					t.Fatal(err)
				}
				// 3 MiB 一来一回：跨过很多条内层记录、多路复用时跨过很多次窗口续期。
				if err := v3EchoThrough(t, route.entryPort, big); err != nil {
					t.Fatal(err)
				}
				// 并发几条，复用时它们挤在同一条物理连接上。
				var wg sync.WaitGroup
				errs := make(chan error, 12)
				for i := 0; i < 12; i++ {
					wg.Add(1)
					go func(i int) {
						defer wg.Done()
						errs <- v3EchoThrough(t, route.entryPort, bytes.Repeat([]byte{byte(i)}, 200_000+i))
					}(i)
				}
				wg.Wait()
				close(errs)
				for err := range errs {
					if err != nil {
						t.Fatal(err)
					}
				}
				if mux {
					cfg := route.cfg
					v3Outbound.mu.Lock()
					bucket := v3Outbound.buckets[v3PoolKey("127.0.0.1", route.exitPort, cfg)]
					sessions := 0
					if bucket != nil {
						sessions = len(bucket.sessions)
					}
					v3Outbound.mu.Unlock()
					if sessions != 1 {
						t.Fatalf("12 条并发业务连接应该共用 1 条物理会话，实际 %d 条", sessions)
					}
				}
			})
		}
	}
}

// 不复用时，入口的预热连接池照样工作：第一条连接之后池子里有握好手的 V3 连接。
func TestV3WithoutMultiplexPrewarmsEndpointPool(t *testing.T) {
	resetFXPEndpointRegistry()
	route := startV3Route(t, v3TestConfig("tls", false), 3201, 32010, "v3-pool-key", "v3-pool-key")
	if err := v3EchoThrough(t, route.entryPort, []byte("warm up")); err != nil {
		t.Fatal(err)
	}
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: route.exitPort, Key: "v3-pool-key", transport: v3TransportIdentity(route.cfg)})
	deadline := time.Now().Add(5 * time.Second)
	for {
		state.mu.Lock()
		idle := len(state.idle)
		state.mu.Unlock()
		if idle > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("V3（不复用）的端点连接池没有预热")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// 池子里的连接直接拿来用。
	if err := v3EchoThrough(t, route.entryPort, []byte("from the pool")); err != nil {
		t.Fatal(err)
	}
	// 一个 V1 配置拿到的端点状态和它不是一份。
	v1 := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: route.exitPort, Key: "v3-pool-key"})
	if v1 == state {
		t.Fatal("V1 和 V3 不能共用一份端点状态（连接池里的连接是按 V3 外层握的手）")
	}
}

func TestV3RejectsWrongTunnelKey(t *testing.T) {
	for _, mode := range []string{"http", "ws", "tls"} {
		t.Run(mode, func(t *testing.T) {
			resetFXPEndpointRegistry()
			route := startV3Route(t, v3TestConfig(mode, true), 3301, 33010, "right-key", "wrong-key")
			if err := v3EchoThrough(t, route.entryPort, []byte("must not pass")); err == nil {
				t.Fatal("密钥不对的入口不该连得通")
			}
		})
	}
}

// 外层路径对不上（一端改了配置另一端还没改）就是连不上，不会悄悄退回 V1。
func TestV3MismatchedPathDoesNotConnect(t *testing.T) {
	resetFXPEndpointRegistry()
	targetPort := startTCPEchoTarget(t)
	exitPort := freeTCPUDPPort(t)
	entryPort := freeTCPUDPPort(t)
	exitDone, entryDone := make(chan struct{}), make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)
	exitCfg := v3TestConfig("http", false)
	exitCfg.Role, exitCfg.TunnelID, exitCfg.ListenPort, exitCfg.Protocol, exitCfg.Key = "exit", 3401, exitPort, "tcp", "path-key"
	exitCfg.StreamTargets = loopbackStreamTargets(34010, targetPort)
	go func() { _ = runExit(exitDone, exitCfg) }()
	waitForTCP(t, exitPort)
	entryCfg := v3TestConfig("http", false)
	entryCfg.V3Path = "/other"
	entryCfg.Role, entryCfg.TunnelID, entryCfg.RuleID, entryCfg.ListenPort, entryCfg.Protocol = "entry", 3401, 34010, entryPort, "tcp"
	entryCfg.ExitHost, entryCfg.ExitPort, entryCfg.TargetIP, entryCfg.TargetPort, entryCfg.Key = "127.0.0.1", exitPort, "127.0.0.1", targetPort, "path-key"
	go func() { _ = runEntry(entryDone, entryCfg) }()
	waitForTCP(t, entryPort)
	if err := v3EchoThrough(t, entryPort, []byte("x")); err == nil {
		t.Fatal("路径不一致还连通了")
	}
}

// 入口 → 中转 → 出口，每一跳各自的密钥，全程 V3。
func TestV3RelayChainWithPerHopKeys(t *testing.T) {
	for _, mux := range []bool{false, true} {
		t.Run(fmt.Sprintf("mux=%v", mux), func(t *testing.T) {
			resetFXPEndpointRegistry()
			base := v3TestConfig("ws", mux)
			targetPort := startTCPEchoTarget(t)
			exitPort, relayPort, entryPort := freeTCPUDPPort(t), freeTCPUDPPort(t), freeTCPUDPPort(t)
			done := make(chan struct{})
			defer close(done)
			exitCfg := base
			exitCfg.Role, exitCfg.TunnelID, exitCfg.ListenPort, exitCfg.Protocol, exitCfg.Key = "exit", 3501, exitPort, "tcp", "hop-2-key"
			exitCfg.StreamTargets = loopbackStreamTargets(35010, targetPort)
			go func() { _ = runExit(done, exitCfg) }()
			waitForTCP(t, exitPort)
			relayCfg := base
			relayCfg.Role, relayCfg.TunnelID, relayCfg.ListenPort, relayCfg.Protocol, relayCfg.Key = "relay", 3501, relayPort, "tcp", "hop-1-key"
			relayCfg.RelayExitHost, relayCfg.RelayExitPort, relayCfg.RelayKey = "127.0.0.1", exitPort, "hop-2-key"
			go func() { _ = runRelay(done, relayCfg) }()
			waitForTCP(t, relayPort)
			entryCfg := base
			entryCfg.Role, entryCfg.TunnelID, entryCfg.RuleID, entryCfg.ListenPort, entryCfg.Protocol = "entry", 3501, 35010, entryPort, "tcp"
			entryCfg.ExitHost, entryCfg.ExitPort, entryCfg.TargetIP, entryCfg.TargetPort, entryCfg.Key = "127.0.0.1", relayPort, "127.0.0.1", targetPort, "hop-1-key"
			go func() { _ = runEntry(done, entryCfg) }()
			waitForTCP(t, entryPort)
			for i := 0; i < 3; i++ {
				if err := v3EchoThrough(t, entryPort, bytes.Repeat([]byte("relay"), 50_000)); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

// 主用出口挂了，V3 也按出口策略切到备用（多路复用时走会话池，同样要把失败报给选择器）。
func TestV3FallsBackToHealthyExit(t *testing.T) {
	for _, mux := range []bool{false, true} {
		t.Run(fmt.Sprintf("mux=%v", mux), func(t *testing.T) {
			resetFXPEndpointRegistry()
			base := v3TestConfig("tls", mux)
			targetPort := startTCPEchoTarget(t)
			dead := freeTCPUDPPort(t) // 没人听
			backupPort, entryPort := freeTCPUDPPort(t), freeTCPUDPPort(t)
			done := make(chan struct{})
			defer close(done)
			exitCfg := base
			exitCfg.Role, exitCfg.TunnelID, exitCfg.ListenPort, exitCfg.Protocol, exitCfg.Key = "exit", 3601, backupPort, "tcp", "fallback-key"
			exitCfg.StreamTargets = loopbackStreamTargets(36010, targetPort)
			go func() { _ = runExit(done, exitCfg) }()
			waitForTCP(t, backupPort)
			entryCfg := base
			entryCfg.Role, entryCfg.TunnelID, entryCfg.RuleID, entryCfg.ListenPort, entryCfg.Protocol = "entry", 3601, 36010, entryPort, "tcp"
			entryCfg.ExitHost, entryCfg.ExitPort, entryCfg.TargetIP, entryCfg.TargetPort, entryCfg.Key = "127.0.0.1", dead, "127.0.0.1", targetPort, "fallback-key"
			entryCfg.ExitStrategy = "fallback"
			entryCfg.Exits = []exitEndpoint{{Host: "127.0.0.1", Port: backupPort, Key: "fallback-key"}}
			go func() { _ = runEntry(done, entryCfg) }()
			waitForTCP(t, entryPort)
			for i := 0; i < 3; i++ {
				if err := v3EchoThrough(t, entryPort, []byte("fallback")); err != nil {
					t.Fatalf("第 %d 条: %v", i+1, err)
				}
			}
		})
	}
}

// UDP 直连不走 V3 外层，开了 V3 照常通。
func TestV3TunnelKeepsUDPDirect(t *testing.T) {
	resetFXPEndpointRegistry()
	target := startUDPEchoTarget(t)
	defer target.Close()
	targetPort := target.LocalAddr().(*net.UDPAddr).Port
	exitPort, entryPort := freeTCPUDPPort(t), freeTCPUDPPort(t)
	done := make(chan struct{})
	defer close(done)
	base := v3TestConfig("tls", true)
	exitCfg := base
	exitCfg.Role, exitCfg.TunnelID, exitCfg.ListenPort, exitCfg.Protocol, exitCfg.Key = "exit", 3701, exitPort, "both", "udp-key"
	exitCfg.UDPTargets = []udpTarget{{RuleID: 37010, TargetIP: "127.0.0.1", TargetPort: targetPort}}
	go func() { _ = runExit(done, exitCfg) }()
	entryCfg := base
	entryCfg.Role, entryCfg.TunnelID, entryCfg.RuleID, entryCfg.ListenPort, entryCfg.Protocol = "entry", 3701, 37010, entryPort, "both"
	entryCfg.ExitHost, entryCfg.ExitPort, entryCfg.TargetIP, entryCfg.TargetPort, entryCfg.Key = "127.0.0.1", exitPort, "127.0.0.1", targetPort, "udp-key"
	go func() { _ = runEntry(done, entryCfg) }()
	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: entryPort})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if reply := udpRoundTrip(t, client, []byte("udp over v3 tunnel")); string(reply) != "udp over v3 tunnel" {
		t.Fatalf("udp echo %q", reply)
	}
}

func TestV3ConfigValidation(t *testing.T) {
	base := config{Role: "exit", TunnelID: 1, ListenPort: 1000, Protocol: "tcp", Key: "k"}
	cases := []struct {
		name    string
		mutate  func(*config)
		wantErr string
	}{
		{"v1 不带 V3 选项", func(c *config) {}, ""},
		{"v1 上写了 V3 选项", func(c *config) { c.V3Transport = "tls" }, "require transportVersion v3"},
		{"v2 上写了多路复用", func(c *config) { c.TransportVersion = "v2"; c.V3Multiplex = v3TestBool(true) }, "require transportVersion v3"},
		{"v3 没选外层", func(c *config) { c.TransportVersion = "v3" }, "requires http, ws, or tls"},
		{"v3 外层写错", func(c *config) { c.TransportVersion = "v3"; c.V3Transport = "quic" }, "requires http, ws, or tls"},
		{"不认识的版本", func(c *config) { c.TransportVersion = "v4" }, "unsupported transportVersion"},
		{"v3 tls", func(c *config) { c.TransportVersion = "v3"; c.V3Transport = "tls"; c.V3ServerName = "a.example" }, ""},
		{"v3 SNI 带斜杠", func(c *config) { c.TransportVersion = "v3"; c.V3Transport = "tls"; c.V3ServerName = "a/b" }, "server name"},
		{"v3 路径带换行", func(c *config) { c.TransportVersion = "v3"; c.V3Transport = "http"; c.V3Path = "/a\r\nX: y" }, "invalid HTTP"},
		{"v3 UA 带换行", func(c *config) { c.TransportVersion = "v3"; c.V3Transport = "ws"; c.V3UserAgent = "a\nb" }, "invalid HTTP"},
		{"v3 + 抗丢包传输", func(c *config) { c.TransportVersion = "v3"; c.V3Transport = "tls"; c.LossTolerant = true }, "only supported on v1"},
		// 多路径可以走 V3 了（每条腿一条不复用的 V3 物理连接，见 v3_multipath_test.go）。
		{"v3 + 多路径", func(c *config) {
			c.TransportVersion = "v3"
			c.V3Transport = "tls"
			c.MultipathEnabled = true
			c.MultipathLegs = []multipathLeg{{Host: "a", Port: 1}, {Host: "b", Port: 2}}
		}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := base
			tc.mutate(&cfg)
			err := validateConfig(normalizeConfig(cfg))
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("不该报错: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
	// 入口组里每条入口各自校验。
	group := config{Role: "entry-group", TunnelID: 2, Entries: []config{{
		Role: "entry", TunnelID: 2, RuleID: 3, ListenPort: 2000, Protocol: "tcp", Key: "k",
		ExitHost: "127.0.0.1", ExitPort: 2001, TargetIP: "127.0.0.1", TargetPort: 80,
		TransportVersion: "v3",
	}}}
	if err := validateConfig(normalizeConfig(group)); err == nil || !strings.Contains(err.Error(), "requires http, ws, or tls") {
		t.Fatalf("入口组里缺外层的 V3 入口应该被拒: %v", err)
	}
	group.Entries[0].V3Transport = " WS "
	if err := validateConfig(normalizeConfig(group)); err != nil {
		t.Fatalf("外层写法应该归一化: %v", err)
	}
}

func TestV3MultiplexDefaultsOnWhenOmitted(t *testing.T) {
	cfg := config{TransportVersion: "v3", V3Transport: "tls"}
	if !v3MuxEnabled(cfg) {
		t.Fatal("没写 v3Multiplex 时按开（和上游一致）")
	}
	cfg.V3Multiplex = v3TestBool(false)
	if v3MuxEnabled(cfg) {
		t.Fatal("显式关掉就不复用")
	}
	if v3MuxEnabled(config{V3Multiplex: v3TestBool(true)}) {
		t.Fatal("V1 不会复用")
	}
	if v3TransportIdentity(config{}) != "" {
		t.Fatal("V1 的端点身份不能变")
	}
	a := v3TransportIdentity(config{TransportVersion: "v3", V3Transport: "http", V3Path: "/a"})
	b := v3TransportIdentity(config{TransportVersion: "v3", V3Transport: "http", V3Path: "/b"})
	if a == "" || a == b {
		t.Fatal("外层选项不同，端点身份要不同")
	}
}

func TestV3LogicalFrames(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	writer := &secureConn{conn: left, logical: true}
	reader := &secureConn{conn: right, logical: true}
	go func() {
		_ = writer.writeFrames([]byte("one"), nil, bytes.Repeat([]byte{7}, 70_000))
	}()
	first, err := reader.readFrame()
	if err != nil || string(first) != "one" {
		t.Fatalf("first=%q err=%v", first, err)
	}
	empty, err := reader.readFrame()
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("空帧要交出非 nil 的空切片（对端写完了）: %v %v", empty, err)
	}
	frames, err := reader.readFrames(nil, 8)
	if err != nil || len(frames) != 1 || len(frames[0]) != 70_000 {
		t.Fatalf("frames=%d err=%v", len(frames), err)
	}
	if err := writer.writeFrame(make([]byte, v3LogicalFrameLimit+1)); err == nil {
		t.Fatal("超长逻辑帧应该在写之前就拒")
	}
	// 读端：对端声称一个超长帧，不按它分配。
	go func() { _, _ = left.Write([]byte{0xff, 0xff, 0xff, 0xff}) }()
	if _, err := reader.readFrame(); err == nil {
		t.Fatal("超长逻辑帧应该被拒")
	}
}

// 多路复用的每个逻辑流在监听上单独登记，处理完就注销。
func TestV3StreamsTrackedPerStream(t *testing.T) {
	slot := &tcpListenerSlot{conns: map[net.Conn]*trackedConn{}}
	parent := &fxpInbound{role: "exit", tracked: &trackedConn{slot: slot}}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	child := parent.forStream(a)
	if child == nil || child.tracked == nil || child.tracked.slot != slot || child.admission != nil {
		t.Fatalf("child=%+v", child)
	}
	slot.connsMu.Lock()
	_, ok := slot.conns[a]
	slot.connsMu.Unlock()
	if !ok {
		t.Fatal("逻辑流没有登记")
	}
	child.releaseStream(a)
	slot.connsMu.Lock()
	_, ok = slot.conns[a]
	slot.connsMu.Unlock()
	if ok {
		t.Fatal("逻辑流处理完没有注销")
	}
	var nilIn *fxpInbound
	if nilIn.forStream(a) != nil {
		t.Fatal("nil 的监听状态派生出来也是 nil")
	}
}

func TestV3PoolLimitIsNotAnEndpointFailure(t *testing.T) {
	if v3EndpointFailureIsRetryable(fmt.Errorf("%w (x)", v3ErrPoolLimit)) {
		t.Fatal("池子到顶是本地上限，不该换端点")
	}
	if v3EndpointFailureIsRetryable(v3.ErrStreamLimit) || v3EndpointFailureIsRetryable(net.ErrClosed) {
		t.Fatal("本地错误不该换端点")
	}
	if !v3EndpointFailureIsRetryable(io.ErrUnexpectedEOF) {
		t.Fatal("对端断开应该换端点")
	}
}

// TLS 外层的证书公钥由隧道密钥派生并被钉死：密钥不同就过不了 TLS。
func TestV3TLSPinsTunnelKey(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	cfg := config{TransportVersion: "v3", V3Transport: "tls", Key: "server-key"}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if conn, err := wrapV3Server(server, cfg); err == nil {
			_ = conn.Close()
		}
	}()
	wrong := cfg
	wrong.Key = "client-key"
	if _, err := wrapV3Client(client, wrong); err == nil || !strings.Contains(err.Error(), "pin mismatch") {
		t.Fatalf("证书钉扎应该挡住不同的密钥: %v", err)
	}
	_ = client.Close()
	<-done
}

// SNI 留空就不发（上游会发 forwardx.invalid），填了就照填的发。
func TestV3TLSServerNameOnlyWhenConfigured(t *testing.T) {
	for _, name := range []string{"", "www.example.test"} {
		client, server := net.Pipe()
		cert, err := v3Certificate("sni-key")
		if err != nil {
			t.Fatal(err)
		}
		seen := make(chan string, 1)
		go func() {
			conn := tls.Server(server, &tls.Config{
				Certificates: []tls.Certificate{cert},
				GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
					seen <- hello.ServerName
					return nil, nil
				},
			})
			_ = conn.Handshake()
			_ = conn.Close()
		}()
		cfg := config{TransportVersion: "v3", V3Transport: "tls", Key: "sni-key", V3ServerName: name}
		if _, err := wrapV3Client(client, cfg); err != nil {
			t.Fatalf("sni=%q: %v", name, err)
		}
		if got := <-seen; got != name {
			t.Fatalf("SNI 应该是 %q，实际 %q", name, got)
		}
		_ = client.Close()
		_ = server.Close()
	}
}
