package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	v3 "github.com/zhongyizhu11-jpg/NEX/forwardx-fxp/internal/v3"
)

/*
NEX V3 的性能基准：入口 → （可选：延迟代理）→ 出口，两端都在本进程里、走真实的外层、内层握手
和多路复用，和 bench_dataplane_test.go 共用夹具（dpTCPTarget、dpPushTCP、dpMeasureStart）。

	BenchmarkV3Bulk      回环上单条连接灌数据：Gbps / cpu-ms/GB / allocs/GB
	BenchmarkV3BulkRTT   入口和出口之间插一个延迟代理（50ms / 200ms 往返），单条连接（和 4 条）
	                     灌 V3BENCH_SECONDS 秒（默认 4），去掉第一秒的爬坡，报稳态 Mbit/s
	BenchmarkV3ConnRate  16 个并发客户端反复「建连 → 64 字节一问一答 → 关」，报每秒连接数和
	                     建连到收到回声的 p50 / p99（回环和 50ms 往返）
	BenchmarkV3FirstConn 隧道起来 1.5 秒后的第一条连接（预热有没有做完），50ms 往返

路径名：v1 是 V1（AES-256-GCM）做对照；v3-<外层>-mux / v3-<外层>-nomux 是 NEX V3。

	go test -run '^$' -bench 'BenchmarkV3Bulk$' -benchtime 2000x -count 3 .
	go test -run '^$' -bench 'BenchmarkV3(BulkRTT|ConnRate|FirstConn)' -benchtime 1x -count 3 .

这个文件只用 config 字段起隧道，不碰 V3 的内部类型，所以能拷到改动前的提交上跑基线
（internal/v3/BENCHMARKS.md 记了怎么跑、两边的数字）。例外是 BenchmarkV3InnerCipher（内层两种
AEAD 算法的对比，用了 v3.OverrideAESHardware 钩子）：拷到基线上跑时删掉它和 v3 的 import。
*/

type v3BenchPath struct {
	name string
	cfg  func(*config)
}

func v3BenchBool(v bool) *bool { return &v }

func v3BenchPaths(transports []string, withV1 bool) []v3BenchPath {
	var paths []v3BenchPath
	if withV1 {
		paths = append(paths, v3BenchPath{"v1", func(c *config) { c.AEAD = "aes" }})
	}
	for _, mode := range transports {
		for _, mux := range []bool{false, true} {
			mode, mux := mode, mux
			name := "v3-" + mode + "-nomux"
			if mux {
				name = "v3-" + mode + "-mux"
			}
			paths = append(paths, v3BenchPath{name, func(c *config) {
				c.TransportVersion = "v3"
				c.V3Transport = mode
				c.V3Multiplex = v3BenchBool(mux)
				if mode != "tls" {
					c.V3Path = "/bench"
					c.V3Host = "cdn.example.test"
				}
			}})
		}
	}
	return paths
}

// v3BenchDelayProxy 是一条「有往返延迟」的链路：每个方向读到的字节过 oneWay 再写给对面。
// 每个方向最多攒 v3BenchLinkQueue 字节在路上（相当于链路上最多能有这么多在飞），攒满了就
// 不再读，背压回到发送方的 TCP。不限带宽：要看的是窗口 / 往返决定的吞吐上限。
//
// TCP 的三次握手在本机回环上是瞬间完成的，代理补上它：客户端的第一个字节最早在接受之后
// 2 × oneWay（SYN / SYN-ACK 的一个往返）才算发出，再过 oneWay 到对面。
const v3BenchLinkQueue = 32 << 20

func v3BenchDelayProxy(tb testing.TB, upstream string, oneWay time.Duration) int {
	tb.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	var conns sync.WaitGroup
	tb.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			down, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", upstream)
			if err != nil {
				_ = down.Close()
				continue
			}
			accepted := time.Now()
			conns.Add(2)
			go func() { defer conns.Done(); v3BenchDelayPump(up, down, oneWay, accepted.Add(2*oneWay)) }()
			go func() { defer conns.Done(); v3BenchDelayPump(down, up, oneWay, accepted) }()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

type v3BenchChunk struct {
	data []byte
	due  time.Time
}

func v3BenchDelayPump(dst, src net.Conn, oneWay time.Duration, notBefore time.Time) {
	queue := make(chan v3BenchChunk, 1<<14)
	var mu sync.Mutex
	cond := sync.NewCond(&mu)
	inFlight := 0
	done := make(chan struct{})
	go func() {
		defer close(done)
		for chunk := range queue {
			if wait := time.Until(chunk.due); wait > 0 {
				time.Sleep(wait)
			}
			_, err := dst.Write(chunk.data)
			mu.Lock()
			inFlight -= len(chunk.data)
			cond.Broadcast()
			mu.Unlock()
			if err != nil {
				_ = src.Close()
				_ = dst.Close()
				for range queue {
				}
				return
			}
		}
		if tcp, ok := dst.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	for {
		buf := make([]byte, 64<<10)
		n, err := src.Read(buf)
		if n > 0 {
			mu.Lock()
			for inFlight+n > v3BenchLinkQueue {
				cond.Wait()
			}
			inFlight += n
			mu.Unlock()
			sent := time.Now()
			if sent.Before(notBefore) {
				sent = notBefore
			}
			queue <- v3BenchChunk{data: buf[:n], due: sent.Add(oneWay)}
		}
		if err != nil {
			break
		}
	}
	close(queue)
	<-done
}

// v3BenchStart 起一对出口 + 入口，rtt 非零时中间插延迟代理。返回入口地址。
func v3BenchStart(tb testing.TB, target *net.TCPAddr, path v3BenchPath, rtt time.Duration) string {
	return v3BenchStartWith(tb, target, path, rtt, true)
}

// v3BenchStartWith：probeEntry 为假时不用「连一下」的办法等入口起来（连一下会让入口去拨
// 出口，预热就不是预热了），改看 /proc/net/tcp 里有没有这个端口在监听。
func v3BenchStartWith(tb testing.TB, target *net.TCPAddr, path v3BenchPath, rtt time.Duration, probeEntry bool) string {
	tb.Helper()
	resetFXPEndpointRegistry()
	exitPort := dpFreePort(tb)
	entryPort := dpFreePort(tb)
	exitCfg := config{
		Role: "exit", TunnelID: 41, ListenPort: exitPort, Protocol: "tcp", Key: dpKey,
		StreamTargets: loopbackStreamTargets(9, target.Port),
	}
	hopPort := exitPort
	entryCfg := config{
		Role: "entry", TunnelID: 41, RuleID: 9, ListenPort: entryPort, Protocol: "tcp",
		ExitHost: "127.0.0.1", TargetIP: "127.0.0.1", TargetPort: target.Port, Key: dpKey,
	}
	path.cfg(&exitCfg)
	path.cfg(&entryCfg)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	tb.Cleanup(func() { close(entryDone); close(exitDone) })
	go func() { _ = runExit(exitDone, exitCfg) }()
	dpWaitTCPPort(tb, exitPort)
	if rtt > 0 {
		hopPort = v3BenchDelayProxy(tb, net.JoinHostPort("127.0.0.1", strconv.Itoa(exitPort)), rtt/2)
	}
	entryCfg.ExitPort = hopPort
	go func() { _ = runEntry(entryDone, entryCfg) }()
	if probeEntry {
		dpWaitTCPPort(tb, entryPort)
	} else {
		v3BenchWaitListening(tb, entryPort)
	}
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort))
}

func v3BenchWaitListening(tb testing.TB, port int) {
	tb.Helper()
	needle := fmt.Sprintf(":%04X 00000000:0000 0A", port)
	needle6 := fmt.Sprintf(":%04X 00000000000000000000000000000000:0000 0A", port)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, file := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
			data, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			text := string(data)
			if strings.Contains(text, needle) || strings.Contains(text, needle6) {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	tb.Fatalf("port %d did not start listening", port)
}

func BenchmarkV3Bulk(b *testing.B) {
	payload := make([]byte, dpBulkChunk)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	for _, path := range v3BenchPaths([]string{"tls", "ws", "http"}, true) {
		for _, streams := range []int{1, 4} {
			b.Run(fmt.Sprintf("%s/streams=%d", path.name, streams), func(b *testing.B) {
				target := dpTCPTarget(b, false)
				addr := v3BenchStart(b, target, path, 0)
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

// v3BenchCountingTarget 只收不回，把收到的字节数累加到 total。
func v3BenchCountingTarget(tb testing.TB) (*net.TCPAddr, *atomic.Int64) {
	tb.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = ln.Close() })
	var total atomic.Int64
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
					total.Add(int64(n))
					if err != nil {
						return
					}
				}
			}(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr), &total
}

func v3BenchSeconds() time.Duration {
	if v, err := strconv.Atoi(os.Getenv("V3BENCH_SECONDS")); err == nil && v > 1 {
		return time.Duration(v) * time.Second
	}
	return 4 * time.Second
}

func BenchmarkV3BulkRTT(b *testing.B) {
	payload := make([]byte, 256<<10)
	for _, rtt := range []time.Duration{50 * time.Millisecond, 200 * time.Millisecond} {
		for _, path := range v3BenchPaths([]string{"tls", "ws"}, true) {
			for _, streams := range []int{1, 4} {
				b.Run(fmt.Sprintf("rtt=%dms/%s/streams=%d", rtt.Milliseconds(), path.name, streams), func(b *testing.B) {
					target, total := v3BenchCountingTarget(b)
					addr := v3BenchStart(b, target, path, rtt)
					window := v3BenchSeconds()
					b.ResetTimer()
					for i := 0; i < b.N; i++ {
						stop := make(chan struct{})
						var wg sync.WaitGroup
						for s := 0; s < streams; s++ {
							wg.Add(1)
							go func() {
								defer wg.Done()
								conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
								if err != nil {
									return
								}
								defer conn.Close()
								go func() { <-stop; _ = conn.Close() }()
								for {
									if _, err := conn.Write(payload); err != nil {
										return
									}
								}
							}()
						}
						// 第一秒是建连和爬坡（窗口自适应要几个往返），不算。
						time.Sleep(time.Second)
						start, startAt := total.Load(), time.Now()
						time.Sleep(window - time.Second)
						got, elapsed := total.Load()-start, time.Since(startAt)
						close(stop)
						wg.Wait()
						b.ReportMetric(float64(got)*8/elapsed.Seconds()/1e6, "Mbps")
					}
				})
			}
		}
	}
}

// v3BenchEchoOnce 建一条连接、发 64 字节、等回声、关，返回从拨号到收到回声的时长。
func v3BenchEchoOnce(addr string, msg, reply []byte) (time.Duration, error) {
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write(msg); err != nil {
		return 0, err
	}
	if _, err := io.ReadFull(conn, reply); err != nil {
		return 0, err
	}
	return time.Since(start), nil
}

func v3BenchPercentiles(b *testing.B, samples []time.Duration) {
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
	b.ReportMetric(float64(pick(0.50).Microseconds())/1e3, "p50-ms")
	b.ReportMetric(float64(pick(0.99).Microseconds())/1e3, "p99-ms")
}

func BenchmarkV3ConnRate(b *testing.B) {
	const workers = 16
	for _, rtt := range []time.Duration{0, 50 * time.Millisecond} {
		for _, path := range v3BenchPaths([]string{"tls", "http"}, true) {
			b.Run(fmt.Sprintf("rtt=%dms/%s", rtt.Milliseconds(), path.name), func(b *testing.B) {
				target := dpTCPTarget(b, true)
				addr := v3BenchStart(b, target, path, rtt)
				msg := make([]byte, dpRTTSize)
				// 先走通一条，再让池子 / 会话按负载长起来。
				if _, err := v3BenchEchoOnce(addr, msg, make([]byte, dpRTTSize)); err != nil {
					b.Fatal(err)
				}
				window := v3BenchSeconds()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					var mu sync.Mutex
					var samples []time.Duration
					var failures atomic.Int64
					deadline := time.Now().Add(window)
					var wg sync.WaitGroup
					started := time.Now()
					for w := 0; w < workers; w++ {
						wg.Add(1)
						go func() {
							defer wg.Done()
							reply := make([]byte, dpRTTSize)
							var local []time.Duration
							for time.Now().Before(deadline) {
								d, err := v3BenchEchoOnce(addr, msg, reply)
								if err != nil {
									failures.Add(1)
									continue
								}
								local = append(local, d)
							}
							mu.Lock()
							samples = append(samples, local...)
							mu.Unlock()
						}()
					}
					wg.Wait()
					elapsed := time.Since(started)
					b.ReportMetric(float64(len(samples))/elapsed.Seconds(), "conns/s")
					b.ReportMetric(float64(failures.Load()), "failed")
					v3BenchPercentiles(b, samples)
				}
			})
		}
	}
}

func BenchmarkV3FirstConn(b *testing.B) {
	for _, path := range v3BenchPaths([]string{"tls", "http"}, true) {
		b.Run(fmt.Sprintf("rtt=50ms/%s", path.name), func(b *testing.B) {
			var samples []time.Duration
			for i := 0; i < b.N; i++ {
				target := dpTCPTarget(b, true)
				addr := v3BenchStartWith(b, target, path, 50*time.Millisecond, false)
				// 规则刚起来、还没有用户连接：给预热留的时间。
				time.Sleep(1500 * time.Millisecond)
				d, err := v3BenchEchoOnce(addr, make([]byte, dpRTTSize), make([]byte, dpRTTSize))
				if err != nil {
					b.Fatal(err)
				}
				samples = append(samples, d)
			}
			v3BenchPercentiles(b, samples)
		})
	}
}

// BenchmarkV3InnerCipher 比内层 AEAD 记录的两种算法（模式 3 AES-128-GCM / 模式 5 ChaCha20-Poly1305）：
// 只在 HTTP / WS 外层上有意义（TLS 1.3 外层内层直通，算法由 TLS 选）。用 v3.OverrideAESHardware
// 让两端都当作有 / 没有 AES 硬件，所以这一个基准用了 V3 的内部钩子，拷到基线提交上跑时删掉它。
//
//	go test -run '^$' -bench 'BenchmarkV3InnerCipher' -benchtime 300x -count 3 .
//	GODEBUG=cpu.aes=off go test ...   # 模拟没有 AES 硬件：标准库的 AES-GCM 退回纯 Go 实现
func BenchmarkV3InnerCipher(b *testing.B) {
	payload := make([]byte, dpBulkChunk)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	paths := v3BenchPaths([]string{"ws", "http"}, false)
	for _, cipher := range []struct {
		name   string
		hasAES bool
	}{{"aes-128-gcm", true}, {"chacha20-poly1305", false}} {
		for _, path := range paths {
			for _, streams := range []int{1, 4} {
				b.Run(fmt.Sprintf("%s/%s/streams=%d", cipher.name, path.name, streams), func(b *testing.B) {
					defer v3.OverrideAESHardware(cipher.hasAES)()
					target := dpTCPTarget(b, false)
					addr := v3BenchStart(b, target, path, 0)
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
					errs := make(chan error, streams)
					for s := 0; s < streams; s++ {
						go func() { errs <- dpPushTCP(addr, perStream, payload) }()
					}
					for s := 0; s < streams; s++ {
						if err := <-errs; err != nil {
							b.Fatal(err)
						}
					}
					b.StopTimer()
					cost.report(b, int64(perStream*streams)*dpBulkChunk)
				})
			}
		}
	}
}
