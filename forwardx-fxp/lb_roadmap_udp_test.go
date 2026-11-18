package main

import (
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

/*
路线图 X3：UDP 直连在负载均衡里是一等公民 —— 记负载、看健康、会换出口、中转上按访客固定。
这一个文件里的测试只用改之前就有的接口，在没改的代码上跑红过。
*/

// startPrefixedUDPEcho 起一个 UDP 目标：回 "<prefix>:<收到的内容>"，看得出是经哪台出口到的。
func startPrefixedUDPEcho(t *testing.T, prefix string) int {
	t.Helper()
	target, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = target.Close() })
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := target.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			_, _ = target.WriteToUDPAddrPort(append([]byte(prefix+":"), buf[:n]...), addr)
		}
	}()
	return target.LocalAddr().(*net.UDPAddr).Port
}

// startUDPDirectExit 起一台只跑 UDP 直连的出口（直接用读循环），返回它的端口和关掉它的函数。
func startUDPDirectExit(t *testing.T, host string, tunnelID, ruleID int, key string, targetPort int) (int, func()) {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP(host), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	cfg := config{Role: "exit", TunnelID: tunnelID, Protocol: "udp", Key: key,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort}}}
	done := make(chan struct{})
	go func() {
		_ = serveExitUDPDirect(conn, cfg)
		close(done)
	}()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = conn.Close()
			<-done
		})
	}
	t.Cleanup(stop)
	return conn.LocalAddr().(*net.UDPAddr).Port, stop
}

// startUDPDirectEntry 起入口的 UDP 读循环，返回监听地址。
func startUDPDirectEntry(t *testing.T, cfg config, selector *exitEndpointSelector) *net.UDPAddr {
	t.Helper()
	listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = serveEntryUDPDirect(listener, cfg, selector, newLimiter(0), newLimiter(0))
		close(done)
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		<-done
	})
	return listener.LocalAddr().(*net.UDPAddr)
}

func udpAsk(t *testing.T, client *net.UDPConn, payload string, wait time.Duration) (string, bool) {
	t.Helper()
	if _, err := client.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(wait))
	buf := make([]byte, 2048)
	n, err := client.Read(buf)
	if err != nil {
		return "", false
	}
	return string(buf[:n]), true
}

// (a) UDP 会话和 TCP 会话一样记到出口的负载里：以前不记，「按负载」「自动」和「按访客固定」的上限
// 完全看不见 UDP，全去容量最大的那台。
func TestUDPSessionsAreCountedInExitLoad(t *testing.T) {
	resetFXPEndpointRegistry()
	const tunnelID, ruleID, key = 311, 312, "x3a-key"
	targetPort := startPrefixedUDPEcho(t, "T")
	portA, _ := startUDPDirectExit(t, "127.0.0.1", tunnelID, ruleID, key, targetPort)
	portB, _ := startUDPDirectExit(t, "127.0.0.2", tunnelID, ruleID, key, targetPort)
	// 两台出口用不同的环回地址，负载各记各的。
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.2", Port: portB, UDPPort: portB, Key: key}},
		exitEndpoint{Host: "127.0.0.1", Port: portA, UDPPort: portA, Key: key},
		"least_load",
	)
	cfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: key,
		ExitHost: "127.0.0.1", ExitPort: portA, UDPExitPort: portA, TargetIP: "127.0.0.1", TargetPort: targetPort}
	entry := startUDPDirectEntry(t, cfg, selector)
	const sessions = 6
	clients := make([]*net.UDPConn, sessions)
	for i := range clients {
		client, err := net.DialUDP("udp", nil, entry)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		clients[i] = client
		if reply, ok := udpAsk(t, client, "ping", 2*time.Second); !ok || reply != "T:ping" {
			t.Fatalf("第 %d 条会话没通：%q", i+1, reply)
		}
	}
	active := selector.loads[0].active.Load() + selector.loads[1].active.Load()
	if active != sessions {
		t.Fatalf("%d 条 UDP 会话应该记成 %d 个活动连接，实际 %d", sessions, sessions, active)
	}
	if a, b := selector.loads[0].active.Load(), selector.loads[1].active.Load(); a != sessions/2 || b != sessions/2 {
		t.Fatalf("两台一样大，「按负载」应该各分一半：%d / %d", a, b)
	}
	if selector.loads[0].bytes.Load()+selector.loads[1].bytes.Load() <= 0 {
		// 每秒采样会把字节数清零折进 rate，两个都看。
		rate := selector.loads[0].snapshot(time.Now()).rate + selector.loads[1].snapshot(time.Now()).rate
		if rate <= 0 {
			t.Fatal("UDP 的流量没有记到出口的负载里")
		}
	}
}

// (d) 会话建好之后出口被判成连不上：以前这条会话终身钉在它上面。现在访客的下一个包就换到别的出口
// （访客这边的套接字不变）。
func TestUDPSessionMovesOffAnExitThatBecomesUnhealthy(t *testing.T) {
	resetFXPEndpointRegistry()
	const tunnelID, ruleID, key = 321, 322, "x3d-key"
	portA, stopA := startUDPDirectExit(t, "127.0.0.1", tunnelID, ruleID, key, startPrefixedUDPEcho(t, "A"))
	portB, _ := startUDPDirectExit(t, "127.0.0.1", tunnelID, ruleID, key, startPrefixedUDPEcho(t, "B"))
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: portB, UDPPort: portB, Key: key}},
		exitEndpoint{Host: "127.0.0.1", Port: portA, UDPPort: portA, Key: key},
		"fallback",
	)
	cfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: key,
		ExitHost: "127.0.0.1", ExitPort: portA, UDPExitPort: portA, TargetIP: "127.0.0.1", TargetPort: 9}
	entry := startUDPDirectEntry(t, cfg, selector)
	client, err := net.DialUDP("udp", nil, entry)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if reply, ok := udpAsk(t, client, "one", 2*time.Second); !ok || reply != "A:one" {
		t.Fatalf("主备的第一条会话应该走主出口：%q", reply)
	}
	// 主出口没了，探测把它判成连不上。
	stopA()
	selector.markFailure(0, errTestEndpointDown)
	deadline := time.Now().Add(3 * time.Second)
	for {
		reply, ok := udpAsk(t, client, "two", 500*time.Millisecond)
		if ok && reply == "B:two" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("出口被判成连不上之后，同一个访客的包应该换到备用出口（最后收到 %q ok=%v）", reply, ok)
		}
	}
	// 旧会话关了，负载也跟着挪走。
	if a, b := selector.loads[0].active.Load(), selector.loads[1].active.Load(); a+b != 1 {
		t.Fatalf("换出口之后应该只剩 1 条活动会话：%d / %d", a, b)
	}
}

// (c) 只有 UDP 的规则也有探测盯着出口：以前出口机没了入口永远不知道（没有 TCP 规则替它判坏）。
func TestUDPOnlyRuleDetectsADeadExit(t *testing.T) {
	if testing.Short() {
		t.Skip("要等真实时间")
	}
	resetFXPEndpointRegistry()
	const tunnelID, ruleID, key = 331, 332, "x3c-key"
	targetPort := startPrefixedUDPEcho(t, "T")
	ports := make([]int, 2)
	dones := make([]chan struct{}, 2)
	for i := range ports {
		ports[i] = freeTCPUDPPort(t)
		dones[i] = make(chan struct{})
		port, done := ports[i], dones[i]
		go func() {
			_ = runExit(done, config{Role: "exit", TunnelID: tunnelID, ListenPort: port, Protocol: "udp", Key: key,
				UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort}}})
		}()
	}
	defer close(dones[1])
	entryPort := freeTCPUDPPort(t)
	entryDone := make(chan struct{})
	defer close(entryDone)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: tunnelID, RuleID: ruleID, ListenPort: entryPort, Protocol: "udp",
			ExitHost: "127.0.0.1", ExitPort: ports[0], UDPExitPort: ports[0], ExitStrategy: "fallback",
			Exits: []exitEndpoint{
				{Host: "127.0.0.1", Port: ports[0], UDPPort: ports[0], Key: key},
				{Host: "127.0.0.1", Port: ports[1], UDPPort: ports[1], Key: key},
			},
			TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key,
		})
	}()
	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: entryPort})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if reply, ok := udpAsk(t, client, "hi", 300*time.Millisecond); ok && reply == "T:hi" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("UDP 规则没通")
		}
	}
	// 让探测先认识这台出口（它会回 UDP 探活包）。
	time.Sleep(2500 * time.Millisecond)
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: ports[0], Key: key})
	if !state.isHealthy() {
		t.Fatal("出口好好的，不该被判成连不上")
	}
	close(dones[0])
	killed := time.Now()
	for state.isHealthy() {
		if time.Since(killed) > 15*time.Second {
			t.Fatal("只有 UDP 的规则：出口没了 15 秒还没被发现")
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Logf("出口没了 %v 后被判成连不上", time.Since(killed).Round(100*time.Millisecond))
	// 判坏之后访客的包换到另一台。
	deadline = time.Now().Add(3 * time.Second)
	for {
		if reply, ok := udpAsk(t, client, "again", 500*time.Millisecond); ok && reply == "T:again" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("出口被判坏之后，访客的包应该换到另一台出口")
		}
	}
}

// (e) 中转上的「按访客固定」：以前拿到的键是会话号（每条会话随机），同一个访客的两条会话各去各的出口。
// 现在入口在会话的第一个数据包之前把访客的 IP 告诉中转，中转按它挑，并接着往下一跳传。
func TestRelayUDPIPHashUsesTheClientAddress(t *testing.T) {
	resetFXPEndpointRegistry()
	const tunnelID, ruleID = 341, 342
	const entryKey, relayKey = "x3e-entry-key", "x3e-relay-key"
	type seen struct {
		exit       int
		packetType byte
		sessionID  uint64
		client     string
	}
	var mu sync.Mutex
	var packets []seen
	exits := make([]exitEndpoint, 2)
	for i := range exits {
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		port := conn.LocalAddr().(*net.UDPAddr).Port
		exits[i] = exitEndpoint{Host: "127.0.0.1", Port: port, UDPPort: port, Key: relayKey}
		index := i
		go func() {
			buf := make([]byte, 65535)
			for {
				n, _, err := conn.ReadFromUDPAddrPort(buf)
				if err != nil {
					return
				}
				sessionID, ok := fxpUDPSessionID(buf[:n])
				if !ok {
					continue
				}
				item := seen{exit: index, packetType: buf[5], sessionID: sessionID}
				if item.packetType == 5 {
					if packet, err := openFXPUDPPacket(buf[:n], tunnelID, relayKey); err == nil {
						item.client = net.IP(packet.payload).String()
					}
				}
				mu.Lock()
				packets = append(packets, item)
				mu.Unlock()
			}
		}()
	}
	relayConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	relayPort := relayConn.LocalAddr().(*net.UDPAddr).Port
	relayCfg := config{Role: "relay", TunnelID: tunnelID, Protocol: "udp", Key: entryKey, RelayKey: relayKey,
		RelayExitHost: "127.0.0.1", RelayExitPort: exits[0].Port, UDPRelayExitPort: exits[0].Port, ExitStrategy: "ip_hash"}
	relaySelector := newExitEndpointSelector(exits, exits[0], "ip_hash")
	relayDone := make(chan struct{})
	go func() {
		_ = serveRelayUDPDirect(relayConn, relayCfg, relaySelector)
		close(relayDone)
	}()
	defer func() {
		_ = relayConn.Close()
		<-relayDone
	}()
	entrySelector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: relayPort, UDPPort: relayPort, Key: entryKey}, "")
	entryCfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: entryKey,
		ExitHost: "127.0.0.1", ExitPort: relayPort, UDPExitPort: relayPort, TargetIP: "127.0.0.1", TargetPort: 9}
	entry := startUDPDirectEntry(t, entryCfg, entrySelector)
	// 同一个访客（127.0.0.1）的两条会话。
	for i := 0; i < 2; i++ {
		client, err := net.DialUDP("udp", nil, entry)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		for n := 0; n < 3; n++ {
			if _, err := client.Write([]byte("data")); err != nil {
				t.Fatal(err)
			}
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		sessions := map[uint64]int{}
		hints := map[uint64]string{}
		for _, item := range packets {
			switch item.packetType {
			case fxpUDPTypeData:
				sessions[item.sessionID] = item.exit
			case 5:
				hints[item.sessionID] = item.client
			}
		}
		mu.Unlock()
		if len(sessions) == 2 && len(hints) == 2 {
			first := -1
			for sessionID, exit := range sessions {
				if first < 0 {
					first = exit
				}
				if exit != first {
					t.Fatalf("同一个访客的两条 UDP 会话被中转分到了不同出口：%v", sessions)
				}
				if !strings.HasPrefix(hints[sessionID], "127.0.0.1") {
					t.Fatalf("中转往下一跳传的访客地址不对：%v", hints)
				}
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("中转应该按访客的 IP 挑出口，并把访客地址接着往下传：会话 %v 访客地址 %v", sessions, hints)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// (d) 中转这一跳也一样：它替会话挑的出口被判成连不上，后面的包换到别的出口（会话号是入口定的，不变；
// 入口那边的会话、访客的套接字都不动）。
func TestRelayUDPSessionMovesOffAnExitThatBecomesUnhealthy(t *testing.T) {
	resetFXPEndpointRegistry()
	const tunnelID, ruleID = 381, 382
	const entryKey, relayKey = "x3d-relay-entry-key", "x3d-relay-exit-key"
	portA, _ := startUDPDirectExit(t, "127.0.0.1", tunnelID, ruleID, relayKey, startPrefixedUDPEcho(t, "A"))
	portB, _ := startUDPDirectExit(t, "127.0.0.1", tunnelID, ruleID, relayKey, startPrefixedUDPEcho(t, "B"))
	relayConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	relayPort := relayConn.LocalAddr().(*net.UDPAddr).Port
	relayCfg := config{Role: "relay", TunnelID: tunnelID, Protocol: "udp", Key: entryKey, RelayKey: relayKey,
		RelayExitHost: "127.0.0.1", RelayExitPort: portA, UDPRelayExitPort: portA, ExitStrategy: "fallback"}
	relaySelector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: portB, UDPPort: portB, Key: relayKey}},
		exitEndpoint{Host: "127.0.0.1", Port: portA, UDPPort: portA, Key: relayKey},
		"fallback",
	)
	relayDone := make(chan struct{})
	go func() {
		_ = serveRelayUDPDirect(relayConn, relayCfg, relaySelector)
		close(relayDone)
	}()
	defer func() {
		_ = relayConn.Close()
		<-relayDone
	}()
	entrySelector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: relayPort, UDPPort: relayPort, Key: entryKey}, "")
	entryCfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: entryKey,
		ExitHost: "127.0.0.1", ExitPort: relayPort, UDPExitPort: relayPort, TargetIP: "127.0.0.1", TargetPort: 9}
	entry := startUDPDirectEntry(t, entryCfg, entrySelector)
	client, err := net.DialUDP("udp", nil, entry)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if reply, ok := udpAsk(t, client, "one", 2*time.Second); !ok || reply != "A:one" {
		t.Fatalf("经中转的第一条会话应该走主出口：%q", reply)
	}
	relaySelector.markFailure(0, errTestEndpointDown)
	deadline := time.Now().Add(3 * time.Second)
	for {
		reply, ok := udpAsk(t, client, "two", 500*time.Millisecond)
		if ok && reply == "B:two" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("中转的出口被判成连不上之后，后面的包应该换到备用出口（最后收到 %q ok=%v）", reply, ok)
		}
	}
}
