package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/*
负载均衡整治阶段 2 的实测用例（真实的入口、出口、探测，真实的时间）：

	(a) UDP 会话所在的出口中途变成黑洞：多久之后访客的包换到另一台出口（目标 ≤ 5 秒；阶段 1 实验室里约 16 秒）
	(b) 同一条规则 TCP+UDP 都开、只有 UDP 被拦：UDP 会话换走，TCP 照常用那台出口
	(e) 出口恢复之后多久重新接新连接（目标 ≤ 10 秒），轮流和自动各量一次

黑洞用下面两个「闸」来做：夹在入口和出口中间的转发器，关上以后包照收、不转发、不回应，连接也不断 ——
和线路中间被丢包一样，对端看不到任何错误。
*/

// udpBlackholeGate 把发到它的 UDP 包转给 target，回包转回去；blackhole 之后两个方向都悄悄丢掉。
type udpBlackholeGate struct {
	conn   *net.UDPConn
	target *net.UDPAddr
	drop   atomic.Bool
	mu     sync.Mutex
	peers  map[netip.AddrPort]*net.UDPConn
}

func startUDPBlackholeGate(t *testing.T, targetPort int) *udpBlackholeGate {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	gate := &udpBlackholeGate{conn: conn, target: &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: targetPort}, peers: map[netip.AddrPort]*net.UDPConn{}}
	t.Cleanup(func() {
		_ = conn.Close()
		gate.mu.Lock()
		defer gate.mu.Unlock()
		for _, peer := range gate.peers {
			_ = peer.Close()
		}
	})
	go func() {
		buf := make([]byte, 65535)
		for {
			n, from, err := conn.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			if gate.drop.Load() {
				continue
			}
			gate.mu.Lock()
			peer := gate.peers[from]
			if peer == nil {
				peer, err = net.DialUDP("udp", nil, gate.target)
				if err != nil {
					gate.mu.Unlock()
					continue
				}
				gate.peers[from] = peer
				go func(peer *net.UDPConn, from netip.AddrPort) {
					reply := make([]byte, 65535)
					for {
						n, err := peer.Read(reply)
						if err != nil {
							return
						}
						if !gate.drop.Load() {
							_, _ = conn.WriteToUDPAddrPort(reply[:n], from)
						}
					}
				}(peer, from)
			}
			gate.mu.Unlock()
			_, _ = peer.Write(buf[:n])
		}
	}()
	return gate
}

func (g *udpBlackholeGate) port() int { return g.conn.LocalAddr().(*net.UDPAddr).Port }

// tcpBlackholeGate 把连到它的 TCP 连接接到 target 上；blackhole 之后已有的连接两个方向都停住（不关），
// 新来的连接接进来但什么都不转 —— 对端握手发出去了，永远等不到确认。
type tcpBlackholeGate struct {
	listener net.Listener
	target   string
	drop     atomic.Bool
	mu       sync.Mutex
	conns    []net.Conn
}

func startTCPBlackholeGate(t *testing.T, targetPort int) *tcpBlackholeGate {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gate := &tcpBlackholeGate{listener: listener, target: net.JoinHostPort("127.0.0.1", strconv.Itoa(targetPort))}
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
			gate.track(client)
			go gate.serve(client)
		}
	}()
	return gate
}

func (g *tcpBlackholeGate) track(conn net.Conn) {
	g.mu.Lock()
	g.conns = append(g.conns, conn)
	g.mu.Unlock()
}

func (g *tcpBlackholeGate) serve(client net.Conn) {
	// 黑洞里接进来的连接：一直拿着，什么都不做。
	for g.drop.Load() {
		time.Sleep(20 * time.Millisecond)
	}
	upstream, err := net.DialTimeout("tcp", g.target, 2*time.Second)
	if err != nil {
		_ = client.Close()
		return
	}
	g.track(upstream)
	pipe := func(dst, src net.Conn) {
		defer dst.Close()
		defer src.Close()
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			for g.drop.Load() {
				// 黑洞：读到的也不转，停在这儿。
				time.Sleep(20 * time.Millisecond)
			}
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	go pipe(upstream, client)
	pipe(client, upstream)
}

func (g *tcpBlackholeGate) port() int { return g.listener.Addr().(*net.TCPAddr).Port }

// (a)(b) 一条规则 TCP+UDP 都开，两台出口（主备）。UDP 会话在主出口上有来有回，中途主出口的 UDP 变成黑洞（TCP 不受影响）。
func TestUDPBlackholedExitIsLeftWithinFiveSeconds(t *testing.T) {
	if testing.Short() {
		t.Skip("要等真实时间")
	}
	resetFXPEndpointRegistry()
	const tunnelID, ruleID, key = 401, 402, "stage2-udp-key"
	tcpTarget := startLatencyEchoTarget(t)
	exitUDP := make([]int, 2)
	exitTCP := make([]int, 2)
	gates := make([]*udpBlackholeGate, 2)
	for i, prefix := range []string{"A", "B"} {
		exitUDP[i], _ = startUDPDirectExit(t, "127.0.0.1", tunnelID, ruleID, key, startPrefixedUDPEcho(t, prefix))
		exitTCP[i] = startTestExit(t, tunnelID, key, loopbackStreamTargets(ruleID, tcpTarget)...)
		gates[i] = startUDPBlackholeGate(t, exitUDP[i])
	}
	endpoint := func(i int) exitEndpoint {
		return exitEndpoint{Host: "127.0.0.1", Port: exitTCP[i], UDPPort: gates[i].port(), Key: key}
	}
	selector := newExitEndpointSelector([]exitEndpoint{endpoint(1)}, endpoint(0), "fallback")
	cfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "both", Key: key,
		ExitHost: "127.0.0.1", ExitPort: exitTCP[0], UDPExitPort: gates[0].port(), Exits: []exitEndpoint{endpoint(0), endpoint(1)},
		TargetIP: "127.0.0.1", TargetPort: tcpTarget}
	defer selector.activate(cfg)()
	defer selector.activateUDP(cfg)()
	entry := startUDPDirectEntry(t, cfg, selector)
	client, err := net.DialUDP("udp", nil, entry)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if reply, ok := udpAsk(t, client, "hello", 2*time.Second); !ok || reply != "A:hello" {
		t.Fatalf("主备的 UDP 会话应该走主出口：%q", reply)
	}
	// 一条有来有回的会话跑上几秒，让探活认识两台出口。
	for i := 0; i < 20; i++ {
		if reply, ok := udpAsk(t, client, "warm", time.Second); !ok || reply != "A:warm" {
			t.Fatalf("预热时丢了回包：%q ok=%v", reply, ok)
		}
		time.Sleep(100 * time.Millisecond)
	}
	gates[0].drop.Store(true)
	blackholed := time.Now()
	moved := time.Duration(0)
	for time.Since(blackholed) < 12*time.Second {
		if reply, ok := udpAsk(t, client, "ping", 100*time.Millisecond); ok && reply == "B:ping" {
			moved = time.Since(blackholed)
			break
		}
	}
	if moved == 0 {
		t.Fatal("主出口的 UDP 黑洞了 12 秒，访客的包还没换到另一台出口")
	}
	t.Logf("(a) UDP 出口变黑洞后 %v 访客的包换到了另一台出口（阶段 1 实验室：约 16 秒）", moved.Round(10*time.Millisecond))
	if moved > 5*time.Second {
		t.Fatalf("应该在 5 秒内换走，用了 %v", moved)
	}
	// 会话自己的证据（没回包 + 一轮探活没回）先到，出口要连着两轮探活没回才判成 UDP 不通：再等它一下。
	for deadline := time.Now().Add(3 * time.Second); ; {
		if ok, _ := selector.states[0].reachable(true, time.Now()); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("UDP 黑洞了的出口没有被判成 UDP 不通")
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Logf("(a) UDP 出口变黑洞后 %v 被判成 UDP 不通（新会话不再给它）", time.Since(blackholed).Round(10*time.Millisecond))
	// (b) TCP 那一侧不受连累：新的 TCP 连接还是走主出口，UDP 新会话给备用。
	if ok, _ := selector.states[0].reachable(false, time.Now()); !ok {
		t.Fatal("只有 UDP 被拦，TCP 那一侧不该被判成连不上")
	}
	if _, index, _ := selector.pick(nil); index != 0 {
		t.Fatalf("(b) TCP 新连接应该还走主出口，得到 %d", index)
	}
	if _, index, _ := selector.pickUDP(nil); index != 1 {
		t.Fatalf("(b) UDP 新会话应该给备用出口，得到 %d", index)
	}
	// (e) UDP 恢复：多久之后重新认它（UDP 新会话回到主出口）。
	gates[0].drop.Store(false)
	restored := time.Now()
	for {
		if ok, _ := selector.states[0].reachable(true, time.Now()); ok {
			break
		}
		if time.Since(restored) > 15*time.Second {
			t.Fatal("UDP 恢复 15 秒了还没被重新认回来")
		}
		time.Sleep(50 * time.Millisecond)
	}
	readmitted := time.Since(restored)
	t.Logf("(e) UDP 恢复后 %v 被重新认回来", readmitted.Round(10*time.Millisecond))
	if readmitted > 10*time.Second {
		t.Fatalf("应该在 10 秒内认回来，用了 %v", readmitted)
	}
}

// 应用协议本来就单向（访客只发不收）：出口好好的，探活一直在回 —— 会话不该被挪走。
func TestOneWayUDPProtocolStaysOnAHealthyExit(t *testing.T) {
	if testing.Short() {
		t.Skip("要等真实时间")
	}
	resetFXPEndpointRegistry()
	const tunnelID, ruleID, key = 411, 412, "stage2-oneway-key"
	sink := func() (int, *atomic.Int64) {
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		received := &atomic.Int64{}
		go func() {
			buf := make([]byte, 2048)
			for {
				if _, _, err := conn.ReadFromUDPAddrPort(buf); err != nil {
					return
				}
				received.Add(1)
			}
		}()
		return conn.LocalAddr().(*net.UDPAddr).Port, received
	}
	sinkA, receivedA := sink()
	sinkB, receivedB := sink()
	portA, _ := startUDPDirectExit(t, "127.0.0.1", tunnelID, ruleID, key, sinkA)
	portB, _ := startUDPDirectExit(t, "127.0.0.1", tunnelID, ruleID, key, sinkB)
	endpoints := []exitEndpoint{{Host: "127.0.0.1", Port: portA, UDPPort: portA, Key: key}, {Host: "127.0.0.1", Port: portB, UDPPort: portB, Key: key}}
	selector := newExitEndpointSelector(endpoints[1:], endpoints[0], "fallback")
	cfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: key,
		ExitHost: "127.0.0.1", ExitPort: portA, UDPExitPort: portA, Exits: endpoints, TargetIP: "127.0.0.1", TargetPort: sinkA}
	defer selector.activateUDP(cfg)()
	entry := startUDPDirectEntry(t, cfg, selector)
	client, err := net.DialUDP("udp", nil, entry)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for i := 0; i < 60; i++ {
		if _, err := client.Write([]byte("log line")); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if receivedA.Load() < 55 || receivedB.Load() != 0 {
		t.Fatalf("单向协议的会话应该一直留在健康的主出口上：主出口收到 %d 个，备用收到 %d 个", receivedA.Load(), receivedB.Load())
	}
}

// (e) 出口（TCP）黑洞一阵又恢复：多久之后重新分到新连接。轮流和自动各量一次。
func TestExitIsReadmittedWithinTenSecondsAfterABlackhole(t *testing.T) {
	if testing.Short() {
		t.Skip("要等真实时间")
	}
	for _, strategy := range []string{"round_robin", "auto"} {
		t.Run(strategy, func(t *testing.T) {
			resetFXPEndpointRegistry()
			const tunnelID, ruleID, key = 421, 422, "stage2-readmit-key"
			target := startLatencyEchoTarget(t)
			gates := make([]*tcpBlackholeGate, 3)
			endpoints := make([]exitEndpoint, 3)
			for i := range gates {
				gates[i] = startTCPBlackholeGate(t, startTestExit(t, tunnelID, key, loopbackStreamTargets(ruleID, target)...))
				endpoints[i] = exitEndpoint{Host: "127.0.0.1", Port: gates[i].port(), Key: key}
			}
			selector := newExitEndpointSelector(endpoints[1:], endpoints[0], strategy)
			cfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "tcp", Key: key,
				ExitHost: "127.0.0.1", ExitPort: endpoints[0].Port, Exits: endpoints, TargetIP: "127.0.0.1", TargetPort: target}
			defer selector.activate(cfg)()
			share := func(picks int) int {
				hits := 0
				for i := 0; i < picks; i++ {
					if _, index, ok := selector.pick(nil); ok {
						if index == 1 {
							hits++
						}
						// 轮流：挑完就退。自动：留着（当它们是正在拨的连接）—— 成本看负载，别的出口上一点负载都没有时，
						// 还在慢启动里的出口成本永远最高，本来就轮不到它。
						if strategy != "auto" {
							selector.unpick(index)
						}
					}
				}
				return hits
			}
			time.Sleep(1500 * time.Millisecond)
			if share(30) == 0 {
				t.Fatal("起初三台都该分到")
			}
			gates[1].drop.Store(true)
			blackholed := time.Now()
			for selector.states[1].isHealthy() {
				if time.Since(blackholed) > 40*time.Second {
					t.Fatal("出口黑洞了 40 秒还没被判成连不上")
				}
				time.Sleep(50 * time.Millisecond)
			}
			detected := time.Since(blackholed)
			if hits := share(30); hits != 0 {
				t.Fatalf("判成连不上之后不该再分给它：%d", hits)
			}
			// 黑洞再持续一阵（实验室里那次是恢复 20 秒后还没分到）。
			time.Sleep(8 * time.Second)
			gates[1].drop.Store(false)
			restored := time.Now()
			for !selector.states[1].isHealthy() {
				if time.Since(restored) > 30*time.Second {
					t.Fatal("出口恢复 30 秒了还没被重新认回来")
				}
				time.Sleep(50 * time.Millisecond)
			}
			readmitted := time.Since(restored)
			// 认回来之后新连接什么时候真的分到它：轮流马上就有；自动要看成本 —— 它刚恢复（慢启动按一成算），
			// 而且恢复那一下的握手多半很慢（卡在黑洞里的那次探测这时才通），peak EWMA 要几秒才落回来。
			for share(30) == 0 {
				if time.Since(restored) > 40*time.Second {
					t.Fatal("出口认回来了，40 秒还没分到新连接")
				}
				time.Sleep(100 * time.Millisecond)
			}
			picked := time.Since(restored)
			t.Logf("(e) %s：黑洞后 %v 判成连不上；恢复后 %v 重新认回来，%v 重新分到新连接", strategy,
				detected.Round(100*time.Millisecond), readmitted.Round(100*time.Millisecond), picked.Round(100*time.Millisecond))
			if readmitted > 10*time.Second {
				t.Fatalf("恢复后应该 10 秒内重新认回来，用了 %v", readmitted)
			}
			if strategy == "round_robin" && picked > 10*time.Second {
				t.Fatalf("轮流：认回来就该分到，用了 %v", picked)
			}
			// 刚回来的在慢启动里：只分到一小份，不是一回来就满份。
			if snap := selector.loads[1].snapshot(time.Now()); snap.slowStart > 0.5 {
				t.Fatalf("刚恢复的出口应该慢慢加量：%v", snap.slowStart)
			}
		})
	}
}

// (c)(d) 一台出口变成黑洞（握手早就做完的预热连接 / 复用会话看起来还活着），接着开 30 条 TCP 连接：一条都不该失败。
// V1 一直是「第一条等 6 秒换出口，其余立刻」；V3 以前有一条永远等下去（逻辑帧没有截止时间），而且借来的连接会把
// 刚判坏的出口又改回健康。
func TestBlackholedExitNeverFailsANewTCPConnection(t *testing.T) {
	if testing.Short() {
		t.Skip("要等真实时间")
	}
	on, off := true, false
	for _, mode := range []struct {
		name  string
		apply func(c *config)
	}{
		{"v1", func(c *config) {}},
		{"v3-nomux", func(c *config) { c.TransportVersion, c.V3Transport, c.V3Multiplex = "v3", "tls", &off }},
		{"v3-mux", func(c *config) { c.TransportVersion, c.V3Transport, c.V3Multiplex = "v3", "tls", &on }},
	} {
		t.Run(mode.name, func(t *testing.T) {
			resetFXPEndpointRegistry()
			const tunnelID, ruleID, key = 431, 432, "stage2-v3-key"
			target := startEchoTCPTarget(t)
			done := make(chan struct{})
			defer close(done)
			gates := make([]*tcpBlackholeGate, 3)
			exits := make([]exitEndpoint, 3)
			for i := range gates {
				port := freeTCPUDPPort(t)
				exitCfg := config{Role: "exit", TunnelID: tunnelID, ListenPort: port, Protocol: "tcp", Key: key, StreamTargets: loopbackStreamTargets(ruleID, target)}
				mode.apply(&exitCfg)
				go func() { _ = runExit(done, exitCfg) }()
				waitForTCP(t, port)
				gates[i] = startTCPBlackholeGate(t, port)
				exits[i] = exitEndpoint{Host: "127.0.0.1", Port: gates[i].port(), Key: key, TargetStatus: true}
			}
			entryPort := freeTCPUDPPort(t)
			entryCfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, ListenPort: entryPort, Protocol: "tcp",
				ExitHost: "127.0.0.1", ExitPort: exits[0].Port, ExitStrategy: "round_robin", Exits: exits,
				TargetIP: "127.0.0.1", TargetPort: target, Key: key}
			mode.apply(&entryCfg)
			go func() { _ = runEntry(done, entryCfg) }()
			waitForTCP(t, entryPort)
			for i := 0; i < 9; i++ {
				if _, err := roadmapEcho(t, entryPort, "", "warm-up", 5*time.Second); err != nil {
					t.Fatalf("预热第 %d 条就不通：%v", i+1, err)
				}
			}
			// 等预热连接 / 复用会话备好，再把第二台变成黑洞。
			time.Sleep(1500 * time.Millisecond)
			gates[1].drop.Store(true)
			failed, slow := 0, 0
			var longest time.Duration
			for i := 0; i < 30; i++ {
				elapsed, err := roadmapEcho(t, entryPort, "", "after-blackhole", 20*time.Second)
				if err != nil {
					failed++
					t.Logf("第 %d 条失败（%v）：%v", i+1, elapsed.Round(time.Millisecond), err)
				}
				if elapsed > time.Second {
					slow++
				}
				if elapsed > longest {
					longest = elapsed
				}
			}
			t.Logf("(d) %s：一台出口黑洞后 30 条新连接：失败 %d 条，等了 1 秒以上的 %d 条，最久 %v", mode.name, failed, slow, longest.Round(10*time.Millisecond))
			if failed != 0 {
				t.Fatalf("有 %d 条连接失败了，应该换出口重放", failed)
			}
			if longest > fxpTargetStatusWait+3*time.Second {
				t.Fatalf("最久的一条等了 %v，应该在等结果的截止时间（%v）附近就换出口", longest, fxpTargetStatusWait)
			}
			if slow > 3 {
				t.Fatalf("判坏之后不该再有连接撞上去等：%d 条等了 1 秒以上", slow)
			}
		})
	}
}

var errStage2 = errors.New("stage2")

func stage2Echo(t *testing.T, conn net.Conn, payload string, wait time.Duration) (string, error) {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(wait))
	if _, err := conn.Write([]byte(payload)); err != nil {
		return "", err
	}
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, buf); err != nil {
		return "", fmt.Errorf("%w: %v", errStage2, err)
	}
	return string(buf), nil
}
