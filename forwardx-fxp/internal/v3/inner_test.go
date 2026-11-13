package v3

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"errors"
	"io"
	"math/big"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

// TestHKDFSHA256MatchesRFC5869 uses the RFC 5869 test vector for SHA-256
// (test case 1), so the hand-written HKDF is checked against the specification
// rather than against itself.
func TestHKDFSHA256MatchesRFC5869(t *testing.T) {
	ikm, _ := hex.DecodeString("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
	salt, _ := hex.DecodeString("000102030405060708090a0b0c")
	info, _ := hex.DecodeString("f0f1f2f3f4f5f6f7f8f9")
	want, _ := hex.DecodeString("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
	got := hkdfSHA256(ikm, salt, info, 42)
	if !bytes.Equal(got, want) {
		t.Fatalf("hkdf mismatch\n got %x\nwant %x", got, want)
	}
}

// innerTCPPair builds a real TCP pair. net.Pipe is synchronous and unbuffered,
// so a writer and reader that are not concurrent would deadlock; TCP also
// exercises the real record framing.
func innerTCPPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	type accepted struct {
		conn net.Conn
		err  error
	}
	ch := make(chan accepted, 1)
	go func() {
		conn, err := listener.Accept()
		ch <- accepted{conn, err}
	}()
	client, err := net.DialTimeout("tcp", listener.Addr().String(), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	result := <-ch
	if result.err != nil {
		client.Close()
		t.Fatal(result.err)
	}
	t.Cleanup(func() { client.Close(); result.conn.Close() })
	return client, result.conn
}

func innerPair(t *testing.T, psk string) (*InnerConn, *InnerConn) {
	t.Helper()
	a, b := innerTCPPair(t)
	return innerHandshakePair(t, a, b, psk, nil, nil)
}

func innerHandshakePair(t *testing.T, a, b net.Conn, psk string, clientBinding, serverBinding []byte) (*InnerConn, *InnerConn) {
	t.Helper()
	serverCh := make(chan *InnerConn, 1)
	errCh := make(chan error, 1)
	go func() {
		conn, err := InnerServer(b, psk, serverBinding)
		if err != nil {
			errCh <- err
			return
		}
		serverCh <- conn
	}()
	client, err := InnerClient(a, psk, clientBinding)
	if err != nil {
		t.Fatalf("client handshake: %v", err)
	}
	select {
	case server := <-serverCh:
		return client, server
	case err := <-errCh:
		t.Fatalf("server handshake: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("handshake did not complete")
	}
	return nil, nil
}

// innerTLSPair 在 TCP 上起一对真的 TLS 1.3 连接，返回两端和各自的导出材料。
func innerTLSPair(t *testing.T) (*tls.Conn, *tls.Conn, []byte, []byte) {
	t.Helper()
	a, b := innerTCPPair(t)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "t"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, private.Public(), private)
	if err != nil {
		t.Fatal(err)
	}
	server := tls.Server(b, &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: private}}, MinVersion: tls.VersionTLS13})
	client := tls.Client(a, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	errs := make(chan error, 1)
	go func() { errs <- server.Handshake() }()
	if err := client.Handshake(); err != nil {
		t.Fatal(err)
	}
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	export := func(c *tls.Conn) []byte {
		state := c.ConnectionState()
		out, err := state.ExportKeyingMaterial(TLSExporterLabel, nil, 32)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	return client, server, export(client), export(server)
}

func innerRoundTrip(t *testing.T, client, server *InnerConn, payload []byte) {
	t.Helper()
	writeErr := make(chan error, 1)
	go func() { _, err := client.Write(payload); writeErr <- err }()
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(server, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := <-writeErr; err != nil {
		t.Fatalf("write: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload mismatch length=%d", len(got))
	}
}

func TestInnerHandshakeAndRecordRoundTrip(t *testing.T) {
	client, server := innerPair(t, "tunnel-psk")
	// 两端都在本进程，按本机硬件协商：有 AES 是模式 3，没有是模式 5（比如 GODEBUG=cpu.aes=off）。
	want := innerOffer(HasAESHardware())
	if client.Mode() != want || server.Mode() != want || client.Plain() {
		t.Fatalf("modes client=%d server=%d", client.Mode(), server.Mode())
	}
	for _, payload := range [][]byte{
		[]byte("hello"),
		bytes.Repeat([]byte{0xff}, InnerPayloadLimit),
		bytes.Repeat([]byte("record-boundary"), 30000),
	} {
		innerRoundTrip(t, client, server, payload)
		innerRoundTrip(t, server, client, payload)
	}
	// 空记录也是合法记录。
	go func() { _ = client.WriteRecord(nil) }()
	if err := server.readRecord(); err != nil {
		t.Fatalf("empty record read: %v", err)
	}
	if len(server.plainBuf) != 0 {
		t.Fatalf("empty record produced %d bytes", len(server.plainBuf))
	}
}

func TestInnerWriteBuffersSpanRecords(t *testing.T) {
	client, server := innerPair(t, "psk")
	parts := [][]byte{[]byte("a"), bytes.Repeat([]byte("b"), InnerPayloadLimit-1), bytes.Repeat([]byte("c"), 3*InnerPayloadLimit+5), nil, []byte("tail")}
	var want []byte
	for _, p := range parts {
		want = append(want, p...)
	}
	done := make(chan error, 1)
	go func() { done <- client.WriteBuffers(parts) }()
	got := make([]byte, len(want))
	if _, err := io.ReadFull(server, got); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("WriteBuffers corrupted the byte stream")
	}
	if client.writeCounter != 5 {
		t.Fatalf("records sealed=%d, want 5", client.writeCounter)
	}
}

// 握手只占一个往返：客户端发完自己的证明就返回，不等服务端再回任何东西。
func TestInnerClientDoesNotWaitAfterItsProof(t *testing.T) {
	a, b := innerTCPPair(t)
	go func() {
		first := make([]byte, InnerHandshakeSize)
		if _, err := io.ReadFull(b, first); err != nil {
			return
		}
		material := make([]byte, innerMaterialSize)
		chosen := innerChoose(first[0], true)
		reply := append([]byte{chosen}, material...)
		reply = append(reply, innerAEADProof("psk", 's', chosen, first[0], first[1:], material)...)
		_, _ = b.Write(reply)
		// 之后什么都不发。
	}()
	_ = a.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := InnerClient(a, "psk", nil); err != nil {
		t.Fatalf("client waited for more than the server's first reply: %v", err)
	}
}

func TestInnerRejectsWrongKey(t *testing.T) {
	a, b := innerTCPPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := InnerServer(b, "server-secret", nil)
		done <- err
	}()
	if _, err := InnerClient(a, "client-secret", nil); !errors.Is(err, ErrInnerHandshake) {
		t.Fatalf("wrong PSK accepted by client: %v", err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("wrong PSK accepted by server")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject")
	}
}

func TestInnerRejectsTamperedClientProof(t *testing.T) {
	a, b := innerTCPPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := InnerServer(b, "psk", nil)
		done <- err
	}()
	go func() {
		init := make([]byte, InnerHandshakeSize)
		init[0] = InnerModeAEAD
		if _, err := a.Write(init); err != nil {
			return
		}
		reply := make([]byte, InnerHandshakeSize+innerTagSize)
		if _, err := io.ReadFull(a, reply); err != nil {
			return
		}
		_, _ = a.Write(make([]byte, innerTagSize))
	}()
	select {
	case err := <-done:
		if !errors.Is(err, ErrInnerHandshake) {
			t.Fatalf("tampered proof not rejected: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject tampered handshake")
	}
}

func TestInnerRejectsTamperedServerProof(t *testing.T) {
	a, b := innerTCPPair(t)
	go func() {
		first := make([]byte, InnerHandshakeSize)
		if _, err := io.ReadFull(b, first); err != nil {
			return
		}
		reply := make([]byte, InnerHandshakeSize+innerTagSize)
		reply[0] = InnerModeAEAD
		_, _ = b.Write(reply) // 证明是全零
	}()
	if _, err := InnerClient(a, "psk", nil); !errors.Is(err, ErrInnerHandshake) {
		t.Fatalf("client accepted a forged server proof: %v", err)
	}
}

// 服务端的证明反射回去不能当客户端的证明用：证明里带了角色。
func TestInnerProofIsNotReflectable(t *testing.T) {
	c := bytes.Repeat([]byte{1}, innerMaterialSize)
	s := bytes.Repeat([]byte{2}, innerMaterialSize)
	if bytes.Equal(innerProof("psk", 's', InnerModeAEAD, c, s), innerProof("psk", 'c', InnerModeAEAD, c, s)) {
		t.Fatal("client and server proofs coincide")
	}
	if bytes.Equal(innerProof("psk", 'c', InnerModeAEAD, c, s), innerProof("psk", 'c', InnerModeAEAD, s, c)) {
		t.Fatal("proof is symmetric in the materials")
	}
	if bytes.Equal(innerProof("psk", 't', InnerModeTLS, c, s), innerProof("psk", 't', InnerModeAEAD, c, s)) {
		t.Fatal("proof does not cover the mode byte")
	}
	// 模式 3 / 5 的证明同时覆盖服务端定下的和客户端要的模式字节。
	base := innerAEADProof("psk", 's', InnerModeAEAD, InnerModeAEAD, c, s)
	for _, other := range [][]byte{
		innerAEADProof("psk", 's', InnerModeAEADChaCha, InnerModeAEAD, c, s),
		innerAEADProof("psk", 's', InnerModeAEAD, InnerModeAEADChaCha, c, s),
		innerAEADProof("psk", 's', InnerModeAEADChaCha, InnerModeAEADChaCha, c, s),
	} {
		if bytes.Equal(base, other) {
			t.Fatal("AEAD proof does not cover the cipher negotiation")
		}
	}
}

func TestInnerRejectsUnknownAndLegacyModes(t *testing.T) {
	for _, tc := range []struct {
		mode byte
		want error
	}{{1, ErrInnerHandshake}, {innerModeLegacy, ErrInnerLegacyPeer}, {9, ErrInnerHandshake}} {
		a, b := innerTCPPair(t)
		done := make(chan error, 1)
		go func() {
			_, err := InnerServer(b, "psk", nil)
			done <- err
		}()
		msg := make([]byte, InnerHandshakeSize)
		msg[0] = tc.mode
		go func() { _, _ = a.Write(msg) }()
		select {
		case err := <-done:
			if !errors.Is(err, tc.want) {
				t.Fatalf("mode %d: %v, want %v", tc.mode, err, tc.want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("server did not reject mode %d", tc.mode)
		}
	}
}

func TestInnerTLSModeIsPlainAndBound(t *testing.T) {
	clientTLS, serverTLS, clientBinding, serverBinding := innerTLSPair(t)
	if !bytes.Equal(clientBinding, serverBinding) {
		t.Fatal("exporter differs between the two ends")
	}
	client, server := innerHandshakePair(t, clientTLS, serverTLS, "psk", clientBinding, serverBinding)
	if !client.Plain() || !server.Plain() || client.Mode() != InnerModeTLS {
		t.Fatal("TLS 1.3 binding did not select the plain mode")
	}
	innerRoundTrip(t, client, server, bytes.Repeat([]byte("over tls"), 50000))
	innerRoundTrip(t, server, client, []byte("back"))
	if client.writeCounter != 0 {
		t.Fatal("plain mode sealed inner records")
	}
}

// 模式 4 的证明绑在 TLS 会话上：拿到别的 TLS 连接上用（重放）不通过。
func TestInnerTLSProofDoesNotReplayAcrossSessions(t *testing.T) {
	_, _, firstBinding, _ := innerTLSPair(t)
	clientTLS, serverTLS, _, serverBinding := innerTLSPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := InnerServer(serverTLS, "psk", serverBinding)
		done <- err
	}()
	if _, err := InnerClient(clientTLS, "psk", firstBinding); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrInnerHandshake) {
			t.Fatalf("proof bound to another TLS session accepted: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject")
	}
}

// 服务端外层不是 TLS 1.3（没有绑定材料）时不接受模式 4：不会在没有 TLS 保护的连接上直通。
func TestInnerTLSModeNeedsServerBinding(t *testing.T) {
	a, b := innerTCPPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := InnerServer(b, "psk", nil)
		done <- err
	}()
	if _, err := InnerClient(a, "psk", bytes.Repeat([]byte{3}, 32)); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrInnerHandshake) {
			t.Fatalf("plain mode accepted without TLS: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject")
	}
}

func TestInnerSessionsWithSamePSKDoNotShareKeys(t *testing.T) {
	first, firstPeer := innerPair(t, "psk")
	second, _ := innerPair(t, "psk")
	if first.writeKeyID == second.writeKeyID {
		t.Fatal("two sessions derived the same write key")
	}
	if first.writeKeyID == first.readKeyID {
		t.Fatal("write and read keys are not separated")
	}
	if firstPeer.readKeyID != first.writeKeyID || firstPeer.writeKeyID != first.readKeyID {
		t.Fatal("peer keys do not mirror local keys")
	}
}

func TestInnerRejectsTamperedRecord(t *testing.T) {
	client, server := innerPair(t, "psk")
	client.writeMu.Lock()
	sealed, err := client.appendSealedLocked(nil, [][]byte{[]byte("payload")}, 7)
	client.writeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	sealed[len(sealed)-1] ^= 0x01
	go func() { _, _ = client.conn.Write(sealed) }()
	buf := make([]byte, 32)
	_ = server.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := server.Read(buf); !errors.Is(err, ErrInnerRecord) {
		t.Fatalf("tampered record accepted: %v", err)
	}
}

func TestInnerRejectsOversizedRecord(t *testing.T) {
	client, _ := innerPair(t, "psk")
	if err := client.WriteRecord(make([]byte, InnerPayloadLimit+1)); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversized record accepted: %v", err)
	}
}

func TestInnerConcurrentWritesDoNotInterleave(t *testing.T) {
	client, server := innerPair(t, "psk")
	const writers = 8
	const each = 40000
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			if _, err := client.Write(bytes.Repeat([]byte{byte('A' + w)}, each)); err != nil {
				t.Error(err)
			}
		}(w)
	}
	got := make([]byte, writers*each)
	readDone := make(chan error, 1)
	go func() { _, err := io.ReadFull(server, got); readDone <- err }()
	wg.Wait()
	if err := <-readDone; err != nil {
		t.Fatal(err)
	}
	// 每个写者的字节必须连续地到。
	for i := 0; i < len(got); i += each {
		if !bytes.Equal(got[i:i+each], bytes.Repeat(got[i:i+1], each)) {
			t.Fatalf("write at %d interleaved", i)
		}
	}
}

func TestInnerNonceExhaustionFailsClosed(t *testing.T) {
	client, _ := innerPair(t, "psk")
	client.writeCounter = innerMaxCounter + 1
	if err := client.WriteRecord([]byte("x")); !errors.Is(err, ErrInnerNonce) {
		t.Fatalf("nonce exhaustion not enforced: %v", err)
	}
	// 写失败之后连接作废。
	if _, err := client.Write([]byte("y")); !errors.Is(err, ErrInnerNonce) {
		t.Fatalf("write after failure: %v", err)
	}
}

func TestInnerDeadlinesPropagateToUnderlyingConn(t *testing.T) {
	client, _ := innerPair(t, "psk")
	if err := client.SetReadDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1)
	if _, err := client.Read(buf); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("read deadline not honoured: %v", err)
	}
}

func TestInnerFirstMessageKeepsReferenceShape(t *testing.T) {
	if InnerHandshakeSize != 17 {
		t.Fatalf("handshake size changed: %d", InnerHandshakeSize)
	}
}
