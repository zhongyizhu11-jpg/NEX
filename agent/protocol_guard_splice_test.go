package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// tcpConnPair 返回一对互联的真实 TCP 连接（splice 只对 *net.TCPConn 生效）。
func tcpConnPair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := ln.Accept()
		accepted <- conn
	}()
	dialed, err := net.DialTimeout("tcp", ln.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	other := <-accepted
	if other == nil {
		t.Fatal("accept failed")
	}
	t.Cleanup(func() {
		_ = dialed.Close()
		_ = other.Close()
	})
	return dialed.(*net.TCPConn), other.(*net.TCPConn)
}

func guardTestPayload(size int) []byte {
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i*7 + i/251)
	}
	return payload
}

func waitPipeSpliced(t *testing.T, p *protocolGuardTCPPipe, want bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if p.spliced.Load() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("pipe spliced = %v, want %v", p.spliced.Load(), want)
}

// 没开协议拦截、没有限速：PROXY 协议解析时多读出来的字节先原样写出，随后整个
// 方向切到 splice，数据完整且顺序不变，源端 EOF 以 io.EOF 结束。
func TestProtocolGuardSplicesUnlimitedTCPAfterInitialBytes(t *testing.T) {
	server := newProtocolGuardServer(guardRule{RuleID: 51, ListenPort: 25001, RateLimitScope: t.Name()})
	defer server.close()
	peerClient, guardClient := tcpConnPair(t)
	guardTarget, peerTarget := tcpConnPair(t)
	pipe := &protocolGuardTCPPipe{src: guardClient, dst: guardTarget, direction: protocolGuardRateIn}
	initial := []byte("buffered-before-switch|")
	payload := guardTestPayload(6 * 1024 * 1024)

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.copyTCPToTargetWithGuard(context.Background(), Config{}, pipe, initial, newProtocolGuardInspection(protocolPolicy{}))
	}()
	go func() {
		_, _ = peerClient.Write(payload)
		_ = peerClient.CloseWrite()
	}()
	_ = peerTarget.SetReadDeadline(time.Now().Add(10 * time.Second))
	got, err := io.ReadAll(io.LimitReader(peerTarget, int64(len(initial)+len(payload))))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, append(append([]byte(nil), initial...), payload...)) {
		t.Fatalf("relayed %d bytes, content or order differs from %d expected", len(got), len(initial)+len(payload))
	}
	select {
	case err := <-errCh:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("copy ended with %v, want io.EOF", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("copy did not finish after source EOF")
	}
	if !pipe.spliced.Load() {
		t.Fatal("unlimited, uninspected TCP direction did not switch to splice")
	}
}

// 限速按方向判断：入方向有限速时入方向保持逐块限速循环，出方向照样 splice。
func TestProtocolGuardKeepsRateLimitedDirectionInLoop(t *testing.T) {
	server := newProtocolGuardServer(guardRule{RuleID: 52, ListenPort: 25002, RateLimitScope: t.Name(), LimitIn: 1 << 30})
	defer server.close()
	peerClient, guardClient := tcpConnPair(t)
	guardTarget, peerTarget := tcpConnPair(t)
	inspection := newProtocolGuardInspection(protocolPolicy{})
	in := &protocolGuardTCPPipe{src: guardClient, dst: guardTarget, direction: protocolGuardRateIn}
	out := &protocolGuardTCPPipe{src: guardTarget, dst: guardClient, direction: protocolGuardRateOut}
	go func() { _ = server.copyTCPToTargetWithGuard(context.Background(), Config{}, in, nil, inspection) }()
	go func() { _ = server.copyTCPToClientWithGuard(context.Background(), Config{}, out, inspection) }()

	payload := guardTestPayload(256 * 1024)
	go func() { _, _ = peerClient.Write(payload) }()
	go func() { _, _ = peerTarget.Write(payload) }()
	_ = peerTarget.SetReadDeadline(time.Now().Add(5 * time.Second))
	_ = peerClient.SetReadDeadline(time.Now().Add(5 * time.Second))
	for _, reader := range []io.Reader{peerTarget, peerClient} {
		got := make([]byte, len(payload))
		if _, err := io.ReadFull(reader, got); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatal("relayed payload differs")
		}
	}
	if in.spliced.Load() {
		t.Fatal("rate-limited inbound direction switched to splice")
	}
	waitPipeSpliced(t, out, true)
}

// 开了协议拦截：客户端样本收满（且不是 SOCKS 候选）之前必须逐块检测，之后才切 splice。
func TestProtocolGuardSplicesOnlyAfterClientInspectionFinishes(t *testing.T) {
	server := newProtocolGuardServer(guardRule{RuleID: 53, ListenPort: 25003, RateLimitScope: t.Name()})
	defer server.close()
	peerClient, guardClient := tcpConnPair(t)
	guardTarget, peerTarget := tcpConnPair(t)
	policy := protocolPolicy{BlockHTTP: true, BlockSocks: true}
	inspection := newProtocolGuardInspection(policy)
	in := &protocolGuardTCPPipe{src: guardClient, dst: guardTarget, direction: protocolGuardRateIn}
	out := &protocolGuardTCPPipe{src: guardTarget, dst: guardClient, direction: protocolGuardRateOut}
	go func() { _ = server.copyTCPToTargetWithGuard(context.Background(), Config{}, in, nil, inspection) }()
	go func() { _ = server.copyTCPToClientWithGuard(context.Background(), Config{}, out, inspection) }()
	_ = peerTarget.SetReadDeadline(time.Now().Add(5 * time.Second))
	_ = peerClient.SetReadDeadline(time.Now().Add(5 * time.Second))

	small := bytes.Repeat([]byte{0x42}, 100)
	if _, err := peerClient.Write(small); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(peerTarget, make([]byte, len(small))); err != nil {
		t.Fatal(err)
	}
	// 服务端方向在客户端检测结束前也要逐块看（SOCKS 确认靠服务端回包）。
	if _, err := peerTarget.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(peerClient, make([]byte, 5)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if in.spliced.Load() || out.spliced.Load() {
		t.Fatal("switched to splice before the client sample was complete")
	}

	rest := bytes.Repeat([]byte{0x43}, protocolGuardSampleMaxBytes)
	if _, err := peerClient.Write(rest); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(peerTarget, make([]byte, len(rest))); err != nil {
		t.Fatal(err)
	}
	waitPipeSpliced(t, in, true)
	// 服务端方向在下一块数据到来时切换。
	if _, err := peerTarget.Write([]byte("world")); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(peerClient, make([]byte, 5)); err != nil {
		t.Fatal(err)
	}
	waitPipeSpliced(t, out, true)
}

// 没开 SOCKS 拦截时服务端方向从一开始就不需要检测，可以直接 splice。
func TestProtocolGuardServerDirectionSplicesWithoutSocksPolicy(t *testing.T) {
	inspection := newProtocolGuardInspection(protocolPolicy{BlockTLS: true})
	if inspection.clientFinished() {
		t.Fatal("client inspection finished before any sample")
	}
	if !inspection.serverFinished() {
		t.Fatal("server direction needs inspection without a SOCKS policy")
	}
	socks := newProtocolGuardInspection(protocolPolicy{BlockSocks: true})
	if socks.serverFinished() {
		t.Fatal("server direction skipped SOCKS confirmation")
	}
}

// 拦截语义不变：HTTP 请求在切换前就被拦下，连接以拦截错误结束。
func TestProtocolGuardSpliceDoesNotBypassBlocking(t *testing.T) {
	server := newProtocolGuardServer(guardRule{RuleID: 54, ListenPort: 25004, RateLimitScope: t.Name()})
	defer server.close()
	peerClient, guardClient := tcpConnPair(t)
	guardTarget, _ := tcpConnPair(t)
	in := &protocolGuardTCPPipe{src: guardClient, dst: guardTarget, direction: protocolGuardRateIn}
	errCh := make(chan error, 1)
	go func() {
		errCh <- server.copyTCPToTargetWithGuard(context.Background(), Config{}, in, nil, newProtocolGuardInspection(protocolPolicy{BlockHTTP: true}))
	}()
	if _, err := peerClient.Write([]byte("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "protocol blocked: http") {
			t.Fatalf("copy error = %v, want http block", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("HTTP request was not blocked")
	}
	if in.spliced.Load() {
		t.Fatal("blocked connection switched to splice")
	}
}

// 热更新给已经在 splice 的连接挂上限速：最多再放过一块，之后回到逐块限速循环。
func TestProtocolGuardSpliceFallsBackWhenLimitHotAdded(t *testing.T) {
	rule := guardRule{RuleID: 55, ListenPort: 25005, RateLimitScope: t.Name()}
	server := newProtocolGuardServer(rule)
	defer server.close()
	peerClient, guardClient := tcpConnPair(t)
	guardTarget, peerTarget := tcpConnPair(t)
	in := &protocolGuardTCPPipe{src: guardClient, dst: guardTarget, direction: protocolGuardRateIn}
	go func() {
		_ = server.copyTCPToTargetWithGuard(context.Background(), Config{}, in, nil, newProtocolGuardInspection(protocolPolicy{}))
	}()
	waitPipeSpliced(t, in, true)

	limited := rule
	limited.LimitIn = 1024 * 1024
	server.updateRateLimits(limited)
	limiter := server.rateLimiter(protocolGuardRateIn)
	if limiter == nil {
		t.Fatal("hot update did not attach the limiter")
	}
	burst := protocolGuardRateBurst(limited.LimitIn)
	payload := guardTestPayload(protocolGuardSpliceChunk + 4*burst)
	go func() { _, _ = peerClient.Write(payload) }()
	_ = peerTarget.SetReadDeadline(time.Now().Add(15 * time.Second))
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(peerTarget, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("payload changed while switching back from splice")
	}
	limiter.mu.Lock()
	tokens := limiter.limiter.Tokens()
	limiter.mu.Unlock()
	if tokens >= float64(burst) {
		t.Fatalf("bytes after the in-flight chunk bypassed the hot-added limiter: tokens=%f burst=%d", tokens, burst)
	}
}

// 半关闭时剩下的方向正阻塞在 splice 里：要被踢回逐块循环，之后有数据在走就一直转发，
// 哪怕总时长远超 linger；完全空闲超过 linger 才收掉整条连接。
func TestProtocolGuardHalfCloseLingerWithSplice(t *testing.T) {
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	const spurts = 12
	targetDone := make(chan struct{})
	go func() {
		defer close(targetDone)
		c, err := targetLn.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		if _, err := io.ReadAll(c); err != nil {
			return
		}
		// 每 100 ms 一小段，总共 1.2 s，远超 200 ms 的 linger；然后不关连接、彻底空闲。
		for i := 0; i < spurts; i++ {
			if _, err := c.Write([]byte{byte(i)}); err != nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		_, _ = io.Copy(io.Discard, c)
	}()
	targetAddr := targetLn.Addr().(*net.TCPAddr)
	guardLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &protocolGuardServer{
		rule: guardRule{
			RuleID: 56, ListenPort: guardLn.Addr().(*net.TCPAddr).Port,
			TargetIP: targetAddr.IP.String(), TargetPort: targetAddr.Port, Protocol: "tcp",
		},
		tcpLn:           guardLn,
		done:            make(chan struct{}),
		halfCloseLinger: 200 * time.Millisecond,
	}
	go server.serveTCP(Config{})
	defer server.close()

	client, err := net.DialTimeout("tcp", guardLn.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := client.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	got, err := io.ReadAll(client)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if len(got) != spurts {
		t.Fatalf("received %d / %d spurts before linger closed the connection", len(got), spurts)
	}
	// 最后一段之后完全空闲：最多约 2*linger 就应该收掉，而不是等对端关闭。
	if elapsed := time.Since(start); elapsed > spurts*100*time.Millisecond+2*time.Second {
		t.Fatalf("idle half-closed connection lingered %v", elapsed)
	}
	select {
	case <-targetDone:
	case <-time.After(2 * time.Second):
		t.Fatal("guard did not close the idle target after linger")
	}
}

// 半关闭以后剩下的方向写不出去（客户端不读了）：和以前一样按字节计数判空闲收掉，
// 不能因为它之前在 splice 里卡着写就永远挂住。
func TestProtocolGuardHalfCloseReapsStalledWriterAfterSplice(t *testing.T) {
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	writerDone := make(chan error, 1)
	go func() {
		c, err := targetLn.Accept()
		if err != nil {
			writerDone <- err
			return
		}
		defer c.Close()
		chunk := make([]byte, 64*1024)
		// 先在客户端半关闭之前就开始大量回写，让这个方向进入 splice。
		for {
			if _, err := c.Write(chunk); err != nil {
				writerDone <- err
				return
			}
		}
	}()
	targetAddr := targetLn.Addr().(*net.TCPAddr)
	guardLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &protocolGuardServer{
		rule: guardRule{
			RuleID: 58, ListenPort: guardLn.Addr().(*net.TCPAddr).Port,
			TargetIP: targetAddr.IP.String(), TargetPort: targetAddr.Port, Protocol: "tcp",
		},
		tcpLn:           guardLn,
		done:            make(chan struct{}),
		halfCloseLinger: 200 * time.Millisecond,
	}
	go server.serveTCP(Config{})
	defer server.close()

	client, err := net.DialTimeout("tcp", guardLn.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(client, make([]byte, 128*1024)); err != nil {
		t.Fatal(err)
	}
	// 客户端半关闭后再也不读：缓冲区写满以后服务端方向没有进展，应当在几个 linger 周期内被收掉。
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-writerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("stalled half-closed connection was never reaped")
	}
}

func TestProtocolGuardRateBurstReachesHighRates(t *testing.T) {
	// 1 Gbps ≈ 125 MB/s：100 ms 的突发应该能用到 4 MiB 上限，而不是被截断在 1 MiB。
	if got := protocolGuardRateBurst(125_000_000); got != 4*1024*1024 {
		t.Fatalf("1 Gbps burst = %d, want %d", got, 4*1024*1024)
	}
	if got := protocolGuardRateBurst(20 * 1024 * 1024); got != 2*1024*1024 {
		t.Fatalf("20 MiB/s burst = %d, want 2 MiB (rate/10, below the cap)", got)
	}
}

func TestProtocolGuardUDPEvictsLeastRecentlyUsedIdleSession(t *testing.T) {
	now := time.Now()
	newSession := func(idle time.Duration) *protocolGuardUDPSession {
		a, b := net.Pipe()
		t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
		session := &protocolGuardUDPSession{target: a}
		session.touch(now.Add(-idle))
		return session
	}
	sessions := map[string]*protocolGuardUDPSession{
		"active":  newSession(time.Second),
		"idle":    newSession(protocolGuardUDPEvictMinIdle + time.Second),
		"oldest":  newSession(protocolGuardUDPEvictMinIdle + time.Minute),
		"recent2": newSession(2 * time.Second),
	}
	evicted := evictProtocolGuardUDPSessionLocked(sessions, now)
	if evicted == nil || sessions["oldest"] != nil {
		t.Fatalf("expected the least recently used idle session to be evicted, got %v", evicted)
	}
	if len(sessions) != 3 {
		t.Fatalf("eviction removed %d sessions, want 1", 4-len(sessions))
	}

	busy := map[string]*protocolGuardUDPSession{
		"a": newSession(time.Second),
		"b": newSession(protocolGuardUDPEvictMinIdle / 2),
	}
	if evicted := evictProtocolGuardUDPSessionLocked(busy, now); evicted != nil || len(busy) != 2 {
		t.Fatal("evicted an active session; a flood of new sources must not displace live sessions")
	}
}

func TestProtocolGuardUDPRelaysPerSourceSessions(t *testing.T) {
	target, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := target.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = target.WriteTo(append([]byte("echo:"), buf[:n]...), addr)
		}
	}()
	listener, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	targetAddr := target.LocalAddr().(*net.UDPAddr)
	server := newProtocolGuardServer(guardRule{
		RuleID: 57, ListenPort: listener.LocalAddr().(*net.UDPAddr).Port,
		TargetIP: "127.0.0.1", TargetPort: targetAddr.Port, Protocol: "udp", RateLimitScope: t.Name(),
	})
	server.udpConn = listener
	go server.serveUDP()
	defer server.close()

	clients := make([]net.Conn, 3)
	for i := range clients {
		conn, err := net.Dial("udp", listener.LocalAddr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		clients[i] = conn
	}
	for round := 0; round < 3; round++ {
		for i, conn := range clients {
			message := []byte{byte('a' + i), byte('0' + round)}
			if _, err := conn.Write(message); err != nil {
				t.Fatal(err)
			}
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			buf := make([]byte, 64)
			n, err := conn.Read(buf)
			if err != nil {
				t.Fatalf("client %d round %d: %v", i, round, err)
			}
			if want := "echo:" + string(message); string(buf[:n]) != want {
				t.Fatalf("client %d got %q, want %q", i, buf[:n], want)
			}
		}
	}
}
