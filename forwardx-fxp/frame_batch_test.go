package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"
)

// startEchoTunnel 起一对进程内的入口 + 出口，出口的目标是一个回显服务：客户端写
// 进入口的每个字节都原样回来，客户端半关之后回显服务也半关，流的两端各自收尾。
// 返回入口端口；清理挂在 tb 上。
func startEchoTunnel(tb testing.TB) int {
	tb.Helper()
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = targetLn.Close() })
	go func() {
		for {
			conn, err := targetLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	freePort := func() int {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			tb.Fatal(err)
		}
		defer ln.Close()
		return ln.Addr().(*net.TCPAddr).Port
	}
	waitPort := func(port int) {
		deadline := time.Now().Add(3 * time.Second)
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

	key := "frame-batch-key"
	targetPort := targetLn.Addr().(*net.TCPAddr).Port
	exitPort := freePort()
	entryPort := freePort()
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	tb.Cleanup(func() { close(entryDone); close(exitDone) })
	go func() {
		_ = runExit(exitDone, config{
			Role:          "exit",
			TunnelID:      7,
			ListenPort:    exitPort,
			Protocol:      "tcp",
			Key:           key,
			StreamTargets: loopbackStreamTargets(3, targetPort),
		})
	}()
	waitPort(exitPort)
	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   7,
			RuleID:     3,
			ListenPort: entryPort,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   exitPort,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        key,
		})
	}()
	waitPort(entryPort)
	return entryPort
}

func dialEntry(tb testing.TB, port int) *net.TCPConn {
	tb.Helper()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 3*time.Second)
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = conn.Close() })
	return conn.(*net.TCPConn)
}

// echoThroughTunnel 把 payload 按 chunks 的切法写进隧道、写完半关，同时把回显全部
// 读回来直到对端半关，返回读到的内容的 SHA-256 和长度。
func echoThroughTunnel(tb testing.TB, conn *net.TCPConn, payload []byte, chunks []int) (string, int) {
	tb.Helper()
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	var wg sync.WaitGroup
	wg.Add(1)
	writeErr := make(chan error, 1)
	go func() {
		defer wg.Done()
		offset := 0
		for _, size := range chunks {
			if offset+size > len(payload) {
				size = len(payload) - offset
			}
			if _, err := conn.Write(payload[offset : offset+size]); err != nil {
				writeErr <- err
				return
			}
			offset += size
		}
		if offset < len(payload) {
			if _, err := conn.Write(payload[offset:]); err != nil {
				writeErr <- err
				return
			}
		}
		writeErr <- conn.CloseWrite()
	}()
	hash := sha256.New()
	n, err := io.Copy(hash, conn)
	if err != nil {
		tb.Fatalf("read echo: %v after %d bytes", err, n)
	}
	wg.Wait()
	if err := <-writeErr; err != nil {
		tb.Fatalf("write: %v", err)
	}
	return hex.EncodeToString(hash.Sum(nil)), int(n)
}

func randomChunkSizes(total, min, max int) []int {
	var sizes []int
	var seed [8]byte
	_, _ = rand.Read(seed[:])
	state := uint64(seed[0]) | uint64(seed[1])<<8 | uint64(seed[2])<<16 | uint64(seed[3])<<24 |
		uint64(seed[4])<<32 | uint64(seed[5])<<40 | uint64(seed[6])<<48 | uint64(seed[7])<<56
	for total > 0 {
		state ^= state << 13
		state ^= state >> 7
		state ^= state << 17
		size := min + int(state%uint64(max-min+1))
		if size > total {
			size = total
		}
		sizes = append(sizes, size)
		total -= size
	}
	return sizes
}

// 64 MiB 随机数据入口 → 出口 → 回显 → 出口 → 入口，一个字节都不能错、不能少，
// 写的块大小从 1 字节到 256 KiB 乱跳，覆盖「一次读到好几帧」「一帧拆在两次读里」。
func TestTunnelRelaysLargeRandomStreamIntact(t *testing.T) {
	if testing.Short() {
		t.Skip("64 MiB transfer skipped in short mode")
	}
	const size = 64 << 20
	payload := make([]byte, size)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(payload)
	port := startEchoTunnel(t)
	conn := dialEntry(t, port)
	got, n := echoThroughTunnel(t, conn, payload, randomChunkSizes(size, 1, 256<<10))
	if n != size {
		t.Fatalf("echoed %d bytes, want %d", n, size)
	}
	if got != hex.EncodeToString(want[:]) {
		t.Fatalf("echo digest %s, want %s", got, hex.EncodeToString(want[:]))
	}
}

// 几千次 1–100 字节的小写，写完半关：小帧也要一个不落地回来，半关要传到底。
func TestTunnelRelaysManySmallWritesWithHalfClose(t *testing.T) {
	const writes = 3000
	chunks := randomChunkSizes(writes*100, 1, 100)[:writes]
	total := 0
	for _, size := range chunks {
		total += size
	}
	payload := make([]byte, total)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(payload)
	port := startEchoTunnel(t)
	conn := dialEntry(t, port)
	got, n := echoThroughTunnel(t, conn, payload, chunks)
	if n != total {
		t.Fatalf("echoed %d bytes, want %d", n, total)
	}
	if got != hex.EncodeToString(want[:]) {
		t.Fatalf("echo digest %s, want %s", got, hex.EncodeToString(want[:]))
	}
}

// 交互式的小写不能被攒着：一次 5 字节的写，没有后续数据也要马上回来。
func TestTunnelSmallWriteIsNotHeldBack(t *testing.T) {
	port := startEchoTunnel(t)
	conn := dialEntry(t, port)
	for round := 0; round < 20; round++ {
		msg := []byte("ping" + strconv.Itoa(round))
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := conn.Write(msg); err != nil {
			t.Fatal(err)
		}
		reply := make([]byte, len(msg))
		if _, err := io.ReadFull(conn, reply); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		if !bytes.Equal(reply, msg) {
			t.Fatalf("round %d: got %q want %q", round, reply, msg)
		}
	}
}

// BenchmarkTunnelLoopbackEcho 量入口 + 出口整条链路的吞吐：每次操作往隧道写 1 MiB
// 并把回显读回来，字节数按写入量算（线上实际是双向各 1 MiB）。
func BenchmarkTunnelLoopbackEcho(b *testing.B) {
	const chunk = 1 << 20
	payload := make([]byte, chunk)
	_, _ = rand.Read(payload)
	port := startEchoTunnel(b)
	conn := dialEntry(b, port)
	_ = conn.SetDeadline(time.Now().Add(5 * time.Minute))
	b.SetBytes(chunk)
	b.ResetTimer()
	done := make(chan error, 1)
	go func() {
		sink := make([]byte, 256<<10)
		remaining := int64(b.N) * chunk
		for remaining > 0 {
			n, err := conn.Read(sink)
			remaining -= int64(n)
			if err != nil {
				if remaining > 0 {
					done <- err
					return
				}
				break
			}
		}
		done <- nil
	}()
	for i := 0; i < b.N; i++ {
		if _, err := conn.Write(payload); err != nil {
			b.Fatal(err)
		}
	}
	if err := <-done; err != nil && !errors.Is(err, io.EOF) {
		b.Fatal(err)
	}
	b.StopTimer()
}
