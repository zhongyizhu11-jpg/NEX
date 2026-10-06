package main

import (
	"bytes"
	"crypto/rand"
	"net"
	"strings"
	"testing"
	"time"
)

// loopbackTCPPair 开一对回环 TCP 连接。流水线握手的用例要用真 TCP：net.Pipe
// 的写要等对面读完才返回，而流水线握手正是「写了还没读就先写下一帧」。
func loopbackTCPPair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			accepted <- nil
			return
		}
		accepted <- conn
	}()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server := <-accepted
	if server == nil {
		_ = client.Close()
		t.Fatal("accept failed")
	}
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	return client.(*net.TCPConn), server.(*net.TCPConn)
}

// forcePreferredAEAD 固定本机偏好，不跑实测。
func forcePreferredAEAD(t *testing.T, name string) {
	t.Helper()
	fxpAEADOverrideMu.Lock()
	previous := fxpAEADPreferredOverride
	fxpAEADPreferredOverride = name
	fxpAEADOverrideMu.Unlock()
	t.Cleanup(func() {
		fxpAEADOverrideMu.Lock()
		fxpAEADPreferredOverride = previous
		fxpAEADOverrideMu.Unlock()
	})
}

// legacyClientOffer 模拟旧版本客户端：握手里不报 aeads。
func legacyClientOffer(t *testing.T) {
	t.Helper()
	previous := fxpOfferedAEADs
	fxpOfferedAEADs = func(config) []string { return nil }
	t.Cleanup(func() { fxpOfferedAEADs = previous })
}

// handshakeOverPipe 让客户端和服务端在 net.Pipe 上握完手，返回两端。
func handshakeOverPipe(t *testing.T, clientCfg, serverCfg config) (*secureConn, *secureConn) {
	t.Helper()
	clientConn, serverConn := net.Pipe()
	t.Cleanup(func() { _ = clientConn.Close(); _ = serverConn.Close() })
	type result struct {
		sec *secureConn
		err error
	}
	serverDone := make(chan result, 1)
	go func() {
		sec, err := newServerSecureConn(serverConn, serverCfg)
		serverDone <- result{sec, err}
	}()
	client, err := newClientSecureConnWithWire(clientConn, clientCfg, fxpWireCurrent)
	if err != nil {
		t.Fatalf("client handshake: %v", err)
	}
	server := <-serverDone
	if server.err != nil {
		t.Fatalf("server handshake: %v", server.err)
	}
	return client, server.sec
}

// exchangeFrames 两个方向各传一帧，证明两端的会话密钥和算法对得上。
func exchangeFrames(t *testing.T, client, server *secureConn) {
	t.Helper()
	payload := make([]byte, 48*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []struct {
		name     string
		from, to *secureConn
	}{{"client->server", client, server}, {"server->client", server, client}} {
		got := make(chan []byte, 1)
		errCh := make(chan error, 1)
		go func() {
			frame, err := dir.to.readFrame()
			if err != nil {
				errCh <- err
				return
			}
			got <- append([]byte(nil), frame...)
		}()
		if err := dir.from.writeFrame(payload); err != nil {
			t.Fatalf("%s write: %v", dir.name, err)
		}
		select {
		case frame := <-got:
			if !bytes.Equal(frame, payload) {
				t.Fatalf("%s: frame corrupted", dir.name)
			}
		case err := <-errCh:
			t.Fatalf("%s read: %v", dir.name, err)
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: frame never arrived", dir.name)
		}
	}
}

func TestFxpAEADNegotiatesChaChaWhenTheClientPrefersIt(t *testing.T) {
	forcePreferredAEAD(t, fxpAEADAESGCM)
	cfg := config{Role: "exit", TunnelID: 501, ListenPort: 1, Key: "aead-test-key"}
	clientCfg := cfg
	clientCfg.AEAD = "chacha20-poly1305"
	client, server := handshakeOverPipe(t, clientCfg, cfg)
	if client.aead != fxpAEADChaCha20 || server.aead != fxpAEADChaCha20 {
		t.Fatalf("expected chacha20-poly1305 on both ends, got client=%q server=%q", client.aead, server.aead)
	}
	exchangeFrames(t, client, server)
}

func TestFxpAEADNegotiatesChaChaWhenTheServerPrefersIt(t *testing.T) {
	// 没有 AES 硬件的是服务端：客户端报的列表里 AES 在前，服务端照样可以选 ChaCha20。
	forcePreferredAEAD(t, fxpAEADChaCha20)
	cfg := config{Role: "exit", TunnelID: 502, ListenPort: 1, Key: "aead-test-key"}
	clientCfg := cfg
	clientCfg.AEAD = "aes-gcm"
	client, server := handshakeOverPipe(t, clientCfg, cfg)
	if client.aead != fxpAEADChaCha20 || server.aead != fxpAEADChaCha20 {
		t.Fatalf("expected the server's preference to win, got client=%q server=%q", client.aead, server.aead)
	}
	exchangeFrames(t, client, server)
}

func TestFxpAEADStaysAESWhenBothPreferIt(t *testing.T) {
	forcePreferredAEAD(t, fxpAEADAESGCM)
	cfg := config{Role: "exit", TunnelID: 503, ListenPort: 1, Key: "aead-test-key"}
	client, server := handshakeOverPipe(t, cfg, cfg)
	if client.aead != "" || server.aead != "" {
		t.Fatalf("expected AES-256-GCM (empty) on both ends, got client=%q server=%q", client.aead, server.aead)
	}
	exchangeFrames(t, client, server)
}

func TestFxpAEADServerConfigOverridesClientPreference(t *testing.T) {
	forcePreferredAEAD(t, fxpAEADChaCha20)
	cfg := config{Role: "exit", TunnelID: 504, ListenPort: 1, Key: "aead-test-key"}
	serverCfg := cfg
	serverCfg.AEAD = "aes-gcm"
	client, server := handshakeOverPipe(t, cfg, serverCfg)
	if client.aead != "" || server.aead != "" {
		t.Fatalf("server pinned aes-gcm, got client=%q server=%q", client.aead, server.aead)
	}
	exchangeFrames(t, client, server)
}

func TestFxpAEADLegacyClientKeepsAES(t *testing.T) {
	// 旧版本客户端不报 aeads：服务端就算偏好 ChaCha20 也只能用 AES-256-GCM。
	forcePreferredAEAD(t, fxpAEADChaCha20)
	legacyClientOffer(t)
	cfg := config{Role: "exit", TunnelID: 505, ListenPort: 1, Key: "aead-test-key"}
	client, server := handshakeOverPipe(t, cfg, cfg)
	if client.aead != "" || server.aead != "" {
		t.Fatalf("legacy client must stay on AES-256-GCM, got client=%q server=%q", client.aead, server.aead)
	}
	exchangeFrames(t, client, server)
}

func TestFxpAEADPipelinedHandshakeSwitchesAfterTheAck(t *testing.T) {
	// 流水线握手：客户端在收到确认之前就用首轮密钥（AES）写了 hello 和首包，
	// 收到确认之后才换成 ChaCha20。服务端两种都要认，而且顺序不能乱。
	forcePreferredAEAD(t, fxpAEADChaCha20)
	cfg := config{Role: "exit", TunnelID: 506, ListenPort: 1, Key: "aead-test-key"}
	clientConn, serverConn := loopbackTCPPair(t)
	client, err := newPipelinedClientSecureConn(clientConn, cfg, fxpWireCurrent)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan string, 4)
	serverErr := make(chan error, 1)
	go func() {
		server, err := newServerSecureConn(serverConn, cfg)
		if err != nil {
			serverErr <- err
			return
		}
		for i := 0; i < 3; i++ {
			frame, err := server.readFrame()
			if err != nil {
				serverErr <- err
				return
			}
			received <- string(frame)
		}
		if server.aead != fxpAEADChaCha20 {
			serverErr <- errorString("server did not switch to chacha20-poly1305")
			return
		}
		serverErr <- nil
	}()
	// 两帧跟着握手一起出去（首轮密钥），然后读确认，再写第三帧（会话密钥）。
	if err := client.writeFrames([]byte("hello"), []byte("first-payload")); err != nil {
		t.Fatal(err)
	}
	if err := client.consumeHandshakeAck(); err != nil {
		t.Fatal(err)
	}
	if client.aead != fxpAEADChaCha20 {
		t.Fatalf("client did not switch, aead=%q", client.aead)
	}
	if err := client.writeFrame([]byte("after-ack")); err != nil {
		t.Fatal(err)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
	got := []string{<-received, <-received, <-received}
	if strings.Join(got, ",") != "hello,first-payload,after-ack" {
		t.Fatalf("frames out of order or corrupted: %v", got)
	}
}

type errorString string

func (e errorString) Error() string { return string(e) }

func TestFxpAEADChoice(t *testing.T) {
	forcePreferredAEAD(t, fxpAEADAESGCM)
	auto := config{}
	if got := chooseAEAD(auto, nil); got != fxpAEADAESGCM {
		t.Fatalf("legacy client: got %q", got)
	}
	if got := chooseAEAD(auto, []string{"nonsense"}); got != fxpAEADAESGCM {
		t.Fatalf("unknown offer: got %q", got)
	}
	if got := chooseAEAD(auto, []string{fxpAEADChaCha20, fxpAEADAESGCM}); got != fxpAEADChaCha20 {
		t.Fatalf("client prefers chacha: got %q", got)
	}
	if got := chooseAEAD(auto, []string{fxpAEADAESGCM, fxpAEADChaCha20}); got != fxpAEADAESGCM {
		t.Fatalf("both prefer aes: got %q", got)
	}
	pinned := config{AEAD: fxpAEADChaCha20}
	if got := chooseAEAD(pinned, []string{fxpAEADAESGCM}); got != fxpAEADAESGCM {
		t.Fatalf("pinned chacha but client cannot: got %q", got)
	}
	if got := chooseAEAD(pinned, []string{fxpAEADAESGCM, fxpAEADChaCha20}); got != fxpAEADChaCha20 {
		t.Fatalf("pinned chacha: got %q", got)
	}
	forcePreferredAEAD(t, fxpAEADChaCha20)
	if got := chooseAEAD(auto, []string{fxpAEADAESGCM, fxpAEADChaCha20}); got != fxpAEADChaCha20 {
		t.Fatalf("server prefers chacha: got %q", got)
	}
}

func TestNormalizeAEADConfig(t *testing.T) {
	for input, want := range map[string]string{
		"": "", "auto": "", "garbage": "",
		"aes": fxpAEADAESGCM, "AES-GCM": fxpAEADAESGCM, "aes-256-gcm": fxpAEADAESGCM,
		"chacha": fxpAEADChaCha20, "ChaCha20-Poly1305": fxpAEADChaCha20, "chacha20poly1305": fxpAEADChaCha20,
	} {
		if got := normalizeAEADConfig(input); got != want {
			t.Errorf("normalizeAEADConfig(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestMeasureAEADPreferenceReturnsBothRates(t *testing.T) {
	measured := measureAEADPreference()
	if measured.aesBytesPerSecond <= 0 || measured.chachaBytesPerSecond <= 0 {
		t.Fatalf("measurement failed: %+v", measured)
	}
	if measured.preferred != fxpAEADAESGCM && measured.preferred != fxpAEADChaCha20 {
		t.Fatalf("unexpected preference %q", measured.preferred)
	}
}

// bufferConn 是单协程用的内存连接：写进去的字节马上能读出来。给基准测试量
// 单核封解帧的吞吐。
type bufferConn struct {
	net.Conn
	buf bytes.Buffer
}

func (c *bufferConn) Write(p []byte) (int, error) { return c.buf.Write(p) }
func (c *bufferConn) Read(p []byte) (int, error)  { return c.buf.Read(p) }

func benchmarkSecureFrames(b *testing.B, aead string) {
	salt := make([]byte, fxpSaltSize)
	conn := &bufferConn{}
	writer, err := newSessionSecureConn(conn, "bench-key", salt, true)
	if err != nil {
		b.Fatal(err)
	}
	reader, err := newSessionSecureConn(conn, "bench-key", salt, false)
	if err != nil {
		b.Fatal(err)
	}
	master := writer.handshakeMaster
	if master == nil {
		master = make([]byte, 32)
	}
	keys, err := deriveFXPSessionAEADs(master, salt, fxpNegotiatedSessionInfo(fxpWireCurrent, aead), fxpWireCurrent, aead)
	if err != nil {
		b.Fatal(err)
	}
	writer.lenWriteAEAD, writer.dataWriteAEAD = keys.c2sLen, keys.c2sData
	reader.lenReadAEAD, reader.dataReadAEAD = keys.c2sLen, keys.c2sData
	payload := make([]byte, fxpCopyChunkSize)
	_, _ = rand.Read(payload)
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := writer.writeFrame(payload); err != nil {
			b.Fatal(err)
		}
		if _, err := reader.readFrame(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkSecureFramesAESGCM(b *testing.B)   { benchmarkSecureFrames(b, fxpAEADAESGCM) }
func BenchmarkSecureFramesChaCha20(b *testing.B) { benchmarkSecureFrames(b, fxpAEADChaCha20) }
