package main

import (
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// 一个同时空着 TCP 和 UDP 的端口（both 规格两个都要绑）。
func failoverTestDualPort(t testing.TB) int {
	t.Helper()
	for attempt := 0; attempt < 20; attempt++ {
		port := failoverTestPort(t)
		udp, err := net.ListenPacket("udp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			continue
		}
		_ = udp.Close()
		return port
	}
	t.Fatal("找不到一个 TCP 和 UDP 都空着的端口")
	return 0
}

// UDP 回显：回包前面带上自己的名字，好认出包走的是哪条路径。
func failoverUDPEcho(t *testing.T, tag string) int {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := conn.ReadFrom(buf)
			if err != nil {
				return
			}
			reply := append([]byte(tag+":"), buf[:n]...)
			_, _ = conn.WriteTo(reply, addr)
		}
	}()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

func failoverUDPExchange(t *testing.T, client net.Conn, payload string) string {
	t.Helper()
	if _, err := client.Write([]byte(payload)); err != nil {
		t.Fatalf("发 UDP: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 2048)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("收 UDP 回包: %v", err)
	}
	return string(buf[:n])
}

func failoverUDPTestSetup(t testing.TB) {
	t.Helper()
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	oldPing := failoverPingLatency
	failoverPingLatency = func(host string, timeout time.Duration, count int) (int, bool, string) {
		return 1, true, ""
	}
	t.Cleanup(func() {
		persistentFailoverDir = oldPersistentDir
		failoverPingLatency = oldPing
	})
}

func startUDPFailoverForTest(t testing.TB, ruleID int, sourcePort int, spec failoverSpec) (*failoverProxy, string) {
	t.Helper()
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("代理没起来")
	}
	proxy := currentFailoverProxy(ruleID, sourcePort)
	if proxy == nil {
		t.Fatal("代理没登记")
	}
	return proxy, net.JoinHostPort("127.0.0.1", strconv.Itoa(spec.ListenPort))
}

func TestFailoverUDPSessionStaysOnItsPath(t *testing.T) {
	failoverUDPTestSetup(t)
	portA := failoverUDPEcho(t, "A")
	portB := failoverUDPEcho(t, "B")
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: portA}, {TargetIP: "127.0.0.1", TargetPort: portB}}
	proxy, addr := startUDPFailoverForTest(t, 950001, 65001, spec)
	if proxy.ln != nil {
		t.Fatal("只转 UDP 的规格不该再开 TCP 监听")
	}

	first, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer first.Close()
	if got := failoverUDPExchange(t, first, "one"); got != "A:one" {
		t.Fatalf("主备模式第一个会话应当走当前那条（A），拿到 %q", got)
	}
	proxy.mu.RLock()
	sessions := proxy.connectionsLocked(0)
	proxy.mu.RUnlock()
	if sessions != 1 {
		t.Fatalf("UDP 会话应当算在路径 A 名下（记了 %d 个）", sessions)
	}

	// 平滑切换：已经在走的会话留在原路径，新会话走新路径。
	proxy.mu.Lock()
	proxy.setActiveLocked(1, "test")
	proxy.mu.Unlock()
	if got := failoverUDPExchange(t, first, "two"); got != "A:two" {
		t.Fatalf("平滑切换不该动已有的 UDP 会话，拿到 %q", got)
	}
	second, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer second.Close()
	if got := failoverUDPExchange(t, second, "three"); got != "B:three" {
		t.Fatalf("切换以后的新会话应当走 B，拿到 %q", got)
	}
	if count := proxy.udpSessionCount(); count != 2 {
		t.Fatalf("应当有两个会话，实际 %d 个", count)
	}
}

func TestFailoverUDPForceSwitchMovesSessions(t *testing.T) {
	failoverUDPTestSetup(t)
	portA := failoverUDPEcho(t, "A")
	portB := failoverUDPEcho(t, "B")
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.SwitchMode = "force"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: portA}, {TargetIP: "127.0.0.1", TargetPort: portB}}
	proxy, addr := startUDPFailoverForTest(t, 950002, 65002, spec)

	client, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	if got := failoverUDPExchange(t, client, "one"); got != "A:one" {
		t.Fatalf("拿到 %q", got)
	}
	proxy.mu.Lock()
	proxy.setActiveLocked(1, "test")
	proxy.mu.Unlock()
	// 强制切换把会话的上游关了：同一个来源的下一个包重新挑路径，走到 B。
	if got := failoverUDPExchange(t, client, "two"); got != "B:two" {
		t.Fatalf("强制切换以后同一个会话的下一个包应当走 B，拿到 %q", got)
	}
	proxy.mu.RLock()
	onA, onB := proxy.connectionsLocked(0), proxy.connectionsLocked(1)
	proxy.mu.RUnlock()
	if onA != 0 || onB != 1 {
		t.Fatalf("会话应当全部挪到 B（A=%d B=%d）", onA, onB)
	}
}

func TestFailoverUDPRoundRobinSpreadsSessions(t *testing.T) {
	failoverUDPTestSetup(t)
	portA := failoverUDPEcho(t, "A")
	portB := failoverUDPEcho(t, "B")
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Strategy = "round_robin"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: portA}, {TargetIP: "127.0.0.1", TargetPort: portB}}
	_, addr := startUDPFailoverForTest(t, 950003, 65003, spec)

	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		client, err := net.Dial("udp", addr)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer client.Close()
		reply := failoverUDPExchange(t, client, "x")
		seen[strings.SplitN(reply, ":", 2)[0]] = true
		// 同一个会话里的包不换路径。
		if again := failoverUDPExchange(t, client, "y"); strings.SplitN(again, ":", 2)[0] != strings.SplitN(reply, ":", 2)[0] {
			t.Fatalf("同一个会话换了路径：%q → %q", reply, again)
		}
	}
	if !seen["A"] || !seen["B"] {
		t.Fatalf("轮流模式下两个会话应当分到两条路径，实际 %v", seen)
	}
}

func TestFailoverBothListensOnTCPAndUDP(t *testing.T) {
	failoverUDPTestSetup(t)
	udpPort := failoverUDPEcho(t, "U")
	tcpTarget, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer tcpTarget.Close()
	go func() {
		for {
			conn, err := tcpTarget.Accept()
			if err != nil {
				return
			}
			_, _ = conn.Write([]byte("T"))
			_ = conn.Close()
		}
	}()
	tcpPort := tcpTarget.Addr().(*net.TCPAddr).Port
	if tcpPort != udpPort {
		// 两边端口不同：各起一个同端口的「另一半」没必要，这里直接让 UDP 回显监听在 TCP 目标的端口上。
		udp, err := net.ListenPacket("udp", net.JoinHostPort("127.0.0.1", strconv.Itoa(tcpPort)))
		if err != nil {
			t.Skipf("UDP %d 被占用: %v", tcpPort, err)
		}
		t.Cleanup(func() { _ = udp.Close() })
		go func() {
			buf := make([]byte, 2048)
			for {
				n, addr, err := udp.ReadFrom(buf)
				if err != nil {
					return
				}
				_, _ = udp.WriteTo(append([]byte("U:"), buf[:n]...), addr)
			}
		}()
	}
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "both"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: tcpPort}, {TargetIP: "127.0.0.1", TargetPort: tcpPort}}
	proxy, addr := startUDPFailoverForTest(t, 950004, 65004, spec)
	if proxy.ln == nil || proxy.udp == nil {
		t.Fatal("TCP+UDP 规格应当两个监听都开")
	}
	tcpClient, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("连 TCP: %v", err)
	}
	defer tcpClient.Close()
	_ = tcpClient.SetReadDeadline(time.Now().Add(2 * time.Second))
	got, _ := io.ReadAll(tcpClient)
	if string(got) != "T" {
		t.Fatalf("TCP 没转到目标，拿到 %q", got)
	}
	udpClient, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatalf("dial udp: %v", err)
	}
	defer udpClient.Close()
	if reply := failoverUDPExchange(t, udpClient, "ping"); reply != "U:ping" {
		t.Fatalf("UDP 没转到目标，拿到 %q", reply)
	}
}

func TestFailoverProtocolChangeRebindsSamePort(t *testing.T) {
	failoverUDPTestSetup(t)
	portA := failoverUDPEcho(t, "A")
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: portA}, {TargetIP: "127.0.0.1", TargetPort: portA}}
	first, addr := startUDPFailoverForTest(t, 950005, 65005, spec)
	if first.udp != nil {
		t.Fatal("TCP 规格不该开 UDP 监听")
	}
	udpSpec := spec
	udpSpec.Protocol = "udp"
	if !startFailoverProxy(950005, 65005, udpSpec, nil) {
		t.Fatal("同一个端口从 TCP 换成 UDP 失败")
	}
	second := currentFailoverProxy(950005, 65005)
	if second == first {
		t.Fatal("换协议应当换一个代理")
	}
	if !first.retired() {
		t.Fatal("旧代理没收掉")
	}
	if _, err := net.DialTimeout("tcp", addr, 500*time.Millisecond); err == nil {
		t.Fatal("换成只转 UDP 以后 TCP 监听还开着")
	}
	client, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	if got := failoverUDPExchange(t, client, "hi"); got != "A:hi" {
		t.Fatalf("拿到 %q", got)
	}
	if !strings.Contains(failoverSignature(udpSpec), "|udp|") {
		t.Fatal("协议要进签名，不然换协议不会重建")
	}
}

func TestFailoverUDPIdleSessionsAreReaped(t *testing.T) {
	failoverUDPTestSetup(t)
	portA := failoverUDPEcho(t, "A")
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: portA}, {TargetIP: "127.0.0.1", TargetPort: portA}}
	proxy, addr := startUDPFailoverForTest(t, 950006, 65006, spec)
	client, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	_ = failoverUDPExchange(t, client, "hi")
	if reaped := proxy.reapIdleUDPSessions(time.Now()); reaped != 0 {
		t.Fatalf("刚有包的会话不该回收（回收了 %d 个）", reaped)
	}
	if reaped := proxy.reapIdleUDPSessions(time.Now().Add(failoverUDPIdleTimeout + time.Second)); reaped != 1 {
		t.Fatalf("空闲够久的会话应当回收（回收了 %d 个）", reaped)
	}
	proxy.mu.RLock()
	tracked := proxy.connectionsLocked(0)
	proxy.mu.RUnlock()
	if tracked != 0 || proxy.udpSessionCount() != 0 {
		t.Fatalf("回收以后不该再算连接（连接 %d、会话 %d）", tracked, proxy.udpSessionCount())
	}
	// 回收以后同一个来源再来包：新开一个会话，照样通。
	if got := failoverUDPExchange(t, client, "again"); got != "A:again" {
		t.Fatalf("拿到 %q", got)
	}
}

func TestFailoverProbeFollowsProtocol(t *testing.T) {
	var mu sync.Mutex
	pinged := []string{}
	oldPing := failoverPingLatency
	failoverPingLatency = func(host string, timeout time.Duration, count int) (int, bool, string) {
		mu.Lock()
		pinged = append(pinged, host)
		mu.Unlock()
		return 7, true, ""
	}
	t.Cleanup(func() { failoverPingLatency = oldPing })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	tcpPort := listener.Addr().(*net.TCPAddr).Port

	plain := failoverTarget{TargetIP: "198.51.100.9", TargetPort: 5353}
	if latency, ok := failoverProbeTarget("udp", plain); !ok || latency != 7 {
		t.Fatalf("只转 UDP、没填探测地址的路径应当 ping 拨号主机（%d, %v）", latency, ok)
	}
	if len(pinged) != 1 || pinged[0] != "198.51.100.9" {
		t.Fatalf("ping 的对象不对：%v", pinged)
	}
	withProbe := failoverTarget{TargetIP: "198.51.100.9", TargetPort: 5353, ProbeIP: "127.0.0.1", ProbePort: tcpPort}
	if _, ok := failoverProbeTarget("udp", withProbe); !ok {
		t.Fatal("填了探测地址就按填的拨 TCP")
	}
	local := failoverTarget{TargetIP: "127.0.0.1", TargetPort: tcpPort}
	for _, protocol := range []string{"tcp", "both"} {
		if _, ok := failoverProbeTarget(protocol, local); !ok {
			t.Fatalf("%s 规格照旧拨 TCP", protocol)
		}
	}
	if len(pinged) != 1 {
		t.Fatalf("只有 UDP 且没填探测地址时才 ping（ping 了 %d 次）", len(pinged))
	}
}

// 记下连进来的每条连接收到的头几个字节。
type failoverRecordingTarget struct {
	listener net.Listener
	mu       sync.Mutex
	received []string
}

func newFailoverRecordingTarget(t *testing.T) *failoverRecordingTarget {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	target := &failoverRecordingTarget{listener: listener}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
				data, _ := io.ReadAll(conn)
				target.mu.Lock()
				target.received = append(target.received, string(data))
				target.mu.Unlock()
			}(conn)
		}
	}()
	return target
}

func (r *failoverRecordingTarget) port() int { return r.listener.Addr().(*net.TCPAddr).Port }

func (r *failoverRecordingTarget) waitFor(t *testing.T, count int) []string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		r.mu.Lock()
		got := append([]string(nil), r.received...)
		r.mu.Unlock()
		if len(got) >= count || time.Now().After(deadline) {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func sendThroughFailover(t *testing.T, addr string, payload string) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("连代理: %v", err)
	}
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatalf("写: %v", err)
	}
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.ReadAll(conn)
	_ = conn.Close()
}

// 两个访客地址，哈希到两条不同的路径上。
func failoverDistinctVisitors(t *testing.T) (string, string) {
	t.Helper()
	first := "203.0.113.7"
	for i := 1; i < 255; i++ {
		other := "198.51.100." + strconv.Itoa(i)
		if failoverHashIndex(other, 2) != failoverHashIndex(first, 2) {
			return first, other
		}
	}
	t.Fatal("找不到两个哈希到不同路径的地址")
	return "", ""
}

func TestIPHashReadsVisitorFromProxyHeader(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })
	for _, mode := range []string{"receive", "strip"} {
		t.Run(mode, func(t *testing.T) {
			targetA := newFailoverRecordingTarget(t)
			targetB := newFailoverRecordingTarget(t)
			spec := failoverTestSpec(failoverTestPort(t))
			spec.Strategy = "ip_hash"
			if mode == "receive" {
				spec.ProxyProtocolReceive = true
			} else {
				spec.ProxyProtocolStrip = true
			}
			spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: targetA.port()}, {TargetIP: "127.0.0.1", TargetPort: targetB.port()}}
			ruleID, sourcePort := 950010, 65010
			if mode == "strip" {
				ruleID, sourcePort = 950011, 65011
			}
			_, addr := startUDPFailoverForTest(t, ruleID, sourcePort, spec)
			first, second := failoverDistinctVisitors(t)
			headerFirst := "PROXY TCP4 " + first + " 10.0.0.1 40000 443\r\n"
			headerSecond := "PROXY TCP4 " + second + " 10.0.0.1 40001 443\r\n"
			sendThroughFailover(t, addr, headerFirst+"hello")
			sendThroughFailover(t, addr, headerSecond+"world")
			sendThroughFailover(t, addr, headerFirst+"again")

			targets := []*failoverRecordingTarget{targetA, targetB}
			firstTarget := targets[failoverHashIndex(first, 2)]
			secondTarget := targets[failoverHashIndex(second, 2)]
			gotFirst := firstTarget.waitFor(t, 2)
			gotSecond := secondTarget.waitFor(t, 1)
			wantFirst := []string{headerFirst + "hello", headerFirst + "again"}
			wantSecond := []string{headerSecond + "world"}
			if mode == "strip" {
				wantFirst = []string{"hello", "again"}
				wantSecond = []string{"world"}
			}
			if strings.Join(gotFirst, ",") != strings.Join(wantFirst, ",") {
				t.Fatalf("访客 %s 应当两次都落在同一条路径上、收到 %q，实际 %q", first, wantFirst, gotFirst)
			}
			if strings.Join(gotSecond, ",") != strings.Join(wantSecond, ",") {
				t.Fatalf("访客 %s 应当落在另一条路径上、收到 %q，实际 %q", second, wantSecond, gotSecond)
			}
		})
	}
}

func TestPassThroughWithoutIPHashDoesNotParseHeader(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })
	target := newFailoverRecordingTarget(t)
	spec := failoverTestSpec(failoverTestPort(t))
	spec.ProxyProtocolReceive = true
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: target.port()}, {TargetIP: "127.0.0.1", TargetPort: target.port()}}
	_, addr := startUDPFailoverForTest(t, 950012, 65012, spec)
	payload := "PROXY TCP4 203.0.113.7 10.0.0.1 40000 443\r\nhello"
	sendThroughFailover(t, addr, payload)
	got := target.waitFor(t, 1)
	if len(got) != 1 || got[0] != payload {
		t.Fatalf("不按访客分的时候字节应当原样转过去，实际 %q", got)
	}
}

func TestReadFailoverProxyHeaderWithoutHeaderKeepsBytes(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	go func() {
		_, _ = client.Write([]byte("GET / HTTP/1.1\r\n"))
	}()
	raw, headerLen, source := readFailoverProxyHeader(server, time.Second)
	if headerLen != 0 || source != "" || string(raw) != "GET / HTTP/1.1\r\n" {
		t.Fatalf("开头不是 PROXY 头时应当原样留着（raw=%q headerLen=%d source=%q）", raw, headerLen, source)
	}
}

// 换规格时连接表会搬到新下标上；按旧下标删也要删得掉，不然连接数只涨不跌。
func TestUntrackFindsConnectionAfterRespec(t *testing.T) {
	spec := failoverTestSpec(9)
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: 1001}, {TargetIP: "127.0.0.1", TargetPort: 1002}}
	p := &failoverProxy{spec: spec, done: make(chan struct{})}
	p.ensureHealthStateLocked()
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	p.trackConn(0, server)
	respec := spec
	respec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: 1000}, {TargetIP: "127.0.0.1", TargetPort: 1001}, {TargetIP: "127.0.0.1", TargetPort: 1002}}
	p.mu.Lock()
	p.rebuildForSpecLocked(respec, time.Now())
	moved := p.connectionsLocked(1)
	p.mu.Unlock()
	if moved != 1 {
		t.Fatalf("连接应当跟着路径搬到下标 1（实际 %d）", moved)
	}
	p.untrackConn(0, server)
	p.mu.RLock()
	left := p.connectionsLocked(0) + p.connectionsLocked(1) + p.connectionsLocked(2)
	p.mu.RUnlock()
	if left != 0 {
		t.Fatalf("按旧下标删也要删掉（还剩 %d 条）", left)
	}
}
