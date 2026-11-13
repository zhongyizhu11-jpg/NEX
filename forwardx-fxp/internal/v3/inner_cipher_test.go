package v3

import (
	"bytes"
	"crypto/hmac"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"
	"time"
)

/*
模式 3 / 5 的算法协商：两端各自有没有 AES 硬件 → AES-128-GCM 还是 ChaCha20-Poly1305；
协商字节被篡改时握手失败。两端的「有没有 AES 硬件」直接传给 innerClientHandshake /
innerServerHandshake，同一个进程里可以一端有、一端没有。
*/

// innerPairWithAES 用指定的「两端有没有 AES 硬件」做一次模式 3 / 5 握手。
func innerPairWithAES(t *testing.T, a, b net.Conn, psk string, clientAES, serverAES bool) (*InnerConn, *InnerConn) {
	t.Helper()
	type result struct {
		conn *InnerConn
		err  error
	}
	serverCh := make(chan result, 1)
	go func() {
		conn, err := innerServerHandshake(b, psk, nil, serverAES)
		serverCh <- result{conn, err}
	}()
	client, err := innerClientHandshake(a, psk, nil, clientAES)
	if err != nil {
		t.Fatalf("client handshake: %v", err)
	}
	select {
	case r := <-serverCh:
		if r.err != nil {
			t.Fatalf("server handshake: %v", r.err)
		}
		return client, r.conn
	case <-time.After(5 * time.Second):
		t.Fatal("handshake did not complete")
	}
	return nil, nil
}

func TestInnerCipherNegotiation(t *testing.T) {
	for _, tc := range []struct {
		clientAES, serverAES bool
		want                 byte
	}{
		{true, true, InnerModeAEAD},
		{true, false, InnerModeAEADChaCha},
		{false, true, InnerModeAEADChaCha},
		{false, false, InnerModeAEADChaCha},
	} {
		t.Run(fmt.Sprintf("clientAES=%v/serverAES=%v", tc.clientAES, tc.serverAES), func(t *testing.T) {
			a, b := innerTCPPair(t)
			client, server := innerPairWithAES(t, a, b, "psk", tc.clientAES, tc.serverAES)
			if client.Mode() != tc.want || server.Mode() != tc.want {
				t.Fatalf("modes client=%d server=%d, want %d", client.Mode(), server.Mode(), tc.want)
			}
			if client.Plain() || client.Cipher() != innerCipherName(tc.want) {
				t.Fatalf("cipher %q plain=%v", client.Cipher(), client.Plain())
			}
			// 两个方向、跨记录的大块都要通。
			payload := bytes.Repeat([]byte("negotiated"), 20000)
			innerRoundTrip(t, client, server, payload)
			innerRoundTrip(t, server, client, payload)
			if server.readKeyID != client.writeKeyID || server.writeKeyID != client.readKeyID {
				t.Fatal("peer keys do not mirror local keys")
			}
		})
	}
}

// ChaCha20-Poly1305 记录被改一个字节也拒绝（AES-GCM 的情况见 TestInnerRejectsTamperedRecord）。
func TestInnerChaChaRejectsTamperedRecord(t *testing.T) {
	a, b := innerTCPPair(t)
	client, server := innerPairWithAES(t, a, b, "psk", false, false)
	client.writeMu.Lock()
	sealed, err := client.appendSealedLocked(nil, [][]byte{[]byte("payload")}, 7)
	client.writeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	sealed[len(sealed)-1] ^= 0x01
	go func() { _, _ = client.conn.Write(sealed) }()
	_ = server.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := server.Read(make([]byte, 32)); !errors.Is(err, ErrInnerRecord) {
		t.Fatalf("tampered ChaCha20 record accepted: %v", err)
	}
}

// 两种算法从同一组材料派生的密钥不同（HKDF info 不同），长度也各自对。
func TestInnerCipherKeysAreSeparated(t *testing.T) {
	salt := bytes.Repeat([]byte{7}, 2*innerMaterialSize)
	_, aesData, _, _ := deriveInnerKeys("psk", salt, InnerModeAEAD)
	_, chachaData, _, _ := deriveInnerKeys("psk", salt, InnerModeAEADChaCha)
	if len(aesData) != 16 || len(chachaData) != 32 {
		t.Fatalf("key sizes aes=%d chacha=%d", len(aesData), len(chachaData))
	}
	if bytes.HasPrefix(chachaData, aesData) {
		t.Fatal("ChaCha20 key shares bytes with the AES key")
	}
}

// innerTamperRelay 在 client 和 server 之间转发，转发前可以改客户端的第一条消息（17 字节）
// 和服务端的回应（33 字节），之后原样转发。
func innerTamperRelay(t *testing.T, clientSide, serverSide net.Conn, first, reply func([]byte)) {
	t.Helper()
	go func() {
		msg := make([]byte, InnerHandshakeSize)
		if _, err := io.ReadFull(clientSide, msg); err != nil {
			return
		}
		first(msg)
		if _, err := serverSide.Write(msg); err != nil {
			return
		}
		go func() { _, _ = io.Copy(serverSide, clientSide); _ = serverSide.Close() }()
		back := make([]byte, InnerHandshakeSize+innerTagSize)
		if _, err := io.ReadFull(serverSide, back); err != nil {
			_ = clientSide.Close()
			return
		}
		reply(back)
		if _, err := clientSide.Write(back); err != nil {
			return
		}
		_, _ = io.Copy(clientSide, serverSide)
		_ = clientSide.Close()
	}()
}

// 中间人改协商字节（想把两端压到某一种算法上）：证明对不上，客户端拒绝，服务端也拿不到
// 合法的客户端证明。
func TestInnerRejectsTamperedCipherNegotiation(t *testing.T) {
	keep := func([]byte) {}
	set := func(v byte) func([]byte) { return func(b []byte) { b[0] = v } }
	for _, tc := range []struct {
		name                 string
		clientAES, serverAES bool
		first, reply         func([]byte)
	}{
		// 两端都有 AES，中间人谎称客户端没有 → 服务端选 ChaCha20。
		{"offer AES->ChaCha", true, true, set(InnerModeAEADChaCha), keep},
		// 客户端没有 AES，中间人谎称它有 → 服务端选 AES-GCM（客户端会很慢）。
		{"offer ChaCha->AES", false, true, set(InnerModeAEAD), keep},
		// 两端都有 AES，中间人把服务端的决定改成 ChaCha20。
		{"reply AES->ChaCha", true, true, keep, set(InnerModeAEADChaCha)},
		// 服务端没有 AES、选了 ChaCha20，中间人改成 AES-GCM。
		{"reply ChaCha->AES", true, false, keep, set(InnerModeAEAD)},
		// 两头一起改：客户端要 AES 被改成 ChaCha20，服务端回 ChaCha20 再被改回 AES。
		{"both rewritten", true, true, set(InnerModeAEADChaCha), set(InnerModeAEAD)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clientConn, relayClient := innerTCPPair(t)
			relayServer, serverConn := innerTCPPair(t)
			innerTamperRelay(t, relayClient, relayServer, tc.first, tc.reply)
			serverErr := make(chan error, 1)
			go func() {
				_, err := innerServerHandshake(serverConn, "psk", nil, tc.serverAES)
				serverErr <- err
			}()
			_ = clientConn.SetDeadline(time.Now().Add(5 * time.Second))
			_, err := innerClientHandshake(clientConn, "psk", nil, tc.clientAES)
			if !errors.Is(err, ErrInnerHandshake) {
				t.Fatalf("client accepted a tampered negotiation: %v", err)
			}
			_ = clientConn.Close()
			select {
			case err := <-serverErr:
				if err == nil {
					t.Fatal("server accepted a tampered negotiation")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("server did not give up")
			}
		})
	}
}

// 服务端自己也核对 offered：一个「相信了被改过的回应」的客户端（这里手写）按它以为的 offered
// 算证明，服务端拒绝。
func TestInnerServerChecksOfferedByteInClientProof(t *testing.T) {
	a, b := innerTCPPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := innerServerHandshake(b, "psk", nil, true)
		done <- err
	}()
	material := bytes.Repeat([]byte{9}, innerMaterialSize)
	// 线上实际到达服务端的是 5（被中间人从 3 改成了 5）。
	if _, err := a.Write(append([]byte{InnerModeAEADChaCha}, material...)); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, InnerHandshakeSize+innerTagSize)
	if _, err := io.ReadFull(a, reply); err != nil {
		t.Fatal(err)
	}
	if reply[0] != InnerModeAEADChaCha {
		t.Fatalf("server chose %d for a ChaCha20 offer", reply[0])
	}
	if !hmac.Equal(reply[InnerHandshakeSize:], innerAEADProof("psk", 's', reply[0], InnerModeAEADChaCha, material, reply[1:InnerHandshakeSize])) {
		t.Fatal("server proof does not cover the offer it received")
	}
	// 客户端以为自己发的是 3。
	if _, err := a.Write(innerAEADProof("psk", 'c', reply[0], InnerModeAEAD, material, reply[1:InnerHandshakeSize])); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrInnerHandshake) {
			t.Fatalf("server accepted a proof over another offer: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject")
	}
}

// 客户端要了 ChaCha20，服务端（不守规矩或被冒充）回 AES-GCM：不用验证明就拒绝。
func TestInnerClientRejectsAESAfterChaChaOffer(t *testing.T) {
	a, b := innerTCPPair(t)
	go func() {
		first := make([]byte, InnerHandshakeSize)
		if _, err := io.ReadFull(b, first); err != nil {
			return
		}
		material := make([]byte, innerMaterialSize)
		reply := append([]byte{InnerModeAEAD}, material...)
		// 证明本身是对的（服务端知道 PSK），但这个组合不合规矩。
		reply = append(reply, innerAEADProof("psk", 's', InnerModeAEAD, first[0], first[1:], material)...)
		_, _ = b.Write(reply)
	}()
	_ = a.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := innerClientHandshake(a, "psk", nil, false); !errors.Is(err, ErrInnerHandshake) {
		t.Fatalf("client accepted AES-GCM after offering ChaCha20: %v", err)
	}
}

// 公开入口 InnerClient / InnerServer 看的是 HasAESHardware()（测试钩子能改它）。
func TestInnerOverrideAESHardware(t *testing.T) {
	native := HasAESHardware()
	t.Logf("native AES-GCM hardware: %v", native)
	restore := OverrideAESHardware(false)
	if HasAESHardware() {
		restore()
		t.Fatal("override to false ignored")
	}
	client, server := innerPair(t, "psk")
	restore()
	if HasAESHardware() != native {
		t.Fatal("restore did not restore")
	}
	if client.Mode() != InnerModeAEADChaCha || server.Mode() != InnerModeAEADChaCha {
		t.Fatalf("modes client=%d server=%d without AES hardware", client.Mode(), server.Mode())
	}
	innerRoundTrip(t, client, server, bytes.Repeat([]byte{1}, 3*InnerPayloadLimit+1))

	defer OverrideAESHardware(true)()
	client, server = innerPair(t, "psk")
	if client.Mode() != InnerModeAEAD || server.Mode() != InnerModeAEAD {
		t.Fatalf("modes client=%d server=%d with AES hardware", client.Mode(), server.Mode())
	}
}

// BenchmarkInnerAEAD 只测算法本身：单个协程把一条满 16 KiB 的记录封好再解开（长度和内容两次
// 密封，和记录层一样），cpu-ms/GB 是「封 + 解」一 GB 明文的单核 CPU（不含系统调用）。
//
//	go test -run '^$' -bench BenchmarkInnerAEAD -count 3 ./internal/v3/
//	GODEBUG=cpu.aes=off go test ...   # 模拟没有 AES 硬件：AES-GCM 退回纯 Go 实现
func BenchmarkInnerAEAD(b *testing.B) {
	for _, mode := range []byte{InnerModeAEAD, InnerModeAEADChaCha} {
		b.Run(innerCipherName(mode), func(b *testing.B) {
			lenKey, dataKey, _, _ := deriveInnerKeys("psk", make([]byte, 32), mode)
			lenAEAD, err := newInnerAEAD(mode, lenKey)
			if err != nil {
				b.Fatal(err)
			}
			dataAEAD, err := newInnerAEAD(mode, dataKey)
			if err != nil {
				b.Fatal(err)
			}
			plain := make([]byte, InnerPayloadLimit)
			sealed := make([]byte, 0, InnerPayloadLimit+innerOverhead)
			opened := make([]byte, 0, InnerPayloadLimit)
			var nonce [innerNonceSize]byte
			lenPlain := []byte{0x40, 0x00}
			b.SetBytes(InnerPayloadLimit)
			b.ResetTimer()
			start := time.Now()
			for i := 0; i < b.N; i++ {
				innerNonce(nonce[:], innerDirClientToServer, uint64(i), innerKindLength)
				head := lenAEAD.Seal(sealed[:0], nonce[:], lenPlain, nil)
				if _, err := lenAEAD.Open(opened[:0], nonce[:], head, nil); err != nil {
					b.Fatal(err)
				}
				innerNonce(nonce[:], innerDirClientToServer, uint64(i), innerKindData)
				body := dataAEAD.Seal(sealed[:0], nonce[:], plain, nil)
				if _, err := dataAEAD.Open(opened[:0], nonce[:], body, nil); err != nil {
					b.Fatal(err)
				}
			}
			elapsed := time.Since(start)
			b.ReportMetric(float64(elapsed.Milliseconds())/(float64(b.N)*InnerPayloadLimit/1e9), "cpu-ms/GB")
		})
	}
}

// BenchmarkInnerRecords 测整条记录层（一端封、一端解，走本机 TCP），确认两种算法都走得通、
// 量级和 BenchmarkInnerAEAD 一致。
//
//	go test -run '^$' -bench BenchmarkInnerRecords -benchtime 2000x ./internal/v3/
func BenchmarkInnerRecords(b *testing.B) {
	for _, tc := range []struct {
		name string
		aes  bool
	}{{"aes-128-gcm", true}, {"chacha20-poly1305", false}} {
		b.Run(tc.name, func(b *testing.B) {
			a, s := innerBenchTCPPair(b)
			type result struct {
				conn *InnerConn
				err  error
			}
			ch := make(chan result, 1)
			go func() {
				conn, err := innerServerHandshake(s, "psk", nil, tc.aes)
				ch <- result{conn, err}
			}()
			client, err := innerClientHandshake(a, "psk", nil, tc.aes)
			if err != nil {
				b.Fatal(err)
			}
			r := <-ch
			if r.err != nil {
				b.Fatal(r.err)
			}
			server := r.conn
			if client.Cipher() != tc.name {
				b.Fatalf("negotiated %s", client.Cipher())
			}
			const chunk = 256 << 10
			payload := make([]byte, chunk)
			done := make(chan error, 1)
			go func() {
				buf := make([]byte, 64<<10)
				total := int64(b.N) * chunk
				for total > 0 {
					n, err := server.Read(buf)
					total -= int64(n)
					if err != nil {
						done <- err
						return
					}
				}
				done <- nil
			}()
			b.SetBytes(chunk)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := client.Write(payload); err != nil {
					b.Fatal(err)
				}
			}
			if err := <-done; err != nil {
				b.Fatal(err)
			}
		})
	}
}

func innerBenchTCPPair(b *testing.B) (net.Conn, net.Conn) {
	b.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	defer listener.Close()
	ch := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.Accept()
		ch <- conn
	}()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		b.Fatal(err)
	}
	server := <-ch
	if server == nil {
		b.Fatal("accept failed")
	}
	b.Cleanup(func() { client.Close(); server.Close() })
	return client, server
}
