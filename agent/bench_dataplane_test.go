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

	"golang.org/x/net/ipv4"
)

/*
数据面基准：Agent 进程内的几条转发路径在本机回环上的表现。

	direct      客户端直连目标，量的是夹具（客户端 + 目标）本身的开销，是基线
	guard       协议守护（转发类型里「进程内中转」那条），TCP 拼接 / UDP 批量
	routegroup  线路组（failover 代理），TCP / UDP

指标：

	Gbps        单向灌数据的吞吐（1e9 bit/s）
	cpu-ms/GB   整个进程（夹具 + 转发）每 1e9 字节用掉的用户态 + 内核态 CPU
	allocs/GB   每 1e9 字节的堆分配次数（runtime.MemStats.Mallocs）
	p50-us / p99-us  64 字节一问一答的往返时延；减去 direct 的就是转发加的
	conns/s     连上、发 1 字节、收回 1 字节、关掉，一秒能做多少次（考接受连接的速度）
	pps / loss-%     UDP 按固定速率发 1200 字节的包，目标收到的速率和丢包率

gost、realm、socat、nginx、内核转发都是独立进程或内核，不在这里；它们的吞吐由真机
iperf3 量（scripts/soak/、诊断里的 iperf3 双机测试）。

scripts/bench/dataplane.sh 用 -cpu 1,4 跑这里和 forwardx-fxp 里同名的基准，原始输出存下来
做改前改后的对比。
*/

const (
	dpBulkChunk   = 1 << 20
	dpRTTSize     = 64
	dpUDPPayload  = 1200
	dpReadBufSize = 256 << 10
)

var dpRuleSeq atomic.Int64

func dpNextRule() int { return int(980000 + dpRuleSeq.Add(1)) }

// dpTCPTarget 起一个 TCP 目标。echo 为真时原样回显（时延、连接速率用），否则只收不回，
// 读到 EOF 就关（灌数据用）。
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

type dpTCPPath struct {
	name  string
	start func(tb testing.TB, target *net.TCPAddr) string
}

func dpTCPPaths() []dpTCPPath {
	return []dpTCPPath{
		{"direct", func(_ testing.TB, target *net.TCPAddr) string { return target.String() }},
		{"guard", dpStartGuardTCP},
		{"routegroup", dpStartRouteGroupTCP},
	}
}

// dpStartGuardTCP 走 startProtocolGuard 同一条监听路径（listenTCPForRelay），这样
// 监听方式的改动（比如 SO_REUSEPORT）也量得到。
func dpStartGuardTCP(tb testing.TB, target *net.TCPAddr) string {
	tb.Helper()
	port := failoverTestPort(tb)
	rule := guardRule{
		RuleID: dpNextRule(), ListenPort: port, TargetIP: "127.0.0.1", TargetPort: target.Port,
		Protocol: "tcp", RateLimitScope: tb.Name(),
	}
	ln, err := listenTCPForRelay(net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		tb.Fatal(err)
	}
	server := newProtocolGuardServer(rule)
	server.tcpLn = ln
	go server.serveTCP(Config{})
	tb.Cleanup(server.close)
	return ln.Addr().String()
}

func dpStartRouteGroupTCP(tb testing.TB, target *net.TCPAddr) string {
	tb.Helper()
	failoverUDPTestSetup(tb)
	spec := failoverTestSpec(failoverTestPort(tb))
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: target.Port}, {TargetIP: "127.0.0.1", TargetPort: target.Port}}
	ruleID := dpNextRule()
	_, addr := startUDPFailoverForTest(tb, ruleID, ruleID%60000+1024, spec)
	return addr
}

type dpCost struct {
	start   time.Time
	cpu     time.Duration
	mallocs uint64
}

func dpMeasureStart() dpCost {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return dpCost{start: time.Now(), cpu: processCPUTime(), mallocs: ms.Mallocs}
}

// report 按搬过的字节数报吞吐、每 GB 的 CPU 和分配。
func (c dpCost) report(b *testing.B, bytes int64) {
	elapsed := time.Since(c.start)
	cpu := processCPUTime() - c.cpu
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

// dpPushTCP 往 addr 开一条连接灌 chunks 个 1 MiB，写完半关，等对端关掉（数据全部到了
// 目标、目标关连接、转发把关闭传回来）才返回。
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

// BenchmarkDataplaneTCPBulk：单向灌数据，streams 条连接并发。
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
				// 先走一条小连接，让线路组选好路径、协议守护把规则准备好。
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

// BenchmarkDataplaneTCPRTT：一条连接上 64 字节一问一答。
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

// BenchmarkDataplaneTCPConnRate：32 个客户端并发地连上、发 1 字节、收回来、关掉。
// 客户端用 SO_LINGER=0 关，免得本机几万个 TIME_WAIT 把临时端口用光。
func BenchmarkDataplaneTCPConnRate(b *testing.B) {
	for _, path := range dpTCPPaths() {
		b.Run(path.name, func(b *testing.B) {
			target := dpTCPTarget(b, true)
			addr := path.start(b, target)
			const clients = 32
			var next atomic.Int64
			var failed atomic.Int64
			b.ResetTimer()
			start := time.Now()
			var wg sync.WaitGroup
			for c := 0; c < clients; c++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					one := []byte{1}
					for next.Add(1) <= int64(b.N) {
						conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
						if err != nil {
							failed.Add(1)
							continue
						}
						_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
						if _, err := conn.Write(one); err != nil {
							failed.Add(1)
						} else if _, err := io.ReadFull(conn, one); err != nil {
							failed.Add(1)
						}
						_ = conn.(*net.TCPConn).SetLinger(0)
						_ = conn.Close()
					}
				}()
			}
			wg.Wait()
			elapsed := time.Since(start)
			b.StopTimer()
			b.ReportMetric(float64(b.N)/elapsed.Seconds(), "conns/s")
			if n := failed.Load(); n > 0 {
				b.ReportMetric(float64(n), "failed")
			}
		})
	}
}

type dpUDPPath struct {
	name  string
	start func(tb testing.TB, target *net.UDPAddr) string
}

func dpUDPPaths() []dpUDPPath {
	return []dpUDPPath{
		{"direct", func(_ testing.TB, target *net.UDPAddr) string { return target.String() }},
		{"guard", func(tb testing.TB, target *net.UDPAddr) string {
			return startGuardUDPRelayForTest(tb, dpNextRule(), target, nil)
		}},
		{"routegroup", func(tb testing.TB, target *net.UDPAddr) string {
			failoverUDPTestSetup(tb)
			spec := failoverTestSpec(failoverTestDualPort(tb))
			spec.Protocol = "udp"
			spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: target.Port}, {TargetIP: "127.0.0.1", TargetPort: target.Port}}
			ruleID := dpNextRule()
			_, addr := startUDPFailoverForTest(tb, ruleID, ruleID%60000+1024, spec)
			return addr
		}},
	}
}

// dpUDPSink 只收不回，数包。用 recvmmsg 收，夹具自己尽量不成为瓶颈。
func dpUDPSink(tb testing.TB) (*net.UDPAddr, *atomic.Int64) {
	tb.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		tb.Fatal(err)
	}
	_ = conn.SetReadBuffer(8 << 20)
	tb.Cleanup(func() { _ = conn.Close() })
	var count atomic.Int64
	go func() {
		pc := ipv4.NewPacketConn(conn)
		msgs := make([]ipv4.Message, 64)
		for i := range msgs {
			msgs[i].Buffers = [][]byte{make([]byte, 2048)}
		}
		for {
			n, err := pc.ReadBatch(msgs, 0)
			if err != nil {
				return
			}
			count.Add(int64(n))
		}
	}()
	return conn.LocalAddr().(*net.UDPAddr), &count
}

// dpPaceUDP 按 rate 包/秒往 conn（已 connect 到转发的监听地址）发 total 个包，用 sendmmsg
// 一次发一小批。返回实际发出去的包数和用时。
func dpPaceUDP(conn *net.UDPConn, payload []byte, total int, rate int) (int, time.Duration, error) {
	pc := ipv4.NewPacketConn(conn)
	msgs := make([]ipv4.Message, 32)
	for i := range msgs {
		msgs[i].Buffers = [][]byte{payload}
	}
	start := time.Now()
	sent := 0
	for sent < total {
		due := int(time.Since(start).Seconds()*float64(rate)) + 1
		if due > total {
			due = total
		}
		for sent < due {
			batch := due - sent
			if batch > len(msgs) {
				batch = len(msgs)
			}
			n, err := pc.WriteBatch(msgs[:batch], 0)
			if err != nil {
				// 本机回环上 ENOBUFS / ECONNREFUSED 也算丢，继续按节奏发。
				sent += batch
				continue
			}
			sent += n
		}
		if sent < total {
			time.Sleep(50 * time.Microsecond)
		}
	}
	return sent, time.Since(start), nil
}

// dpWaitQuiet 等计数停止增长（100 ms 没有新包）或到 2 秒。
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

// BenchmarkDataplaneUDPRate：一个客户端按固定速率发 1200 字节的包经过转发到目标，量目标
// 实际收到的速率和丢包率。每个 op 是一个包，所以 ns/op 约等于 1/速率。
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
				// 先发几个包把会话建好。
				for i := 0; i < 10; i++ {
					_, _ = conn.Write(payload)
				}
				dpWaitQuiet(count, 10)
				base := count.Load()
				cost := dpMeasureStart()
				b.SetBytes(dpUDPPayload)
				b.ResetTimer()
				sent, elapsed, err := dpPaceUDP(conn, payload, b.N, rate)
				if err != nil {
					b.Fatal(err)
				}
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
				if cpu := processCPUTime() - cost.cpu; cpu > 0 && got > 0 {
					b.ReportMetric(float64(cpu.Nanoseconds())/float64(got), "cpu-ns/pkt")
				}
			})
		}
	}
}

// BenchmarkDataplaneUDPRTT：一个客户端 64 字节一问一答，经过转发到回显目标。
func BenchmarkDataplaneUDPRTT(b *testing.B) {
	for _, path := range dpUDPPaths() {
		b.Run(path.name, func(b *testing.B) {
			echo := udpPlainEcho(b)
			addr := path.start(b, echo)
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
