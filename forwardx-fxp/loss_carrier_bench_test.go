package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"
)

/*
抗丢包传输的基准。入口、出口都在本进程里，走真实的运行时、握手和帧加密。

	path=tcp       现有的 TCP 承载（对照）
	path=carrier   抗丢包承载（KCP + FEC）
	net=clean      不经有损网络（本机回环）
	net=lossyN     进程内有损网络：单向 10 ms ± 4 ms、3% 乱序，丢 N%（loss_carrier_net_test.go）

	Mbps / cpu-ms/GB    单条连接单向灌数据（目标只收不回）
	p50/p90/p99/max-ms  64 字节一问一答

口径的局限（如实写）：
  - 进程内的有损网络只能包在抗丢包承载的 UDP 套接字外面，内核里的 TCP 没法这样丢包，
    所以 path=tcp 只有 net=clean。要让 TCP 也在丢包下比，见 LOSS_TOLERANT_TRANSPORT.md 里用
    网络命名空间 + iptables 随机丢包跑的那一组（那组没有延迟，往返时间约等于 0）。
  - 本机回环上没有带宽瓶颈，net=clean 时比的是 CPU 能推多快，不是线路上能跑多快。
*/

func lcBenchNets() []struct {
	name string
	cfg  *lossyNetConfig
} {
	lossy := func(loss float64) *lossyNetConfig {
		return &lossyNetConfig{loss: loss, delay: 10 * time.Millisecond, jitter: 4 * time.Millisecond, reorder: 0.03, reorderExtra: 15 * time.Millisecond, seed: 42}
	}
	return []struct {
		name string
		cfg  *lossyNetConfig
	}{
		{"clean", nil},
		{"lossy0", lossy(0)},
		{"lossy1", lossy(0.01)},
		{"lossy5", lossy(0.05)},
		{"lossy15", lossy(0.15)},
	}
}

type lcBenchPath struct {
	name    string
	carrier bool
}

var lcBenchPaths = []lcBenchPath{{"tcp", false}, {"carrier", true}}

// lcBenchTunnel 起一对入口 + 出口，返回入口地址。
func lcBenchTunnel(b *testing.B, path lcBenchPath, network *lossyNetConfig, echo bool) string {
	b.Helper()
	resetFXPEndpointRegistry()
	b.Cleanup(resetFXPEndpointRegistry)
	if network != nil {
		useLossyNetwork(b, *network)
	}
	target := dpTCPTarget(b, echo)
	exitPort := dpFreePort(b)
	// 指定出口端口：在网络命名空间里只对隧道中间这一段（入口 ↔ 出口）随机丢包时用，
	// 客户端 ↔ 入口、出口 ↔ 目标两段不受影响。见 LOSS_TOLERANT_TRANSPORT.md。
	if fixed, err := strconv.Atoi(os.Getenv("FXP_LC_BENCH_EXIT_PORT")); err == nil && fixed > 0 {
		exitPort = fixed
	}
	entryPort := dpFreePort(b)
	exitCfg := config{Role: "exit", TunnelID: 17, ListenPort: exitPort, Protocol: "tcp", Key: dpKey,
		StreamTargets: loopbackStreamTargets(5, target.Port), LossTolerant: path.carrier, AEAD: "aes"}
	entryCfg := config{Role: "entry", TunnelID: 17, RuleID: 5, ListenPort: entryPort, Protocol: "tcp",
		ExitHost: "127.0.0.1", ExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: target.Port, Key: dpKey,
		LossTolerant: path.carrier, AEAD: "aes"}
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	exitStopped := make(chan struct{})
	b.Cleanup(func() {
		close(entryDone)
		close(exitDone)
		<-exitStopped
	})
	go func() {
		defer close(exitStopped)
		_ = runExit(exitDone, exitCfg)
	}()
	dpWaitTCPPort(b, exitPort)
	go func() { _ = runEntry(entryDone, entryCfg) }()
	dpWaitTCPPort(b, entryPort)
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort))
}

func BenchmarkLossTolerantBulk(b *testing.B) {
	payload := make([]byte, dpBulkChunk)
	for i := range payload {
		payload[i] = byte(i * 13)
	}
	for _, path := range lcBenchPaths {
		for _, network := range lcBenchNets() {
			if !path.carrier && network.cfg != nil {
				continue
			}
			b.Run(fmt.Sprintf("path=%s/net=%s", path.name, network.name), func(b *testing.B) {
				addr := lcBenchTunnel(b, path, network.cfg, false)
				if err := dpPushTCP(addr, 1, payload[:4096]); err != nil {
					b.Fatal(err)
				}
				b.SetBytes(dpBulkChunk)
				cost := dpMeasureStart()
				b.ResetTimer()
				if err := dpPushTCP(addr, b.N, payload); err != nil {
					b.Fatal(err)
				}
				b.StopTimer()
				elapsed := time.Since(cost.start)
				cost.report(b, int64(b.N)*dpBulkChunk)
				b.ReportMetric(float64(b.N)*dpBulkChunk*8/elapsed.Seconds()/1e6, "Mbps")
			})
		}
	}
}

// BenchmarkLossTolerantParallel：4 条连接同时灌，看总吞吐（单条连接受固定窗口封顶）。
func BenchmarkLossTolerantParallel(b *testing.B) {
	payload := make([]byte, dpBulkChunk)
	for _, path := range lcBenchPaths {
		for _, network := range lcBenchNets() {
			if !path.carrier && network.cfg != nil {
				continue
			}
			b.Run(fmt.Sprintf("path=%s/net=%s", path.name, network.name), func(b *testing.B) {
				addr := lcBenchTunnel(b, path, network.cfg, false)
				const streams = 4
				perStream := b.N/streams + 1
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
				elapsed := time.Since(cost.start)
				total := int64(perStream*streams) * dpBulkChunk
				cost.report(b, total)
				b.ReportMetric(float64(total)*8/elapsed.Seconds()/1e6, "Mbps")
			})
		}
	}
}

func lcReportLatencyMs(b *testing.B, samples []time.Duration) {
	if len(samples) == 0 {
		return
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	pick := func(q float64) float64 {
		idx := int(float64(len(samples)) * q)
		if idx >= len(samples) {
			idx = len(samples) - 1
		}
		return float64(samples[idx].Microseconds()) / 1000
	}
	b.ReportMetric(pick(0.50), "p50-ms")
	b.ReportMetric(pick(0.90), "p90-ms")
	b.ReportMetric(pick(0.99), "p99-ms")
	b.ReportMetric(float64(samples[len(samples)-1].Microseconds())/1000, "max-ms")
}

func BenchmarkLossTolerantRTT(b *testing.B) {
	for _, path := range lcBenchPaths {
		for _, network := range lcBenchNets() {
			if !path.carrier && network.cfg != nil {
				continue
			}
			b.Run(fmt.Sprintf("path=%s/net=%s", path.name, network.name), func(b *testing.B) {
				addr := lcBenchTunnel(b, path, network.cfg, true)
				conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
				if err != nil {
					b.Fatal(err)
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Minute))
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
				for i := 0; i < 20; i++ {
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
				lcReportLatencyMs(b, samples)
			})
		}
	}
}
