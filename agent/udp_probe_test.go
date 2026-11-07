package main

import (
	"net"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// stubUDPProbeUnknown 让 UDP 端口探测永远「说不准」：用例只想看退回 ping 之后的行为时用。
func stubUDPProbeUnknown(t testing.TB) {
	t.Helper()
	old := udpProbeFn
	udpProbeFn = func(host string, port int, echo bool, timeout time.Duration) (int, udpProbeVerdict) {
		return 0, udpProbeUnknown
	}
	t.Cleanup(func() { udpProbeFn = old })
}

// udpCountingTarget 数收到几个包的 UDP 目标：核对探测报没被转发过来。
func udpCountingTarget(t testing.TB) (*net.UDPAddr, *atomic.Int32) {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	var count atomic.Int32
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := conn.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			count.Add(1)
			_, _ = conn.WriteToUDPAddrPort(buf[:n], addr)
		}
	}()
	return conn.LocalAddr().(*net.UDPAddr), &count
}

// closedUDPPort 占一个 UDP 端口再马上放掉：这个端口是关着的，对它发包内核会回 ICMP 端口不可达。
func closedUDPPort(t testing.TB) int {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	port := conn.LocalAddr().(*net.UDPAddr).Port
	_ = conn.Close()
	return port
}

func TestUDPProbePacketShape(t *testing.T) {
	packet := newUDPProbePacket(time.Now())
	if len(packet) != udpProbeLen || !isUDPProbe(packet) {
		t.Fatalf("探测报应当是 24 字节、以魔数开头：%x", packet)
	}
	if isUDPProbe(packet[:23]) || isUDPProbe(append(packet, 0)) {
		t.Fatal("长度不对的不算探测报 —— 业务包里恰好带魔数前缀也不能被当成探测吞掉")
	}
	other := append([]byte("NEXUDPP2"), packet[8:]...)
	if isUDPProbe(other) {
		t.Fatal("魔数不对的不算探测报")
	}
}

func TestUDPEchoLimiterIsPerSourceAddress(t *testing.T) {
	var limiter udpEchoLimiter
	now := time.Unix(1_700_000_000, 0)
	a := netip.MustParseAddr("198.51.100.1")
	b := netip.MustParseAddr("198.51.100.2")
	allowed := 0
	for i := 0; i < udpProbeEchoBurst+5; i++ {
		if limiter.allow(a, now) {
			allowed++
		}
	}
	if allowed != udpProbeEchoBurst {
		t.Fatalf("同一来源一瞬间只该回 %d 个，回了 %d 个", udpProbeEchoBurst, allowed)
	}
	if !limiter.allow(b, now) {
		t.Fatal("别的来源不该被 a 的额度连累")
	}
	if limiter.allow(a, now.Add(10*time.Millisecond)) {
		t.Fatal("额度用完 10 毫秒后不该就补回来一个")
	}
	if !limiter.allow(a, now.Add(time.Second)) {
		t.Fatal("一秒后应当补回额度")
	}
}

/*
协议守护的 UDP 监听收到探测报：原样回给发送方、不转给目标；普通包照样转。
两条路径（批量 / 逐包）都要核：限了速的规则走逐包路径。
*/
func TestProtocolGuardUDPAnswersProbeWithoutForwarding(t *testing.T) {
	for _, mode := range []struct {
		name string
		rule func(*guardRule)
	}{{"batch", nil}, {"perPacket", func(rule *guardRule) { rule.LimitIn = 200 << 20; rule.LimitOut = 200 << 20 }}} {
		t.Run(mode.name, func(t *testing.T) {
			target, received := udpCountingTarget(t)
			addr := startGuardUDPRelayForTest(t, 7001, target, mode.rule)
			host, portText, _ := net.SplitHostPort(addr)
			port, _ := strconv.Atoi(portText)
			latency, verdict := udpProbe(host, port, true, 2*time.Second)
			if verdict != udpProbeUp || latency < 1 {
				t.Fatalf("对着守护的 UDP 监听发回声探测报应当收到回包（%d, %v）", latency, verdict)
			}
			time.Sleep(50 * time.Millisecond)
			if got := received.Load(); got != 0 {
				t.Fatalf("探测报不该被转给目标，目标却收到了 %d 个包", got)
			}
			client, err := net.Dial("udp", addr)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			if got := failoverUDPExchange(t, client, "hello"); got != "hello" {
				t.Fatalf("普通包照样该转到目标并回来，拿到 %q", got)
			}
			if got := received.Load(); got != 1 {
				t.Fatalf("目标应当收到 1 个普通包，实际 %d", got)
			}
		})
	}
}

// 线路组调度器的 UDP 监听同样回探测报、不转发。
func TestFailoverUDPListenerAnswersProbeWithoutForwarding(t *testing.T) {
	failoverUDPTestSetup(t)
	target, received := udpCountingTarget(t)
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: target.Port}, {TargetIP: "127.0.0.1", TargetPort: target.Port}}
	_, addr := startUDPFailoverForTest(t, 950201, 65201, spec)
	host, portText, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portText)
	if _, verdict := udpProbe(host, port, true, 2*time.Second); verdict != udpProbeUp {
		t.Fatalf("对着调度器的 UDP 监听发回声探测报应当收到回包（%v）", verdict)
	}
	time.Sleep(50 * time.Millisecond)
	if got := received.Load(); got != 0 {
		t.Fatalf("探测报不该被转给路径，目标却收到了 %d 个包", got)
	}
	client, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if got := failoverUDPExchange(t, client, "data"); got != "data" {
		t.Fatalf("普通包照样该转，拿到 %q", got)
	}
}

// 同一来源一秒内最多回 20 个：拿不到更多回包，也就当不了反射器（放大倍数本来就是 1）。
func TestProtocolGuardUDPProbeRepliesAreRateLimited(t *testing.T) {
	target, _ := udpCountingTarget(t)
	addr := startGuardUDPRelayForTest(t, 7002, target, nil)
	client, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	const sent = udpProbeEchoBurst * 3
	started := time.Now()
	for i := 0; i < sent; i++ {
		if _, err := client.Write(newUDPProbePacket(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	// 发包期间令牌照常补（每秒 20 个）：机器慢、发得久，就多给那几个。
	allowed := udpProbeEchoBurst + int(time.Since(started).Seconds()*udpProbeEchoRatePerSecond) + 1
	replies := 0
	buf := make([]byte, 2048)
	for {
		_ = client.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		if _, err := client.Read(buf); err != nil {
			break
		}
		replies++
	}
	if replies == 0 || replies > allowed || replies >= sent {
		t.Fatalf("一瞬间发 %d 个探测报，该回 1–%d 个，回了 %d 个", sent, allowed, replies)
	}
}

// 来源表有上限：满了新来源不回、老来源照回；也不在每个包上扫一遍整张表，一分钟清一次久没动静的。
func TestUDPEchoLimiterBoundsSources(t *testing.T) {
	var limiter udpEchoLimiter
	now := time.Unix(1_700_000_000, 0)
	first := netip.AddrFrom4([4]byte{10, 0, 0, 1})
	for i := 0; i < udpProbeEchoMaxSources; i++ {
		addr := netip.AddrFrom4([4]byte{10, byte(i >> 16), byte(i >> 8), byte(i)})
		if !limiter.allow(addr, now) {
			t.Fatalf("第 %d 个来源还没到上限就被拒了", i)
		}
	}
	stranger := netip.MustParseAddr("198.51.100.200")
	if limiter.allow(stranger, now.Add(time.Second)) {
		t.Fatal("来源表满了，新来源不该再回")
	}
	if !limiter.allow(first, now.Add(time.Second)) {
		t.Fatal("已经在表里的来源照样该回")
	}
	if !limiter.allow(stranger, now.Add(udpProbeEchoPruneAfter+2*time.Second)) {
		t.Fatal("一分钟没动静的来源清掉以后，新来源该能拿到回包")
	}
	if len(limiter.buckets) > 2 {
		t.Fatalf("清理后只该剩最近还在探的来源，还剩 %d 个", len(limiter.buckets))
	}
}

// 不是 Agent 的目标：端口关着时内核回 ICMP 端口不可达，连接态套接字读到 ECONNREFUSED —— 确定不通。
func TestUDPProbeDetectsClosedPort(t *testing.T) {
	port := closedUDPPort(t)
	_, verdict := udpProbe("127.0.0.1", port, false, time.Second)
	if verdict != udpProbeDown {
		t.Fatalf("关着的 UDP 端口应当判成确定不通，拿到 %v", verdict)
	}
	target, _ := udpCountingTarget(t)
	latency, verdict := udpProbe("127.0.0.1", target.Port, false, time.Second)
	if verdict != udpProbeUp || latency < 1 {
		t.Fatalf("回了包的端口应当判成通（%d, %v）", latency, verdict)
	}
}

// 没回包、也没 ICMP 的端口说不准：退回 ping，而不是判成不通。
func TestUDPProbeSilentPortIsUnknown(t *testing.T) {
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, verdict := udpProbe("127.0.0.1", conn.LocalAddr().(*net.UDPAddr).Port, false, 150*time.Millisecond)
	if verdict != udpProbeUnknown {
		t.Fatalf("开着但不回话的端口应当是说不准，拿到 %v", verdict)
	}
}

// 只转 UDP 的路径：端口关着 → 不通（以前 ping 主机通就算通）；说不准 → 退回 ping；填了探测地址照拨 TCP。
func TestFailoverProbeUDPUsesPortVerdictBeforePing(t *testing.T) {
	var mu sync.Mutex
	pinged := 0
	oldPing := failoverPingLatency
	failoverPingLatency = func(host string, timeout time.Duration, count int) (int, bool, string) {
		mu.Lock()
		pinged++
		mu.Unlock()
		return 9, true, ""
	}
	t.Cleanup(func() { failoverPingLatency = oldPing })

	closed := failoverTarget{TargetIP: "127.0.0.1", TargetPort: closedUDPPort(t)}
	if latency, ok := failoverProbeTarget("udp", closed); ok || latency != 0 {
		t.Fatalf("UDP 端口关着的路径应当判成不通（%d, %v），不能靠 ping 主机通就算通", latency, ok)
	}
	if pinged != 0 {
		t.Fatal("端口确定不通时不该再去 ping")
	}
	target, _ := udpCountingTarget(t)
	if latency, ok := failoverProbeTarget("udp", failoverTarget{TargetIP: "127.0.0.1", TargetPort: target.Port, ProbeUdpEcho: true}); !ok || latency < 1 {
		t.Fatalf("回了包的路径应当判成通并带上耗时（%d, %v）", latency, ok)
	}
	silent, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	old := udpProbeFn
	udpProbeFn = func(host string, port int, echo bool, timeout time.Duration) (int, udpProbeVerdict) {
		return udpProbe(host, port, echo, 100*time.Millisecond)
	}
	t.Cleanup(func() { udpProbeFn = old })
	if latency, ok := failoverProbeTarget("udp", failoverTarget{TargetIP: "127.0.0.1", TargetPort: silent.LocalAddr().(*net.UDPAddr).Port}); !ok || latency != 9 {
		t.Fatalf("不回话的端口说不准，应当退回 ping（%d, %v）", latency, ok)
	}
	if pinged != 1 {
		t.Fatalf("说不准时应当 ping 一次，实际 %d 次", pinged)
	}
}

func TestFailoverSignatureCoversProbeUdpEcho(t *testing.T) {
	base := failoverSpec{
		ListenPort: 1234, BindAddress: "127.0.0.1", Protocol: "udp", Strategy: "fallback",
		Targets: []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 53}},
	}
	echo := base
	echo.Targets = []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 53, ProbeUdpEcho: true}}
	if failoverSignature(base) == failoverSignature(echo) {
		t.Fatal("探法变了签名要变，不然在跑的代理不会换成回声探测")
	}
}
