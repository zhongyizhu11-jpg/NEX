package main

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// 会话键换成 netip.AddrPort 以后，「按访客固定」哈希用的字符串必须和以前
// (*net.UDPAddr).String() 一模一样，否则升级后同一来源会换路径。
func TestFailoverUDPSessionKeyMatchesLegacyString(t *testing.T) {
	cases := []*net.UDPAddr{
		{IP: net.IPv4(127, 0, 0, 1), Port: 40000},
		{IP: net.ParseIP("::ffff:198.51.100.7"), Port: 53},
		{IP: net.ParseIP("2001:db8::1"), Port: 443},
		{IP: net.ParseIP("fe80::1"), Port: 5353, Zone: "eth0"},
	}
	for _, legacy := range cases {
		key := failoverUDPSessionKey(legacy.AddrPort())
		if got, want := key.String(), legacy.String(); got != want {
			t.Fatalf("session key %q, legacy key %q", got, want)
		}
	}
	mapped := netip.MustParseAddrPort("[::ffff:10.0.0.1]:9")
	plain := netip.MustParseAddrPort("10.0.0.1:9")
	if failoverUDPSessionKey(mapped) != failoverUDPSessionKey(plain) {
		t.Fatal("IPv4-mapped and plain IPv4 sources must share one session")
	}
}

type deadlineCountingConn struct {
	net.Conn
	readDeadlines atomic.Int64
}

func (c *deadlineCountingConn) SetReadDeadline(t time.Time) error {
	c.readDeadlines.Add(1)
	return c.Conn.SetReadDeadline(t)
}

// 回包路径不再每个包都重设读超时：空闲窗口还剩一半以上时一次都不调。
func TestFailoverUDPReplyPathDoesNotRearmDeadlinePerPacket(t *testing.T) {
	failoverUDPTestSetup(t)
	echoPort := failoverUDPEcho(t, "E")
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: echoPort}, {TargetIP: "127.0.0.1", TargetPort: failoverUDPEcho(t, "F")}}
	proxy, _ := startUDPFailoverForTest(t, 950101, 65101, spec)

	client, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	raw, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: echoPort})
	if err != nil {
		t.Fatal(err)
	}
	upstream := &deadlineCountingConn{Conn: raw}
	key := failoverUDPSessionKey(client.LocalAddr().(*net.UDPAddr).AddrPort())
	session := &failoverUDPSession{key: key, client: net.UDPAddrFromAddrPort(key), upstream: upstream, index: 0}
	session.touch(time.Now())
	done := make(chan struct{})
	go func() {
		proxy.copyUDPToClient(session)
		close(done)
	}()

	const packets = 50
	buf := make([]byte, 128)
	for i := 0; i < packets; i++ {
		if _, err := upstream.Write([]byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
		_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, err := client.Read(buf)
		if err != nil {
			t.Fatalf("reply %d: %v", i, err)
		}
		if string(buf[:n]) != "E:"+string([]byte{byte(i)}) {
			t.Fatalf("reply %d = %q", i, buf[:n])
		}
	}
	if calls := upstream.readDeadlines.Load(); calls > 1 {
		t.Fatalf("reply path re-armed the read deadline %d times for %d packets", calls, packets)
	}
	_ = raw.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reply goroutine did not exit after the upstream closed")
	}
}

// ---- 中继正确性 / 吞吐的公共夹具（线路组和协议守护的 UDP 中继都用） ----

// udpPlainEcho 原样回显（不加前缀），好逐字节核对回包。两个协程一起收，免得回显本身成为瓶颈。
func udpPlainEcho(t testing.TB) *net.UDPAddr {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	_ = conn.SetReadBuffer(4 << 20)
	t.Cleanup(func() { _ = conn.Close() })
	for i := 0; i < 2; i++ {
		go func() {
			buf := make([]byte, 65535)
			for {
				n, addr, err := conn.ReadFromUDPAddrPort(buf)
				if err != nil {
					return
				}
				_, _ = conn.WriteToUDPAddrPort(buf[:n], addr)
			}
		}()
	}
	return conn.LocalAddr().(*net.UDPAddr)
}

// udpRelayPayload 给「第 client 个客户端的第 seq 个包」生成确定的内容，长度在 1 到 1400 字节之间轮转。
func udpRelayPayload(client int, seq int) []byte {
	size := 1 + (client*131+seq*7)%1400
	payload := make([]byte, size)
	state := uint32(client*1_000_003 + seq*7919 + 1)
	for i := range payload {
		state = state*1664525 + 1013904223
		payload[i] = byte(state >> 24)
	}
	return payload
}

/*
udpRelayExactness：clients 个假客户端各发 perClient 个大小不一的包经过中继到回显，核对每个回包
都回到了发它的那个客户端、内容逐字节一样。每个客户端最多 window 个包在途（回显和中继都在本机，
缓冲不会溢出，所以不该丢包），回包按发送顺序核对：错投给别的客户端或者内容串了都会在这里露馅。
*/
func udpRelayExactness(t testing.TB, relayAddr string, clients int, perClient int, window int) {
	t.Helper()
	relay, err := net.ResolveUDPAddr("udp", relayAddr)
	if err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, clients)
	for c := 0; c < clients; c++ {
		go func(client int) {
			errs <- udpRelayClientRun(relay, client, perClient, window)
		}(c)
	}
	for c := 0; c < clients; c++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}

func udpRelayClientRun(relay *net.UDPAddr, client int, perClient int, window int) error {
	conn, err := net.DialUDP("udp", nil, relay)
	if err != nil {
		return err
	}
	defer conn.Close()
	buf := make([]byte, 65535)
	// 回显夹具两个协程一起收，同一窗口里的回包可能乱序：每个回包要和本客户端在途的某一个
	// 包逐字节一样（同一窗口里的包长度各不相同，不会混）。投错客户端的包在这里对不上号，
	// 而真正的主人也收不到它，两头都会报错。
	outstanding := map[string]int{}
	sent, received := 0, 0
	for received < perClient {
		for sent < perClient && sent-received < window {
			payload := udpRelayPayload(client, sent)
			if _, err := conn.Write(payload); err != nil {
				return fmt.Errorf("client %d send %d: %w", client, sent, err)
			}
			outstanding[string(payload)]++
			sent++
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, err := conn.Read(buf)
		if err != nil {
			return fmt.Errorf("client %d reply %d (sent %d): %w", client, received, sent, err)
		}
		got := string(buf[:n])
		if outstanding[got] == 0 {
			return fmt.Errorf("client %d reply %d: %d bytes (prefix %x) match none of its %d outstanding packets", client, received, n, udpRelayHead(buf[:n]), sent-received)
		}
		outstanding[got]--
		if outstanding[got] == 0 {
			delete(outstanding, got)
		}
		received++
	}
	return nil
}

func udpRelayHead(b []byte) []byte {
	if len(b) > 8 {
		return b[:8]
	}
	return b
}

// 50 个客户端、每个 200 个 1～1400 字节的包（共 1 万个）经过线路组 UDP 中继：每个回包都要回到
// 发它的客户端、逐字节一样。
func TestFailoverUDPRelayDeliversExactBytesToRightClient(t *testing.T) {
	failoverUDPTestSetup(t)
	echo := udpPlainEcho(t)
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: echo.Port}, {TargetIP: "127.0.0.1", TargetPort: echo.Port}}
	_, addr := startUDPFailoverForTest(t, 950102, 65102, spec)
	udpRelayExactness(t, addr, 50, 200, 16)
}

// 调度器监听在 IPv6 / 双栈地址上时回包要写成 IPv6 形式（IPv4 访客是 ::ffff:a.b.c.d，会话键
// 按老规矩还原成 IPv4，回写时再映射回去）。
func TestFailoverUDPRelayOnIPv6AndDualStackListeners(t *testing.T) {
	if probe, err := net.ListenPacket("udp", "[::1]:0"); err != nil {
		t.Skipf("no IPv6 loopback: %v", err)
	} else {
		_ = probe.Close()
	}
	failoverUDPTestSetup(t)
	echo := udpPlainEcho(t)
	for _, tc := range []struct {
		name, bind, client string
		ruleID, source     int
	}{
		{"ipv6", "::1", "::1", 950105, 65105},
		{"dualstack-v4-client", "::", "127.0.0.1", 950106, 65106},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := failoverTestSpec(failoverTestDualPort(t))
			spec.Protocol = "udp"
			spec.BindAddress = tc.bind
			spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: echo.Port}, {TargetIP: "127.0.0.1", TargetPort: echo.Port}}
			startUDPFailoverForTest(t, tc.ruleID, tc.source, spec)
			udpRelayExactness(t, net.JoinHostPort(tc.client, strconv.Itoa(spec.ListenPort)), 8, 50, 8)
		})
	}
}

/*
benchmarkUDPRelay：clients 个客户端各自保持 window 个包在途，一共打 b.N 个往返；报的「relayed/s」
是中继每秒经手的数据报数（一个往返中继收发各一次，算两个）。回显和客户端都在本机，所以这是
整条链路的吞吐，不只是中继自己的；对比 batch / perPacket 两个子项看中继本身省了多少。
*/
func benchmarkUDPRelay(b *testing.B, relayAddr string) {
	benchmarkUDPRelayWith(b, relayAddr, 16, 64)
}

// 单个客户端一问一答（窗口 1）：量的是一个孤零零的包的往返时延，批量路径不许为了攒包拖慢它。
func benchmarkUDPRelayRTT(b *testing.B, relayAddr string) {
	benchmarkUDPRelayWith(b, relayAddr, 1, 1)
}

func benchmarkUDPRelayWith(b *testing.B, relayAddr string, clients int, window int) {
	relay, err := net.ResolveUDPAddr("udp", relayAddr)
	if err != nil {
		b.Fatal(err)
	}
	conns := make([]*net.UDPConn, clients)
	for i := range conns {
		conn, err := net.DialUDP("udp", nil, relay)
		if err != nil {
			b.Fatal(err)
		}
		defer conn.Close()
		conns[i] = conn
	}
	payload := make([]byte, 512)
	// 先暖一下：每个客户端的会话都建好、路径都挑好再计时。
	for _, conn := range conns {
		if _, err := conn.Write(payload); err != nil {
			b.Fatal(err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, err := conn.Read(payload); err != nil {
			b.Fatalf("warm-up reply: %v", err)
		}
	}
	perClient := b.N / clients
	if perClient == 0 {
		perClient = 1
	}
	batchCalls, batchPackets := udpBatchRecvCalls.Load(), udpBatchRecvPackets.Load()
	cpuStart := processCPUTime()
	b.ResetTimer()
	start := time.Now()
	errs := make(chan error, clients)
	for _, conn := range conns {
		go func(conn *net.UDPConn) {
			buf := make([]byte, 2048)
			sent, received := 0, 0
			for received < perClient {
				for sent < perClient && sent-received < window {
					if _, err := conn.Write(payload); err != nil {
						errs <- err
						return
					}
					sent++
				}
				_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				if _, err := conn.Read(buf); err != nil {
					errs <- fmt.Errorf("reply %d of %d: %w", received, perClient, err)
					return
				}
				received++
			}
			errs <- nil
		}(conn)
	}
	for range conns {
		if err := <-errs; err != nil {
			b.Fatal(err)
		}
	}
	elapsed := time.Since(start)
	cpu := processCPUTime() - cpuStart
	b.StopTimer()
	total := float64(perClient * clients)
	b.ReportMetric(2*total/elapsed.Seconds(), "relayed/s")
	// 整个进程（夹具 + 中继）每个经手的数据报花的 CPU；减去 HarnessDirect 的就是中继自己的。
	if cpu > 0 {
		b.ReportMetric(float64(cpu.Nanoseconds())/(2*total), "cpu-ns/pkt")
	}
	if calls := udpBatchRecvCalls.Load() - batchCalls; calls > 0 {
		b.ReportMetric(float64(udpBatchRecvPackets.Load()-batchPackets)/float64(calls), "pkts/recv")
	}
}

// 没有中继、客户端直连回显时同一套夹具能跑多快、每个包花多少 CPU：这是夹具（客户端 + 回显，
// 都是逐包收发）本身的开销，中继子项的数字减去它才是中继自己的。
func BenchmarkUDPRelayHarnessDirect(b *testing.B) {
	echo := udpPlainEcho(b)
	benchmarkUDPRelay(b, echo.String())
}

// 线路组 UDP 中继在本机回环上的吞吐：batch 子项走 recvmmsg / sendmmsg，perPacket 子项关掉批量，
// 走逐包路径（也就是非 Linux 的路径），两个一起跑就是改前改后的对比。
func BenchmarkFailoverUDPRelayLoopback(b *testing.B) {
	for _, mode := range []struct {
		name  string
		batch bool
		run   func(*testing.B, string)
	}{{"batch", true, benchmarkUDPRelay}, {"perPacket", false, benchmarkUDPRelay}, {"batch-rtt", true, benchmarkUDPRelayRTT}, {"perPacket-rtt", false, benchmarkUDPRelayRTT}} {
		b.Run(mode.name, func(b *testing.B) {
			old := udpBatchEnabled
			udpBatchEnabled = mode.batch
			defer func() { udpBatchEnabled = old }()
			failoverUDPTestSetup(b)
			echo := udpPlainEcho(b)
			spec := failoverTestSpec(failoverTestDualPort(b))
			spec.Protocol = "udp"
			spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: echo.Port}, {TargetIP: "127.0.0.1", TargetPort: echo.Port}}
			_, addr := startUDPFailoverForTest(b, 950103, 65103, spec)
			mode.run(b, addr)
		})
	}
}
