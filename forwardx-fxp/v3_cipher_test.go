package main

import (
	"crypto/tls"
	"fmt"
	"net"
	"runtime"
	"testing"

	v3 "github.com/zhongyizhu11-jpg/NEX/forwardx-fxp/internal/v3"
)

/*
内层 AEAD 记录的算法跟着两端的 AES 硬件走（模式 3 = AES-128-GCM，5 = ChaCha20-Poly1305）：
真起出口和入口，用 v3.OverrideAESHardware 模拟「没有 AES 硬件」（两端在一个进程里，一起变；
一端有一端没有的组合在 internal/v3 里测），看物理连接协商出的模式，并真跑业务。
TLS 1.3 外层（模式 4）不受影响：内层直通，算法由 TLS 自己选。
*/
func TestV3InnerCipherFollowsAESHardware(t *testing.T) {
	for i, tc := range []struct {
		transport string
		mux       bool
		hasAES    bool
		want      byte
	}{
		{"ws", false, true, v3.InnerModeAEAD},
		{"ws", false, false, v3.InnerModeAEADChaCha},
		{"http", true, false, v3.InnerModeAEADChaCha},
		{"tls", false, false, v3.InnerModeTLS},
		{"tls", true, false, v3.InnerModeTLS},
	} {
		t.Run(fmt.Sprintf("%s/mux=%v/aes=%v", tc.transport, tc.mux, tc.hasAES), func(t *testing.T) {
			t.Cleanup(v3.OverrideAESHardware(tc.hasAES))
			resetFXPEndpointRegistry()
			route := startV3Route(t, v3TestConfig(tc.transport, tc.mux), 3600+i, 36000+i, "cipher-key", "cipher-key")
			raw, inner, err := dialV3Inner("127.0.0.1", route.exitPort, route.cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			if inner.Mode() != tc.want {
				t.Fatalf("mode %d (%s), want %d", inner.Mode(), inner.Cipher(), tc.want)
			}
			if err := v3EchoThrough(t, route.entryPort, make([]byte, 1<<20)); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// 模式 4 不用内层协商：Go 的 crypto/tls（TLS 1.3）自己按两端硬件选套件——客户端没有 AES 硬件时
// 把 ChaCha20 排第一，服务端在「自己没有 AES 硬件，或者客户端第一个要的不是 AES-GCM」时选
// ChaCha20（Go 1.24 handshake_client.go / handshake_server_tls13.go）。这里用 V3 真实的 TLS 外层
// 核对：本机按硬件（x/sys/cpu，和标准库读同一个 GODEBUG）判断有 AES 就该是 AES-128-GCM，没有就该是
// ChaCha20。在有 AES 的机器上用 GODEBUG=cpu.aes=off 跑这个测试就是「两端都没有」的情况。
func TestV3TLSOuterPicksCipherByHardware(t *testing.T) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("只在 amd64 / arm64 上核对（其它架构上本包和标准库对「有没有 AES 硬件」的判断可能不同）")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg := v3TestConfig("tls", false)
	cfg.Key = "tls-cipher-key"
	serverErr := make(chan error, 1)
	go func() {
		raw, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer raw.Close()
		_, err = wrapV3Server(raw, cfg)
		serverErr <- err
	}()
	raw, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	wrapped, err := wrapV3Client(raw, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
	state := wrapped.(*tls.Conn).ConnectionState()
	want := uint16(tls.TLS_AES_128_GCM_SHA256)
	if !v3.HasAESHardware() {
		want = tls.TLS_CHACHA20_POLY1305_SHA256
	}
	t.Logf("TLS %x suite %s (AES hardware %v)", state.Version, tls.CipherSuiteName(state.CipherSuite), v3.HasAESHardware())
	if state.Version != tls.VersionTLS13 || state.CipherSuite != want {
		t.Fatalf("TLS suite %s, want %s", tls.CipherSuiteName(state.CipherSuite), tls.CipherSuiteName(want))
	}
}
