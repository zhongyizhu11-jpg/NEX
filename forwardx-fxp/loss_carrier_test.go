package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"math/rand"
	"net"
	"strings"
	"testing"
	"time"

	kcp "github.com/xtaci/kcp-go/v5"
)

const lcTestKey = "loss-carrier-test-key"

// startLossCarrierListener 起一个抗丢包监听：真的 UDP 套接字 + 只替它收包的读循环。
func startLossCarrierListener(tb testing.TB, cfg config) (*lossCarrierListener, int) {
	tb.Helper()
	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		tb.Fatal(err)
	}
	_ = udp.SetReadBuffer(4 << 20)
	port := udp.LocalAddr().(*net.UDPAddr).Port
	ln, err := listenLossCarrier("127.0.0.1", port, cfg)
	if err != nil {
		tb.Fatal(err)
	}
	go func() { _ = serveLossCarrierUDP(udp, ln.registryKey) }()
	tb.Cleanup(func() {
		_ = ln.Close()
		ln.finalize()
		_ = udp.Close()
	})
	return ln, port
}

func lcTestConfig() config {
	return config{TunnelID: 31, Key: lcTestKey}
}

func lcTestPayload(size int, seed int64) []byte {
	payload := make([]byte, size)
	rand.New(rand.NewSource(seed)).Read(payload)
	return payload
}

// lcAcceptOne 接一条连接，超时算失败。
func lcAcceptOne(tb testing.TB, ln *lossCarrierListener) net.Conn {
	tb.Helper()
	type result struct {
		conn net.Conn
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		conn, err := ln.Accept()
		ch <- result{conn, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			tb.Fatalf("accept: %v", r.err)
		}
		return r.conn
	case <-time.After(10 * time.Second):
		tb.Fatal("accept timed out")
		return nil
	}
}

func TestLossCarrierStreamsBothWaysAndClosesCleanly(t *testing.T) {
	cfg := lcTestConfig()
	ln, port := startLossCarrierListener(t, cfg)
	client, err := dialLossCarrier("127.0.0.1", port, 3*time.Second, cfg)
	if err != nil {
		t.Fatalf("没有丢包时应该能连上: %v", err)
	}
	defer client.Close()
	// KCP 会话是第一个数据包带起来的，先写再接。
	up := lcTestPayload(300_000, 1)
	down := lcTestPayload(700_000, 2)
	writeErr := make(chan error, 1)
	go func() {
		_, err := client.Write(up)
		writeErr <- err
	}()
	server := lcAcceptOne(t, ln)
	defer server.Close()
	gotUp := make([]byte, len(up))
	if _, err := io.ReadFull(server, gotUp); err != nil {
		t.Fatalf("服务端读: %v", err)
	}
	if err := <-writeErr; err != nil {
		t.Fatalf("客户端写: %v", err)
	}
	if !bytes.Equal(gotUp, up) {
		t.Fatal("上行数据不一致")
	}
	// 服务端写完马上关：尾巴上的数据必须由后台送完，客户端读到的是完整数据加 EOF。
	if _, err := server.Write(down); err != nil {
		t.Fatalf("服务端写: %v", err)
	}
	_ = server.Close()
	gotDown, err := io.ReadAll(client)
	if err != nil {
		t.Fatalf("客户端应该读到 EOF，而不是错误: %v", err)
	}
	if !bytes.Equal(gotDown, down) {
		t.Fatalf("写完就关时下行数据不完整: got %d want %d", len(gotDown), len(down))
	}
	// 对端关了以后再写，应该是「对端关了」这一类错误，上层按连接关闭处理。
	if _, err := client.Write([]byte("late")); err == nil || !isClosedErr(err) {
		t.Fatalf("对端关闭后写应该报连接已关，实际: %v", err)
	}
}

func lcRunLossyTransfer(t *testing.T, network lossyNetConfig, size int) {
	t.Helper()
	stats := useLossyNetwork(t, network)
	snmpBefore := kcp.DefaultSnmp.Copy()
	cfg := lcTestConfig()
	ln, port := startLossCarrierListener(t, cfg)
	client, err := dialLossCarrier("127.0.0.1", port, 10*time.Second, cfg)
	if err != nil {
		t.Fatalf("有丢包时也应该能连上（OPEN 会重发）: %v", err)
	}
	defer client.Close()
	up := lcTestPayload(size, 11)
	down := lcTestPayload(size, 12)
	errs := make(chan error, 4)
	go func() {
		_, err := client.Write(up)
		errs <- err
	}()
	server := lcAcceptOne(t, ln)
	defer server.Close()
	go func() {
		_, err := server.Write(down)
		errs <- err
	}()
	sums := make(chan [2][sha256.Size]byte, 1)
	go func() {
		var out [2][sha256.Size]byte
		got := make([]byte, size)
		_, err := io.ReadFull(server, got)
		out[0] = sha256.Sum256(got)
		errs <- err
		sums <- out
	}()
	gotDown := make([]byte, size)
	_ = client.SetReadDeadline(time.Now().Add(90 * time.Second))
	if _, err := io.ReadFull(client, gotDown); err != nil {
		t.Fatalf("丢包 %.0f%% 时下行读断了: %v", network.loss*100, err)
	}
	for i := 0; i < 3; i++ {
		select {
		case err := <-errs:
			if err != nil {
				t.Fatalf("丢包 %.0f%% 时连接断了: %v", network.loss*100, err)
			}
		case <-time.After(90 * time.Second):
			t.Fatal("传输超时")
		}
	}
	gotUp := <-sums
	if gotUp[0] != sha256.Sum256(up) {
		t.Fatal("上行校验和不一致")
	}
	if sha256.Sum256(gotDown) != sha256.Sum256(down) {
		t.Fatal("下行校验和不一致")
	}
	if network.loss > 0 {
		lostUp := 1 - float64(stats.sentOK.Load())/float64(stats.sent.Load())
		lostDown := 1 - float64(stats.recvOK.Load())/float64(stats.recv.Load())
		snmp := kcp.DefaultSnmp.Copy()
		t.Logf("丢包 %.0f%%：上行包 %d（实际丢 %.1f%%），下行包 %d（实际丢 %.1f%%），线上字节 / 有效字节 = %.2f；发出段 %d、重传 %d（快速 %d、超时 %d）、纠错补回 %d",
			network.loss*100, stats.sent.Load(), lostUp*100, stats.recv.Load(), lostDown*100,
			float64(stats.bytesTx.Load()+stats.bytesRx.Load())/float64(2*size),
			snmp.OutSegs-snmpBefore.OutSegs, snmp.RetransSegs-snmpBefore.RetransSegs,
			snmp.FastRetransSegs-snmpBefore.FastRetransSegs+snmp.EarlyRetransSegs-snmpBefore.EarlyRetransSegs,
			snmp.LostSegs-snmpBefore.LostSegs, snmp.FECRecovered-snmpBefore.FECRecovered)
		// 有损网络真的在丢，不是摆设。
		if lostUp < network.loss/2 || lostDown < network.loss/2 {
			t.Fatalf("有损网络没按 %.0f%% 丢包: up=%.3f down=%.3f", network.loss*100, lostUp, lostDown)
		}
	}
}

func TestLossCarrierKeepsDataIntactUnderFivePercentLoss(t *testing.T) {
	lcRunLossyTransfer(t, lossyNetConfig{loss: 0.05, delay: 10 * time.Millisecond, jitter: 4 * time.Millisecond, reorder: 0.05, reorderExtra: 15 * time.Millisecond, seed: 5}, 6<<20)
}

func TestLossCarrierKeepsDataIntactUnderFifteenPercentLoss(t *testing.T) {
	lcRunLossyTransfer(t, lossyNetConfig{loss: 0.15, delay: 10 * time.Millisecond, jitter: 4 * time.Millisecond, reorder: 0.05, reorderExtra: 15 * time.Millisecond, seed: 15}, 6<<20)
}

func TestLossCarrierDeliversTailWhenWriterClosesUnderLoss(t *testing.T) {
	// 写完就关 + 15% 丢包：最后几段数据和 FIN 都可能丢，读的一方仍然要拿到每一个字节。
	useLossyNetwork(t, lossyNetConfig{loss: 0.15, delay: 5 * time.Millisecond, jitter: 3 * time.Millisecond, seed: 77})
	cfg := lcTestConfig()
	ln, port := startLossCarrierListener(t, cfg)
	for round := 0; round < 5; round++ {
		client, err := dialLossCarrier("127.0.0.1", port, 10*time.Second, cfg)
		if err != nil {
			t.Fatal(err)
		}
		payload := lcTestPayload(200_000+round*37, int64(100+round))
		if _, err := client.Write(payload); err != nil {
			t.Fatal(err)
		}
		_ = client.Close()
		server := lcAcceptOne(t, ln)
		_ = server.SetReadDeadline(time.Now().Add(60 * time.Second))
		got, err := io.ReadAll(server)
		if err != nil {
			t.Fatalf("第 %d 轮：应该读到 EOF: %v", round, err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("第 %d 轮：写完就关丢了尾巴 got=%d want=%d", round, len(got), len(payload))
		}
		_ = server.Close()
	}
}

func TestLossCarrierDialFailsLoudlyWhenPeerDoesNotAnswer(t *testing.T) {
	cfg := lcTestConfig()
	// 1. UDP 口上没人听：ICMP 顶回来，马上报 refused，不等满超时。
	free, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	closedPort := free.LocalAddr().(*net.UDPAddr).Port
	_ = free.Close()
	started := time.Now()
	_, err = dialLossCarrier("127.0.0.1", closedPort, 5*time.Second, cfg)
	var dialErr *lossCarrierDialError
	if !errors.As(err, &dialErr) || !dialErr.refused {
		t.Fatalf("端口没人听应该报 refused，实际: %v", err)
	}
	if time.Since(started) > 3*time.Second {
		t.Fatalf("refused 不该等满超时: %s", time.Since(started))
	}
	// 2. 有人听但不答（防火墙丢包、对端没开这个模式、密钥不对都是这个样子）：超时报错，
	// 错误里写明是哪个 UDP 地址、可能的原因。
	silent, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	_, err = dialLossCarrier("127.0.0.1", silent.LocalAddr().(*net.UDPAddr).Port, 800*time.Millisecond, cfg)
	if !errors.As(err, &dialErr) || dialErr.refused || !dialErr.Timeout() {
		t.Fatalf("对端不答应该是超时错误，实际: %v", err)
	}
	if !strings.Contains(err.Error(), "firewall") || !strings.Contains(err.Error(), "udp 127.0.0.1:") {
		t.Fatalf("错误文字要能让人看出原因: %q", err.Error())
	}
	if got := connStatsErrorText(err); !strings.Contains(got, "loss-tolerant") {
		t.Fatalf("连接监控里应该看得到是抗丢包传输没连上，实际: %q", got)
	}
	// 3. 密钥不对：对端不答，一样是超时，而且对端一项状态都不留。
	ln, port := startLossCarrierListener(t, cfg)
	wrong := cfg
	wrong.Key = "another-key"
	if _, err := dialLossCarrier("127.0.0.1", port, 600*time.Millisecond, wrong); err == nil {
		t.Fatal("密钥不对不应该连上")
	}
	ln.mu.RLock()
	peers := len(ln.peers)
	ln.mu.RUnlock()
	if peers != 0 {
		t.Fatalf("没通过认证的 OPEN 不该在监听上留下状态: %d", peers)
	}
}

func TestLossCarrierIgnoresPacketsFromUnopenedSources(t *testing.T) {
	cfg := lcTestConfig()
	ln, port := startLossCarrierListener(t, cfg)
	raw, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	// 没 OPEN 过就直接发数据包（标签是瞎填的）：不建会话，回一个 RESET。
	forged := append([]byte(lossCarrierMagic), lcTypeData)
	forged = append(forged, make([]byte, 200)...)
	if _, err := raw.Write(forged); err != nil {
		t.Fatal(err)
	}
	_ = raw.SetReadDeadline(time.Now().Add(2 * time.Second))
	reply := make([]byte, 2048)
	n, err := raw.Read(reply)
	if err != nil {
		t.Fatalf("应该收到 RESET: %v", err)
	}
	header, ok := lcParse(reply[:n])
	if !ok || header.typ != lcTypeReset {
		t.Fatalf("回的不是 RESET: %x", reply[:n])
	}
	ln.mu.RLock()
	peers := len(ln.peers)
	ln.mu.RUnlock()
	if peers != 0 {
		t.Fatalf("没 OPEN 过的来源不该建会话: %d", peers)
	}
	select {
	case conn := <-ln.accepts:
		_ = conn.Close()
		t.Fatal("伪造的数据包不该被接成连接")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestLossCarrierResetsStaleSessionAfterPeerRestart(t *testing.T) {
	cfg := lcTestConfig()
	ln, port := startLossCarrierListener(t, cfg)
	client, err := dialLossCarrier("127.0.0.1", port, 3*time.Second, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	server := lcAcceptOne(t, ln)
	buf := make([]byte, 16)
	if _, err := io.ReadFull(server, buf[:5]); err != nil {
		t.Fatal(err)
	}
	if !client.(*lossCarrierConn).alive() {
		t.Fatal("刚连上的连接应该是活的")
	}
	// 模拟对端重启：监听上关于这条会话的一切都没了。
	ln.mu.Lock()
	for addr := range ln.peers {
		delete(ln.peers, addr)
	}
	ln.mu.Unlock()
	// 再发任何东西，对端回 RESET，卡着的读立刻带着「连接被重置」返回。
	if _, err := client.Write([]byte("again")); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, err = client.Read(buf)
	if err == nil || !strings.Contains(err.Error(), "reset") {
		t.Fatalf("对端不认识这条会话时应该报 reset，实际: %v", err)
	}
	if client.(*lossCarrierConn).alive() {
		t.Fatal("被重置的连接不能再发给用户")
	}
}

func TestLossCarrierReadDeadlineStillWorks(t *testing.T) {
	cfg := lcTestConfig()
	_, port := startLossCarrierListener(t, cfg)
	client, err := dialLossCarrier("127.0.0.1", port, 3*time.Second, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	_, err = client.Read(make([]byte, 8))
	netErr, ok := err.(net.Error)
	if !ok || !netErr.Timeout() {
		t.Fatalf("读超时应该是 net.Error 的超时（上层直接断言类型），实际: %T %v", err, err)
	}
}
