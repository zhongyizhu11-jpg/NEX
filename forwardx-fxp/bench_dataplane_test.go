package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/*
数据面基准：FXP 隧道（入口 → 出口，两端都在本进程里、走真实的握手和加密）在本机
回环上的表现，指标和 agent/bench_dataplane_test.go 的同名基准一致：

	direct      不经隧道，客户端直连目标，夹具本身的开销
	aes         帧加密写死 AES-256-GCM
	chacha      帧加密写死 ChaCha20-Poly1305
	v2plain     两端都是 V2（WireGuard 里），协商成明文帧，只剩分帧本身
	udp         UDP 直连隧道（udp_direct.go）

	Gbps / cpu-ms/GB / allocs/GB   单向灌数据
	p50-us / p99-us                64 字节一问一答
	pps / loss-%                   UDP 固定速率 1200 字节

scripts/bench/dataplane.sh 用 -cpu 1,4 跑。
*/

const (
	dpBulkChunk   = 1 << 20
	dpRTTSize     = 64
	dpUDPPayload  = 1200
	dpReadBufSize = 256 << 10
	dpKey         = "dataplane-bench-key"
)

func dpFreePort(tb testing.TB) int {
	tb.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func dpWaitTCPPort(tb testing.TB, port int) {
	tb.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	tb.Fatalf("port %d did not open", port)
}

// dpTCPTarget 起一个 TCP 目标。echo 为真时原样回显，否则只收不回，读到 EOF 就关。
func dpTCPTarget(tb testing.TB, echo bool) *net.TCPAddr {
	tb.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				buf := make([]byte, dpReadBufSize)
				for {
					n, err := conn.Read(buf)
					if n > 0 && echo {
						if _, werr := conn.Write(buf[:n]); werr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr)
}

// dpStartFXPTCP 起一对入口 + 出口，出口的目标是 target，返回入口地址。mutate 同时改两端的配置。
func dpStartFXPTCP(tb testing.TB, target *net.TCPAddr, mutate func(*config)) string {
	tb.Helper()
	exitPort := dpFreePort(tb)
	entryPort := dpFreePort(tb)
	exitCfg := config{
		Role: "exit", TunnelID: 17, ListenPort: exitPort, Protocol: "tcp", Key: dpKey,
		StreamTargets: loopbackStreamTargets(5, target.Port),
	}
	entryCfg := config{
		Role: "entry", TunnelID: 17, RuleID: 5, ListenPort: entryPort, Protocol: "tcp",
		ExitHost: "127.0.0.1", ExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: target.Port, Key: dpKey,
	}
	if mutate != nil {
		mutate(&exitCfg)
		mutate(&entryCfg)
	}
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	tb.Cleanup(func() { close(entryDone); close(exitDone) })
	go func() { _ = runExit(exitDone, exitCfg) }()
	dpWaitTCPPort(tb, exitPort)
	go func() { _ = runEntry(entryDone, entryCfg) }()
	dpWaitTCPPort(tb, entryPort)
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort))
}

type dpTCPPath struct {
	name  string
	start func(tb testing.TB, target *net.TCPAddr) string
}

func dpTCPPaths() []dpTCPPath {
	return []dpTCPPath{
		{"direct", func(_ testing.TB, target *net.TCPAddr) string { return target.String() }},
		{"aes", func(tb testing.TB, target *net.TCPAddr) string {
			return dpStartFXPTCP(tb, target, func(c *config) { c.AEAD = "aes" })
		}},
		{"chacha", func(tb testing.TB, target *net.TCPAddr) string {
			return dpStartFXPTCP(tb, target, func(c *config) { c.AEAD = "chacha" })
		}},
		{"v2plain", func(tb testing.TB, target *net.TCPAddr) string {
			return dpStartFXPTCP(tb, target, func(c *config) { c.TransportVersion = "v2" })
		}},
		// 关掉读 / 封帧写出分两段的流水线（copy_pipeline.go），走以前的串行路径：同一个二进制里对照。
		{"aes-serial", func(tb testing.TB, target *net.TCPAddr) string {
			old := fxpCopyPipelineEnabled
			fxpCopyPipelineEnabled = false
			tb.Cleanup(func() { fxpCopyPipelineEnabled = old })
			return dpStartFXPTCP(tb, target, func(c *config) { c.AEAD = "aes" })
		}},
	}
}

type dpCost struct {
	start   time.Time
	cpu     time.Duration
	mallocs uint64
}

func dpMeasureStart() dpCost {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return dpCost{start: time.Now(), cpu: dpProcessCPUTime(), mallocs: ms.Mallocs}
}

func (c dpCost) report(b *testing.B, bytes int64) {
	elapsed := time.Since(c.start)
	cpu := dpProcessCPUTime() - c.cpu
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	if bytes <= 0 || elapsed <= 0 {
		return
	}
	gb := float64(bytes) / 1e9
	b.ReportMetric(float64(bytes)*8/elapsed.Seconds()/1e9, "Gbps")
	if cpu > 0 {
		b.ReportMetric(float64(cpu.Milliseconds())/gb, "cpu-ms/GB")
	}
	b.ReportMetric(float64(ms.Mallocs-c.mallocs)/gb, "allocs/GB")
}

func dpPushTCP(addr string, chunks int, payload []byte) error {
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	for i := 0; i < chunks; i++ {
		if _, err := conn.Write(payload); err != nil {
			return fmt.Errorf("write chunk %d: %w", i, err)
		}
	}
	if err := conn.(*net.TCPConn).CloseWrite(); err != nil {
		return err
	}
	buf := make([]byte, 512)
	for {
		if _, err := conn.Read(buf); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func BenchmarkDataplaneTCPBulk(b *testing.B) {
	payload := make([]byte, dpBulkChunk)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	for _, path := range dpTCPPaths() {
		for _, streams := range []int{1, 4} {
			b.Run(fmt.Sprintf("%s/streams=%d", path.name, streams), func(b *testing.B) {
				target := dpTCPTarget(b, false)
				addr := path.start(b, target)
				if err := dpPushTCP(addr, 1, payload[:4096]); err != nil {
					b.Fatal(err)
				}
				perStream := b.N / streams
				if perStream == 0 {
					perStream = 1
				}
				b.SetBytes(dpBulkChunk)
				cost := dpMeasureStart()
				b.ResetTimer()
				var wg sync.WaitGroup
				errs := make(chan error, streams)
				for s := 0; s < streams; s++ {
					wg.Add(1)
					go func() {
						defer wg.Done()
						errs <- dpPushTCP(addr, perStream, payload)
					}()
				}
				wg.Wait()
				b.StopTimer()
				close(errs)
				for err := range errs {
					if err != nil {
						b.Fatal(err)
					}
				}
				cost.report(b, int64(perStream*streams)*dpBulkChunk)
			})
		}
	}
}

func dpReportLatency(b *testing.B, samples []time.Duration) {
	if len(samples) == 0 {
		return
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	pick := func(q float64) time.Duration {
		idx := int(float64(len(samples)) * q)
		if idx >= len(samples) {
			idx = len(samples) - 1
		}
		return samples[idx]
	}
	b.ReportMetric(float64(pick(0.50).Nanoseconds())/1e3, "p50-us")
	b.ReportMetric(float64(pick(0.99).Nanoseconds())/1e3, "p99-us")
}

func BenchmarkDataplaneTCPRTT(b *testing.B) {
	for _, path := range dpTCPPaths() {
		b.Run(path.name, func(b *testing.B) {
			target := dpTCPTarget(b, true)
			addr := path.start(b, target)
			conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
			if err != nil {
				b.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
			msg := make([]byte, dpRTTSize)
			reply := make([]byte, dpRTTSize)
			roundTrip := func() {
				if _, err := conn.Write(msg); err != nil {
					b.Fatal(err)
				}
				if _, err := io.ReadFull(conn, reply); err != nil {
					b.Fatal(err)
				}
			}
			for i := 0; i < 200; i++ {
				roundTrip()
			}
			samples := make([]time.Duration, 0, b.N)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				start := time.Now()
				roundTrip()
				samples = append(samples, time.Since(start))
			}
			b.StopTimer()
			dpReportLatency(b, samples)
		})
	}
}

// dpStartFXPUDP 起一对 UDP 直连隧道（入口 serveEntryUDPDirect、出口 serveExitUDPDirect），
// 出口的目标是 target，返回入口地址。监听套接字按线上一样调缓冲。
func dpStartFXPUDP(tb testing.TB, target *net.UDPAddr) string {
	tb.Helper()
	const (
		tunnelID = 19
		ruleID   = 6
	)
	exitConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		tb.Fatal(err)
	}
	tuneUDPConn(exitConn, "bench exit", fxpUDPListenBufferBytes)
	exitCfg := config{Role: "exit", TunnelID: tunnelID, Protocol: "udp", Key: dpKey,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: target.Port}}}
	exitDone := make(chan error, 1)
	go func() { exitDone <- serveExitUDPDirect(exitConn, exitCfg) }()
	tb.Cleanup(func() {
		_ = exitConn.Close()
		<-exitDone
	})
	exitPort := exitConn.LocalAddr().(*net.UDPAddr).Port
	entryCfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: dpKey,
		ExitHost: "127.0.0.1", ExitPort: exitPort, UDPExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: 9}
	listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		tb.Fatal(err)
	}
	tuneUDPConn(listener, "bench entry", fxpUDPListenBufferBytes)
	selector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: exitPort, UDPPort: exitPort, Key: dpKey}, "")
	entryDone := make(chan error, 1)
	go func() { entryDone <- serveEntryUDPDirect(listener, entryCfg, selector, newLimiter(0), newLimiter(0)) }()
	tb.Cleanup(func() {
		_ = listener.Close()
		<-entryDone
	})
	return listener.LocalAddr().String()
}

type dpUDPPath struct {
	name  string
	start func(tb testing.TB, target *net.UDPAddr) string
}

func dpUDPPaths() []dpUDPPath {
	return []dpUDPPath{
		{"direct", func(_ testing.TB, target *net.UDPAddr) string { return target.String() }},
		{"udp", dpStartFXPUDP},
		// 关掉批量收发（recvmmsg / sendmmsg / GSO / GRO），走逐包路径：改前改后在同一个二进制里对比。
		{"udp-perpacket", func(tb testing.TB, target *net.UDPAddr) string {
			old := fxpUDPBatchEnabled
			fxpUDPBatchEnabled = false
			tb.Cleanup(func() { fxpUDPBatchEnabled = old })
			return dpStartFXPUDP(tb, target)
		}},
		// 批量收发但不开 GRO。
		{"udp-nogro", func(tb testing.TB, target *net.UDPAddr) string {
			old := fxpUDPGROEnabled
			fxpUDPGROEnabled = false
			tb.Cleanup(func() { fxpUDPGROEnabled = old })
			return dpStartFXPUDP(tb, target)
		}},
	}
}

// dpUDPSink 只收不回，数包。两个协程一起收，夹具自己尽量不成为瓶颈。
func dpUDPSink(tb testing.TB) (*net.UDPAddr, *atomic.Int64) {
	tb.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		tb.Fatal(err)
	}
	_ = conn.SetReadBuffer(8 << 20)
	tb.Cleanup(func() { _ = conn.Close() })
	var count atomic.Int64
	for i := 0; i < 2; i++ {
		go func() {
			buf := make([]byte, 65535)
			for {
				if _, _, err := conn.ReadFromUDPAddrPort(buf); err != nil {
					return
				}
				count.Add(1)
			}
		}()
	}
	return conn.LocalAddr().(*net.UDPAddr), &count
}

// dpPaceUDP 按 rate 包/秒往 conn 发 total 个包。
func dpPaceUDP(conn *net.UDPConn, payload []byte, total int, rate int) (int, time.Duration) {
	start := time.Now()
	sent := 0
	for sent < total {
		due := int(time.Since(start).Seconds()*float64(rate)) + 1
		if due > total {
			due = total
		}
		for sent < due {
			_, _ = conn.Write(payload)
			sent++
		}
		if sent < total {
			time.Sleep(50 * time.Microsecond)
		}
	}
	return sent, time.Since(start)
}

func dpWaitQuiet(count *atomic.Int64, want int64) int64 {
	deadline := time.Now().Add(2 * time.Second)
	last := count.Load()
	stable := time.Now()
	for time.Now().Before(deadline) && last < want {
		time.Sleep(10 * time.Millisecond)
		cur := count.Load()
		if cur != last {
			last, stable = cur, time.Now()
			continue
		}
		if time.Since(stable) > 100*time.Millisecond {
			break
		}
	}
	return count.Load()
}

func BenchmarkDataplaneUDPRate(b *testing.B) {
	payload := make([]byte, dpUDPPayload)
	for _, path := range dpUDPPaths() {
		for _, rate := range []int{50_000, 200_000} {
			b.Run(fmt.Sprintf("%s/rate=%dk", path.name, rate/1000), func(b *testing.B) {
				target, count := dpUDPSink(b)
				addr := path.start(b, target)
				relay, err := net.ResolveUDPAddr("udp4", addr)
				if err != nil {
					b.Fatal(err)
				}
				conn, err := net.DialUDP("udp4", nil, relay)
				if err != nil {
					b.Fatal(err)
				}
				defer conn.Close()
				_ = conn.SetWriteBuffer(8 << 20)
				for i := 0; i < 10; i++ {
					_, _ = conn.Write(payload)
				}
				dpWaitQuiet(count, 10)
				base := count.Load()
				cost := dpMeasureStart()
				b.SetBytes(dpUDPPayload)
				b.ResetTimer()
				sent, elapsed := dpPaceUDP(conn, payload, b.N, rate)
				got := dpWaitQuiet(count, base+int64(sent)) - base
				b.StopTimer()
				if elapsed > 0 {
					b.ReportMetric(float64(got)/elapsed.Seconds(), "pps")
				}
				if sent > 0 {
					loss := 100 * float64(int64(sent)-got) / float64(sent)
					if loss < 0 {
						loss = 0
					}
					b.ReportMetric(loss, "loss-%")
				}
				if cpu := dpProcessCPUTime() - cost.cpu; cpu > 0 && got > 0 {
					b.ReportMetric(float64(cpu.Nanoseconds())/float64(got), "cpu-ns/pkt")
				}
			})
		}
	}
}

func BenchmarkDataplaneUDPRTT(b *testing.B) {
	for _, path := range dpUDPPaths() {
		b.Run(path.name, func(b *testing.B) {
			echo := startUDPEchoTarget(b)
			b.Cleanup(func() { _ = echo.Close() })
			addr := path.start(b, echo.LocalAddr().(*net.UDPAddr))
			conn, err := net.Dial("udp", addr)
			if err != nil {
				b.Fatal(err)
			}
			defer conn.Close()
			msg := make([]byte, dpRTTSize)
			reply := make([]byte, 2048)
			roundTrip := func() bool {
				if _, err := conn.Write(msg); err != nil {
					b.Fatal(err)
				}
				_ = conn.SetReadDeadline(time.Now().Add(time.Second))
				_, err := conn.Read(reply)
				return err == nil
			}
			for i := 0; i < 200; i++ {
				roundTrip()
			}
			samples := make([]time.Duration, 0, b.N)
			lost := 0
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				start := time.Now()
				if !roundTrip() {
					lost++
					continue
				}
				samples = append(samples, time.Since(start))
			}
			b.StopTimer()
			dpReportLatency(b, samples)
			if lost > 0 {
				b.ReportMetric(float64(lost), "lost")
			}
		})
	}
}
