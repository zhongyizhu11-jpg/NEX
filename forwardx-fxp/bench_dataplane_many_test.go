package main

import (
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/*
多连接 / 多会话 / 建连速率的数据面基准，补 bench_dataplane_test.go 里只有 1、4 条流的空白：

	BenchmarkDataplaneTCPBulkMany   32 条流同时灌数据：看缓冲池被很多条流一起借用时的分配（allocs/GB）和吞吐
	BenchmarkDataplaneTCPConnRate   32 个客户端不停地连 → 写 1 字节 → 读回显 → 关：建连速率（conns/s）
	BenchmarkDataplaneUDPSessions   256 个客户端套接字轮着发包：多会话下的 pps、丢包和每包 CPU

和同文件的其它基准一样只在本机回环上跑，数字用于同一台机器上改前改后对比。
*/

const dpManyStreams = 32

func BenchmarkDataplaneTCPBulkMany(b *testing.B) {
	payload := make([]byte, dpBulkChunk)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	for _, path := range dpTCPPaths() {
		if path.name != "direct" && path.name != "aes" {
			continue
		}
		b.Run(fmt.Sprintf("%s/streams=%d", path.name, dpManyStreams), func(b *testing.B) {
			target := dpTCPTarget(b, false)
			addr := path.start(b, target)
			if err := dpPushTCP(addr, 1, payload[:4096]); err != nil {
				b.Fatal(err)
			}
			perStream := b.N / dpManyStreams
			if perStream == 0 {
				perStream = 1
			}
			b.SetBytes(dpBulkChunk)
			cost := dpMeasureStart()
			b.ResetTimer()
			var wg sync.WaitGroup
			errs := make(chan error, dpManyStreams)
			for s := 0; s < dpManyStreams; s++ {
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
			cost.report(b, int64(perStream*dpManyStreams)*dpBulkChunk)
		})
	}
}

func BenchmarkDataplaneTCPConnRate(b *testing.B) {
	for _, path := range dpTCPPaths() {
		if path.name != "direct" && path.name != "aes" {
			continue
		}
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

func BenchmarkDataplaneUDPSessions(b *testing.B) {
	payload := make([]byte, dpUDPPayload)
	const sessions = 256
	const rate = 100_000
	for _, path := range dpUDPPaths() {
		if path.name != "direct" && path.name != "udp" {
			continue
		}
		b.Run(fmt.Sprintf("%s/sessions=%d", path.name, sessions), func(b *testing.B) {
			target, count := dpUDPSink(b)
			addr := path.start(b, target)
			relay, err := net.ResolveUDPAddr("udp4", addr)
			if err != nil {
				b.Fatal(err)
			}
			conns := make([]*net.UDPConn, sessions)
			for i := range conns {
				// 每个会话用不同的回环源地址（127.0.0.2 起）：入口按来源 IP 限会话数（硬上限 64），
				// 全从 127.0.0.1 来的话 256 个会话里只有 64 个能建起来，量出来的是限额而不是数据面。
				source := &net.UDPAddr{IP: net.IPv4(127, 0, byte(1+i/250), byte(2+i%250))}
				conn, err := net.DialUDP("udp4", source, relay)
				if err != nil {
					b.Fatal(err)
				}
				_ = conn.SetWriteBuffer(1 << 20)
				conns[i] = conn
			}
			defer func() {
				for _, conn := range conns {
					_ = conn.Close()
				}
			}()
			// 每个会话先发一个包把会话建起来，再开始计时：量的是稳定态，不是 256 条会话的建立。
			for _, conn := range conns {
				_, _ = conn.Write(payload)
			}
			dpWaitQuiet(count, sessions)
			base := count.Load()
			cost := dpMeasureStart()
			b.SetBytes(dpUDPPayload)
			b.ResetTimer()
			start := time.Now()
			sent := 0
			for sent < b.N {
				due := int(time.Since(start).Seconds()*float64(rate)) + 1
				if due > b.N {
					due = b.N
				}
				for sent < due {
					_, _ = conns[sent%sessions].Write(payload)
					sent++
				}
				if sent < b.N {
					time.Sleep(50 * time.Microsecond)
				}
			}
			elapsed := time.Since(start)
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
