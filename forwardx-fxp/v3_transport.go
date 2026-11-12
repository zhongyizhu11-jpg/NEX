package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	v3 "github.com/zhongyizhu11-jpg/NEX/forwardx-fxp/internal/v3"
)

/*
NEX V3 传输（移植自上游 ForwardX 的 FXP V3，协议和取舍见 internal/v3/PROTOCOL.md）。

V1 是「TCP 上直接跑 FXP 加密帧」；V3 把下一跳的那条 TCP 换成：

	TCP → 外层（HTTP 样式 / WS 样式 / TLS）→ V3 内层认证记录层 → （可选）多路复用 → FXP 逻辑帧

内层握手和记录层替换掉 V1 的 FXP 安全握手（不是套在它外面）：两端交换随机材料、
互证知道隧道密钥，HKDF 派生每个方向各自的长度密钥和数据密钥。业务 hello、目标授权、
限速、配额、流量统计这些都和 V1 一样走逻辑帧，出口的处理代码是同一套。

V3 只换 TCP 那条路。UDP 直连（FXPU 包）照旧，不伪装 —— 上游也没有实现 V3 的 UDP。
任何连接都不会被「自动识别」成 V3：两端都按面板下发的 transportVersion 走，配错就是连不上。
*/

// validateTransportConfig 检查传输版本和 V3 选项：V3 选项只许出现在 v3 上，v3 必须
// 选一个外层，HTTP / WS 的 Host、路径、UA 不能带换行之类会注入请求头的字符。
func validateTransportConfig(cfg config) error {
	switch cfg.TransportVersion {
	case "", "v1", "v2":
		if cfg.V3Transport != "" || cfg.V3Host != "" || cfg.V3Path != "" || cfg.V3UserAgent != "" || cfg.V3ServerName != "" || cfg.V3Multiplex != nil {
			return errors.New("V3 options require transportVersion v3")
		}
		return nil
	case "v3":
	default:
		return fmt.Errorf("unsupported transportVersion %q", cfg.TransportVersion)
	}
	switch cfg.V3Transport {
	case "http", "ws":
		_, err := v3.HTTPRequest(cfg.V3Host, cfg.V3Path, cfg.V3UserAgent, cfg.V3Transport == "ws", "")
		return err
	case "tls":
		if len(cfg.V3ServerName) > 253 || strings.ContainsAny(cfg.V3ServerName, "\x00\r\n\t /\\") {
			return errors.New("invalid V3 TLS server name")
		}
		return nil
	default:
		return fmt.Errorf("V3 requires http, ws, or tls transport, got %q", cfg.V3Transport)
	}
}

// v3TransportIdentity 是 V3 外层选项的指纹，进端点状态的身份（连接池、健康各算各的）。
// V1 / V2 为空，端点身份和以前一样。
func v3TransportIdentity(cfg config) string {
	if !v3Enabled(cfg) {
		return ""
	}
	return strings.Join([]string{"v3", cfg.V3Transport, cfg.V3Host, cfg.V3Path, cfg.V3UserAgent, cfg.V3ServerName, strconv.FormatBool(v3MuxEnabled(cfg)), strconv.FormatBool(cfg.TCPFastOpen)}, "\x00")
}

func v3Enabled(cfg config) bool {
	return cfg.TransportVersion == "v3"
}

// v3MuxEnabled：没写 v3Multiplex 按开（和上游 FXP 一致）。NEX 面板总是显式写。
func v3MuxEnabled(cfg config) bool {
	return v3Enabled(cfg) && (cfg.V3Multiplex == nil || *cfg.V3Multiplex)
}

// wrapV3Client 在拨好的 TCP 上套外层。HTTP / WS 样式只把请求头写出去，回应留到第一次
// 读的时候再收（等回应会和「出口等内层握手才回应」互相卡死）。
func wrapV3Client(conn net.Conn, cfg config) (net.Conn, error) {
	if err := validateTransportConfig(cfg); err != nil {
		return nil, err
	}
	if !v3Enabled(cfg) {
		return conn, nil
	}
	if cfg.V3Transport != "tls" {
		return v3.HTTPClient(conn, cfg.V3Host, cfg.V3Path, cfg.V3UserAgent, cfg.V3Transport == "ws")
	}
	public := v3CertificateKey(cfg.Key).Public().(ed25519.PublicKey)
	wrapped := tls.Client(conn, &tls.Config{
		MinVersion: tls.VersionTLS12,
		// 留空就不发 SNI（像直接连 IP 的客户端）。上游留空时发 forwardx.invalid，
		// 那是个一眼就能认出来的特征；出口不看 SNI，两种写法互通。
		ServerName: cfg.V3ServerName,
		NextProtos: []string{"http/1.1"},
		// 证书是自签的，但不是不验：它的公钥由隧道密钥派生（加了域分隔），这里钉死。
		// 内层还有一次认证握手。
		InsecureSkipVerify: true,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) != 1 {
				return errors.New("v3: unexpected TLS certificate chain")
			}
			peer, ok := state.PeerCertificates[0].PublicKey.(ed25519.PublicKey)
			if !ok || !bytes.Equal(peer, public) {
				return errors.New("v3: TLS tunnel certificate pin mismatch")
			}
			return nil
		},
	})
	if err := wrapped.Handshake(); err != nil {
		return nil, err
	}
	return wrapped, nil
}

func wrapV3Server(conn net.Conn, cfg config) (net.Conn, error) {
	if err := validateTransportConfig(cfg); err != nil {
		return nil, err
	}
	if !v3Enabled(cfg) {
		return conn, nil
	}
	if cfg.V3Transport != "tls" {
		return v3.HTTPServer(conn, cfg.V3Host, cfg.V3Path, cfg.V3Transport == "ws")
	}
	cert, err := v3Certificate(cfg.Key)
	if err != nil {
		return nil, err
	}
	wrapped := tls.Server(conn, &tls.Config{
		MinVersion:   tls.VersionTLS12,
		NextProtos:   []string{"http/1.1"},
		Certificates: []tls.Certificate{cert},
		// 不发会话票据：入口的连接池靠「偷看」底层 TCP 有没有多余字节判断空闲连接还活着，
		// TLS 1.3 握手后的 NewSessionTicket 会被当成对端发来的数据。两端都不复用会话。
		SessionTicketsDisabled: true,
	})
	if err := wrapped.Handshake(); err != nil {
		return nil, err
	}
	return wrapped, nil
}

// v3TLSInnerAEAD 为假时（默认），外层是 TLS 1.3 的 V3 连接内层不再套第二层 AEAD
// （内层模式 4，见 internal/v3/inner.go 和 PROTOCOL.md 的安全论证）。只给测试 / 排障对照用。
var v3TLSInnerAEAD atomic.Bool

// v3TLSBinding 是内层模式 4 的绑定材料：外层是 TLS 1.3 时，这条 TLS 会话的导出密钥
// （RFC 8446 §7.5）。外层不是 TLS、TLS 版本低于 1.3、或者导出失败，都返回 nil —— 内层
// 照旧做自己的 AEAD 记录（模式 3），不会在没有 TLS 1.3 保护的连接上直通。
func v3TLSBinding(conn net.Conn) []byte {
	if v3TLSInnerAEAD.Load() {
		return nil
	}
	wrapped, ok := conn.(*tls.Conn)
	if !ok {
		return nil
	}
	state := wrapped.ConnectionState()
	if !state.HandshakeComplete || state.Version < tls.VersionTLS13 {
		return nil
	}
	binding, err := state.ExportKeyingMaterial(v3.TLSExporterLabel, nil, 32)
	if err != nil {
		return nil
	}
	return binding
}

func v3CertificateKey(key string) ed25519.PrivateKey {
	seed := sha256.Sum256([]byte("forwardx-v3 outer TLS certificate\x00" + key))
	return ed25519.NewKeyFromSeed(seed[:])
}

var v3Certificates = struct {
	sync.Mutex
	items map[[32]byte]tls.Certificate
}{items: make(map[[32]byte]tls.Certificate)}

func v3Certificate(key string) (tls.Certificate, error) {
	cacheKey := sha256.Sum256([]byte(key))
	v3Certificates.Lock()
	defer v3Certificates.Unlock()
	if cert, ok := v3Certificates.items[cacheKey]; ok {
		return cert, nil
	}
	private := v3CertificateKey(key)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject:      pkix.Name{CommonName: "ForwardX V3"},
		NotBefore:    time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2120, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, private.Public(), private)
	if err != nil {
		return tls.Certificate{}, err
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: private}
	// 证书缓存有上限，规则 / 隧道反复改也不会越攒越多。
	if len(v3Certificates.items) >= 64 {
		for entry := range v3Certificates.items {
			delete(v3Certificates.items, entry)
			break
		}
	}
	v3Certificates.items[cacheKey] = cert
	return cert, nil
}
